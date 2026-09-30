// Convention imports (#68, ProjectConventionImporter.ts): the files a person selected are read when rules are needed
// (a launch, a preview, the tool) — no background scan, no cache — and projected into read-only project rules. Reads
// stay inside the registered folder: no symlinks, hard links, other owners or devices, nested registered projects,
// files over 64 KB or 256 KB in total. Executable configs are never run. YAML configs are listed, not parsed (the
// plugin bundles no YAML parser); JSON ones are imported.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  bytes, checkImports, checkRule, checkText, importNameSupported, MAX_RULES,
  type ImportDiagnostic, type ImportKind, type ImportSource, type Project, type Rule, type RuleValue
} from '../shared/rules.ts';

const MAX_FILE_BYTES = 64 * 1024, MAX_TOTAL_BYTES = 256 * 1024;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const within = (root: string, path: string): boolean => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };

/** device:inode:owner of a canonical folder this user owns; a replaced folder gets a new identity. */
export function rootIdentity(path: string): string {
  const s = rootStat(path);
  return `${s.dev}:${s.ino}:${s.uid}`;
}

function rootStat(path: string): Stats {
  const s = lstatSync(path);
  if (!s.isDirectory() || realpathSync(path) !== path || process.getuid && s.uid !== process.getuid()) throw new Error('The project folder must be a real folder you own (not a link).');
  return s;
}

/** The project's folder, checked to be the one registered (not replaced since); its stat for the per-file checks. */
function verifiedRoot(project: Project): Stats {
  const s = rootStat(project.root);
  if (`${s.dev}:${s.ino}:${s.uid}` !== project.rootIdentity) throw new Error(`The folder of ${project.label} was replaced; add the project again.`);
  return s;
}

/** One selected file; `rootStat` comes from verifiedRoot, checked once per import rather than once per file. */
function readSource(project: Project, rootStat: Stats, entry: ImportSource, projects: readonly Project[]): string | undefined {
  const target = join(project.root, entry.path);
  if (projects.some(p => p.id !== project.id && p.root.length > project.root.length && within(project.root, p.root) && within(p.root, target))) throw new Error(`${entry.path} belongs to another registered project inside this one.`);
  try {
    let parent = project.root;
    for (const component of entry.path.split('/').slice(0, -1)) {
      parent = join(parent, component);
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== rootStat.dev || s.uid !== rootStat.uid || realpathSync(parent) !== parent) throw new Error('unsafe folder');
    }
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.dev !== rootStat.dev || before.uid !== rootStat.uid || before.size > MAX_FILE_BYTES) throw new Error('unsafe or too large file');
      // A folder on the way swapped for a link between the checks above and the open: the opened file is then not the
      // one at this path inside the project.
      const now = lstatSync(target);
      if (now.dev !== before.dev || now.ino !== before.ino || realpathSync(target) !== target) throw new Error('changed while opening');
      const data = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < data.length) { const count = readSync(fd, data, length, data.length - length, length); if (!count) break; length += count; }
      const after = fstatSync(fd);
      if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('changed while reading');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length));
      checkText(text, MAX_FILE_BYTES, 'file text', true);
      return text;
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${entry.path} could not be read safely (a plain UTF-8 file of yours up to 64 KB, not a link).`, { cause: error });
  }
}

export interface Imported { rules: Rule[]; diagnostics: ImportDiagnostic[] }

/** The selected files of `project` as read-only project rules, read now. */
export function importProject(project: Project | undefined, projects: readonly Project[], room = MAX_RULES): Imported {
  const rules: Rule[] = [], diagnostics: ImportDiagnostic[] = [];
  if (!project?.imports?.length) return { rules, diagnostics };
  checkImports(project.imports);
  const root = verifiedRoot(project);
  let total = 0;
  for (const entry of project.imports) {
    const text = readSource(project, root, entry, projects);
    const diagnostic = (status: ImportDiagnostic['status'], message: string): void => { diagnostics.push({ sourcePath: entry.path, status, message }); };
    if (text === undefined) { diagnostic('missing', 'The file is gone; it adds no rules.'); continue; }
    total += bytes(text);
    if (total > MAX_TOTAL_BYTES) throw new Error('The selected project files are larger than 256 KB together; select fewer.');
    const add = (key: string, value: RuleValue, sourceLine: number, category: Rule['category']): void => {
      if (rules.length >= room) throw new Error(`The imported files make more than ${MAX_RULES} rules; select fewer.`);
      const rule: Rule = { id: `import-${hash(`${project.id}:${entry.path}:${key}:${rules.length}`).slice(0, 48)}`, scope: 'project', ownerId: project.id, category, key, value,
        enabled: true, source: 'imported', updatedAt: rules.length, provenance: { sourcePath: entry.path, sourceLine } };
      checkRule(rule);
      rules.push(rule);
    };
    if (entry.kind === 'css') {
      const parsed = cssTokens(text, entry.selectors ?? [':root']);
      for (const token of parsed.tokens) add(`design.css.${token.selector === ':root' ? '' : `theme.${token.selector}.`}${token.name}`, token.value, token.line, 'design');
      if (parsed.unsupported) diagnostic('unsupported', 'Only literal custom properties in the selected top-level blocks are imported; nested, @media or computed CSS is not.');
    } else if (entry.kind === 'config') {
      if (/\.(?:[cm]?js|ts)$/u.test(entry.path)) { diagnostic('reference', 'JavaScript and TypeScript configs are never run, so nothing is imported from them.'); continue; }
      let config: unknown;
      try { config = JSON.parse(text); } catch {
        diagnostic('reference', /\.ya?ml$/u.test(entry.path) || !text.trim().startsWith('{') ? 'YAML configs are not imported; only JSON ones are.' : 'The file is not valid JSON.');
        continue;
      }
      if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length > 64) throw new Error(`${entry.path} must be one JSON object of at most 64 settings.`);
      checkRule({ id: 'config-check', scope: 'user', category: 'code-style', key: 'config', value: config, enabled: true, source: 'explicit', updatedAt: 0 });
      const tool = /prettier/u.test(entry.path) ? 'prettier' : 'eslint';
      for (const [key, value] of Object.entries(config)) {
        const at = text.indexOf(JSON.stringify(key));
        add(`code-style.${tool}.${key}`, value as RuleValue, at < 0 ? 1 : text.slice(0, at).split('\n').length, 'code-style');
      }
    } else if (entry.kind === 'editorconfig') {
      let section = '*';
      for (const [index, raw] of text.split('\n').entries()) {
        const line = raw.trim();
        if (!line || /^[#;]/u.test(line)) continue;
        if (/^\[[^\]\x00-\x1f]+\]$/u.test(line)) { section = line.slice(1, -1); continue; }
        const property = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u.exec(line);
        if (!property) { diagnostic('unsupported', `Line ${index + 1} is not a plain "name = value".`); continue; }
        add(`code-style.editorconfig.${hash(section).slice(0, 12)}.${property[1]}`, { section, setting: property[1]!, value: property[2]! }, index + 1, 'code-style');
      }
    } else {
      let lines = text.split('\n').map((value, index) => ({ value, line: index + 1 }));
      if (entry.path.endsWith('.mdc') && lines[0]?.value.trim() === '---') {
        const end = lines.findIndex((l, i) => i > 0 && l.value.trim() === '---');
        const front = end > 0 ? lines.slice(1, end).map(l => l.value).join('\n') : '';
        // A Cursor rule scoped to some files must not become a rule for every task.
        if (!alwaysAppliedCursorFrontmatter(front)) { diagnostic('unsupported', 'Only Cursor rules with alwaysApply: true (and an optional description) are imported; rules scoped by globs are not.'); continue; }
        lines = lines.slice(end + 1);
      }
      if (entry.kind === 'readme') lines = readmeSections(lines);
      const chunks: Array<{ value: string; line: number }> = [];
      for (const line of lines) {
        let part = '', partBytes = 0;
        for (const c of line.value + '\n') {
          const size = bytes(c);
          if (partBytes + size > 1800) { chunks.push({ value: part, line: line.line }); part = ''; partBytes = 0; }
          part += c; partBytes += size;
        }
        if (part) { const last = chunks.at(-1); if (last && bytes(last.value + part) <= 1800) last.value += part; else chunks.push({ value: part, line: line.line }); }
      }
      const name = entry.path.split('/').at(-1)!.replace(/^\.+/u, '').replace(/\.(md|mdc)$/iu, '').toLowerCase().replace(/[^a-z0-9-]+/gu, '-') || 'file';
      let index = 0;
      for (const chunk of chunks) {
        if (chunk.value.trim()) add(`convention.${name}.${hash(entry.path).slice(0, 8)}.${++index}`, chunk.value.trim(), chunk.line, /CONTRIBUTING|README/iu.test(entry.path) ? 'documentation' : 'architecture');
      }
    }
  }
  return { rules, diagnostics };
}

/** README: only development, contributing, testing and code-style sections (and their Russian names). */
function readmeSections(lines: Array<{ value: string; line: number }>): Array<{ value: string; line: number }> {
  let selectedLevel = 0, fence = '';
  return lines.filter(l => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(l.value)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(l.value)) fence = '';
      return !!selectedLevel;
    }
    if (fence) return !!selectedLevel;
    const heading = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(l.value);
    if (heading) {
      if (selectedLevel && heading[1]!.length <= selectedLevel) selectedLevel = 0;
      if (/\b(develop(?:ment|er)?|contribut(?:ing|ion)|testing|code style)\b|разработ|тестирован|стиль кода/iu.test(heading[2]!)) selectedLevel = heading[1]!.length;
    }
    return !!selectedLevel;
  });
}

/** Parse only the two supported literal fields. */
function alwaysAppliedCursorFrontmatter(front: string): boolean {
  const keys = new Set<string>();
  for (const raw of front.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return false;
    const key = line.slice(0, colon);
    if (keys.has(key) || key !== 'alwaysApply' && key !== 'description') return false;
    if (key === 'alwaysApply' && line.slice(colon + 1).trim() !== 'true') return false;
    keys.add(key);
  }
  return keys.has('alwaysApply');
}

/** Deliberately static: top-level selected blocks only; strings and comments do not create declarations. */
function cssTokens(text: string, selectors: string[]): { tokens: Array<{ name: string; value: string; line: number; selector: string }>; unsupported: boolean } {
  const tokens: Array<{ name: string; value: string; line: number; selector: string }> = [];
  let unsupported = false, clean = '', quote = '', comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (comment) { if (c === '*' && text[i + 1] === '/') { clean += '  '; i++; comment = false; } else clean += c === '\n' ? '\n' : ' '; continue; }
    if (quote) { clean += c; if (c === '\\') { clean += text[++i] ?? ''; } else if (c === quote) quote = ''; continue; }
    if (c === '/' && text[i + 1] === '*') { clean += '  '; i++; comment = true; } else { clean += c; if (c === '"' || c === "'") quote = c; }
  }
  if (comment || quote) throw new Error('The CSS file has an unclosed comment or string.');
  let start = 0, bodyStart = 0, depth = 0, selector = '';
  quote = '';
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { if (depth++ === 0) { selector = clean.slice(start, i).trim(); bodyStart = i + 1; } else unsupported = true; } else if (c === '}') {
      if (--depth < 0) throw new Error('The CSS file has an unbalanced brace.');
      if (!depth) {
        const body = clean.slice(bodyStart, i);
        if (selectors.includes(selector) && !/[{}\\]/u.test(body)) {
          let declaration = 0, parentheses = 0;
          quote = '';
          for (let j = 0; j <= body.length; j++) {
            const char = body[j];
            if (quote) { if (char === quote) quote = ''; continue; }
            if (char === '"' || char === "'") { quote = char; continue; }
            if (char === '(') parentheses++;
            if (char === ')') parentheses--;
            if (j === body.length || char === ';' && !parentheses) {
              const part = body.slice(declaration, j), match = /^\s*(--[A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]+?)\s*$/u.exec(part);
              if (match) tokens.push({ name: match[1]!, value: match[2]!, selector, line: clean.slice(0, bodyStart + declaration + part.indexOf(match[1]!)).split('\n').length });
              else if (part.includes('--')) unsupported = true;
              declaration = j + 1;
            }
          }
          if (parentheses || quote) throw new Error('The CSS file has an unbalanced declaration.');
        } else if (selector.startsWith('@') || selectors.includes(selector)) unsupported = true;
        start = i + 1;
      }
    } else if (c === ';' && !depth) start = i + 1;
  }
  if (depth) throw new Error('The CSS file has an unbalanced brace.');
  return { tokens, unsupported };
}

export interface Candidate { path: string; kind: ImportKind; selected: boolean }

const FIXED: Array<{ path: string; kind: ImportKind }> = [
  { path: 'AGENTS.md', kind: 'instructions' }, { path: 'CLAUDE.md', kind: 'instructions' }, { path: 'GEMINI.md', kind: 'instructions' },
  { path: 'CONTRIBUTING.md', kind: 'instructions' }, { path: '.cursorrules', kind: 'instructions' }, { path: '.windsurfrules', kind: 'instructions' },
  { path: '.github/copilot-instructions.md', kind: 'instructions' }, { path: 'README.md', kind: 'readme' }, { path: '.editorconfig', kind: 'editorconfig' },
  { path: '.prettierrc', kind: 'config' }, { path: '.prettierrc.json', kind: 'config' }, { path: '.prettierrc.yaml', kind: 'config' }, { path: '.prettierrc.yml', kind: 'config' },
  { path: '.eslintrc', kind: 'config' }, { path: '.eslintrc.json', kind: 'config' }
];

/**
 * Files in the project this import can read, found when the person asks ("Find project files"): the known convention
 * files, `.cursor/rules/*.mdc`, and `.css` files at the top of the project and of src/, styles/, src/styles/, app/.
 */
export function discover(project: Project): Candidate[] {
  if (rootIdentity(project.root) !== project.rootIdentity) throw new Error(`The folder of ${project.label} was replaced; add the project again.`);
  const selected = new Set((project.imports ?? []).map(entry => entry.path));
  const found: Array<{ path: string; kind: ImportKind }> = [];
  const isFile = (path: string): boolean => { try { const s = lstatSync(join(project.root, path)); return s.isFile() && s.size <= MAX_FILE_BYTES; } catch { return false; } };
  const list = (folder: string): string[] => { try { return readdirSync(join(project.root, folder)).sort().slice(0, 200); } catch { return []; } };
  for (const entry of FIXED) if (isFile(entry.path)) found.push(entry);
  for (const name of list('.cursor/rules')) if (name.endsWith('.mdc') && isFile(`.cursor/rules/${name}`)) found.push({ path: `.cursor/rules/${name}`, kind: 'instructions' });
  for (const folder of ['', 'src', 'styles', 'src/styles', 'app']) {
    for (const name of list(folder).filter(name => name.endsWith('.css')).slice(0, 8)) {
      const path = folder ? `${folder}/${name}` : name;
      if (isFile(path)) found.push({ path, kind: 'css' });
    }
  }
  const candidates = found.filter(entry => importNameSupported(entry.kind, entry.path)).slice(0, 48).map(entry => ({ ...entry, selected: selected.has(entry.path) }));
  // Files already selected but gone stay listed, so the person can unselect them.
  for (const entry of project.imports ?? []) if (!candidates.some(c => c.path === entry.path)) candidates.push({ path: entry.path, kind: entry.kind, selected: true });
  return candidates;
}
