// Rules, projects and their resolution. Ported from CanvasTTY #68 (src/shared/contextProfiles.ts): scopes, categories,
// bounds and the "resolve winners by key, then filter, then fit the budget" order are the same; data classes, inferred
// (learned) rules and the per-route class ceiling are not ported (see README).

export const CATEGORIES = ['design', 'architecture', 'code-style', 'security', 'testing', 'deployment', 'documentation', 'business-rules', 'naming', 'dependencies', 'communication'] as const;
export type Category = typeof CATEGORIES[number];
/** Least to most specific: a rule at a later scope wins over one with the same key at an earlier scope. */
export const SCOPES = ['defaults', 'user', 'organization', 'project', 'task', 'current'] as const;
export type Scope = typeof SCOPES[number];
export type RuleValue = string | number | boolean | null | RuleValue[] | { [key: string]: RuleValue };
export type RuleSource = 'imported' | 'explicit';

export interface Rule {
  id: string; scope: Scope; ownerId?: string; category: Category; key: string; value: RuleValue;
  enabled: boolean; source: RuleSource; updatedAt: number;
  /** Where an imported rule came from, for the settings page only; never sent to an agent. */
  provenance?: { sourcePath: string; sourceLine: number };
}
export type ImportKind = 'instructions' | 'readme' | 'editorconfig' | 'config' | 'css';
export interface ImportSource { path: string; kind: ImportKind; selectors?: string[] }
export interface Project { id: string; label: string; root: string; rootIdentity: string; organizationId?: string; imports?: ImportSource[] }
export interface Task { id: string; label: string; projectId: string }
export interface RulesState { version: 1; revision: number; projects: Project[]; tasks: Task[]; rules: Rule[] }
export interface ImportDiagnostic { sourcePath: string; status: 'missing' | 'reference' | 'unsupported'; message: string }

export const MAX_RULES = 2000;
export const MAX_IMPORTS = 32;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const sources: RuleSource[] = ['imported', 'explicit'];
export const bytes = (value: string): number => new TextEncoder().encode(value).length;
export const emptyState = (): RulesState => ({ version: 1, revision: 0, projects: [], tasks: [], rules: [] });

export function checkText(value: unknown, limit: number, name: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || !empty && !value.trim() || bytes(value) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw new Error(`Invalid or too long ${name}.`);
}
export function checkId(value: unknown, name = 'id'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) throw new Error(`Invalid ${name}: letters, digits, dot, dash or underscore, up to 64.`);
}

/** File names an import may read, per kind (relative to the project root). */
export function importNameSupported(kind: ImportKind, path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1)!;
  switch (kind) {
    case 'instructions':
      return /^(?:AGENTS|CLAUDE|CONTRIBUTING|GEMINI)\.md$/iu.test(name) || name === '.cursorrules' || name === '.windsurfrules'
        || path === '.github/copilot-instructions.md' || parts.includes('.cursor') && parts.includes('rules') && name.endsWith('.mdc');
    case 'readme': return /^README(?:\.md)?$/iu.test(name);
    case 'editorconfig': return name === '.editorconfig';
    case 'css': return name.endsWith('.css');
    case 'config': return /^(?:\.?prettier(?:rc|\.config)|\.?eslint(?:rc|\.config))(?:\.(?:json|ya?ml|[cm]?js|ts))?$/u.test(name);
  }
}

export function checkImports(imports: unknown): asserts imports is ImportSource[] {
  if (!Array.isArray(imports) || imports.length > MAX_IMPORTS) throw new Error(`At most ${MAX_IMPORTS} project files can be imported.`);
  const paths = new Set<string>();
  for (const entry of imports as ImportSource[]) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['path', 'kind', 'selectors'].includes(key))) throw new Error('Invalid import entry.');
    checkText(entry.path, 1024, 'import path');
    const parts = entry.path.split('/');
    if (paths.has(entry.path) || parts.length > 20 || parts.some(part => !part || part === '.' || part === '..' || part === '.git' || part === 'node_modules' || bytes(part) > 255)
      || /[\\:\x00-\x1f\x7f]/u.test(entry.path) || /[\uD800-\uDFFF]/u.test(entry.path)) throw new Error(`Import path ${entry.path.slice(0, 80)} is not a plain path inside the project.`);
    paths.add(entry.path);
    if (!['instructions', 'readme', 'editorconfig', 'config', 'css'].includes(entry.kind)) throw new Error('Invalid import kind.');
    if (!importNameSupported(entry.kind, entry.path)) throw new Error(`${entry.path.slice(0, 80)} is not a file this import reads.`);
    if (entry.selectors !== undefined && (entry.kind !== 'css' || !Array.isArray(entry.selectors) || !entry.selectors.length || entry.selectors.length > 8
      || entry.selectors.some(s => typeof s !== 'string' || bytes(s) > 120 || !/^(?::root|\.[A-Za-z_][A-Za-z0-9_-]*|\[data-theme=["']?[A-Za-z0-9_-]+["']?\])$/u.test(s)))) throw new Error('Invalid CSS theme selector.');
  }
}

function checkValue(value: unknown, depth = 0): void {
  if (depth > 4) throw new Error('A rule value is nested too deeply.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') { checkText(value, 4096, 'rule text', true); return; }
  if (!value || typeof value !== 'object' || Object.keys(value).length > 64) throw new Error('Invalid rule value.');
  for (const [key, child] of Object.entries(value)) {
    if (dangerous.has(key)) throw new Error('Unsafe key in a rule value.');
    checkText(key, 160, 'value key');
    checkValue(child, depth + 1);
  }
}

export function checkRule(value: unknown): asserts value is Rule {
  const rule = value as Rule;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Invalid rule.');
  checkId(rule.id, 'rule id');
  checkText(rule.key, 160, 'rule key');
  if (dangerous.has(rule.key) || !SCOPES.includes(rule.scope) || !CATEGORIES.includes(rule.category) || !sources.includes(rule.source)
    || typeof rule.enabled !== 'boolean' || !Number.isSafeInteger(rule.updatedAt) || rule.updatedAt < 0) throw new Error('Invalid rule fields.');
  if (rule.scope === 'project' || rule.scope === 'organization' || rule.scope === 'task') checkId(rule.ownerId, `${rule.scope} of the rule`);
  else if (rule.ownerId !== undefined) throw new Error('This scope has no owner.');
  checkValue(rule.value);
  if (rule.provenance !== undefined) {
    const p = rule.provenance;
    if (rule.source !== 'imported' || !p || Object.keys(p).some(k => !['sourcePath', 'sourceLine'].includes(k)) || !Number.isSafeInteger(p.sourceLine) || p.sourceLine < 1) throw new Error('Invalid imported rule origin.');
    checkText(p.sourcePath, 1024, 'import path');
  }
  if (bytes(JSON.stringify(rule)) > 4096) throw new Error('The rule is longer than 4 KB.');
}

export function checkState(value: unknown): asserts value is RulesState {
  const s = value as RulesState;
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.projects) || s.projects.length > 128
    || !Array.isArray(s.tasks) || s.tasks.length > 256 || !Array.isArray(s.rules) || s.rules.length > MAX_RULES) throw new Error('Invalid or too large rules store.');
  const projects = new Set<string>(), organizations = new Set<string>(), tasks = new Set<string>(), rules = new Set<string>();
  for (const p of s.projects) {
    checkId(p.id, 'project id'); checkText(p.label, 160, 'project name'); checkText(p.root, 4096, 'project folder');
    if (typeof p.rootIdentity !== 'string' || !/^\d+:\d+:\d+$/u.test(p.rootIdentity)) throw new Error('Invalid project folder identity.');
    if (p.imports !== undefined) checkImports(p.imports);
    if (projects.has(p.id)) throw new Error('Duplicate project.');
    projects.add(p.id);
    if (p.organizationId !== undefined) { checkId(p.organizationId, 'organization'); organizations.add(p.organizationId); }
  }
  for (const t of s.tasks) {
    checkId(t.id, 'task id'); checkText(t.label, 160, 'task name');
    if (!projects.has(t.projectId) || tasks.has(t.id)) throw new Error('A task needs its project.');
    tasks.add(t.id);
  }
  for (const r of s.rules) {
    checkRule(r);
    if (r.source !== 'explicit' || rules.has(r.id) || r.scope === 'current' || r.scope === 'project' && !projects.has(r.ownerId!)
      || r.scope === 'task' && !tasks.has(r.ownerId!) || r.scope === 'organization' && !organizations.has(r.ownerId!)) throw new Error('A stored rule has an unknown scope owner.');
    rules.add(r.id);
  }
}

export interface Selection {
  projectId?: string; organizationId?: string; taskId?: string;
  /** Only these categories; security and dependencies rules are always considered. */
  categories?: Category[];
  /** Total size of the text, as `measure` counts it (default: UTF-8 bytes). */
  budget?: number;
  measure?: (text: string) => number;
}
export interface Resolved { text: string; included: Rule[]; omitted: number; size: number }

export const HEADING = 'CanvasTTY project rules, set by the person. Follow them; the person\'s current instructions take precedence.\n';
const DEFAULT_BUDGET = 12_288;
/** Each scope's share of a 12 KB text (#68); scaled with the budget. */
const SCOPE_SHARE: Record<Scope, number> = { defaults: 1024, user: 2048, organization: 2048, project: 6144, task: 4096, current: 4096 };
const mandatory = (rule: Rule): boolean => rule.category === 'security' || rule.category === 'dependencies' || rule.scope === 'current';
export const priority = (rule: Rule): number => SCOPES.indexOf(rule.scope) * 10 + sources.indexOf(rule.source);

export function ruleLine(rule: Rule): string {
  const value = typeof rule.value === 'string' ? rule.value.trim() : JSON.stringify(rule.value);
  return `- [${rule.category}] ${rule.key}: ${value.replace(/\r?\n/gu, '\n  ')}\n`;
}

/**
 * The rules that apply, as one text. Winners are chosen per key before the category filter, so a filtered specific rule
 * never lets a less specific one with the same key come back (a disabled rule simply does not take part). Mandatory rules (security, dependencies, the
 * launch's own instruction) that do not fit throw instead of being dropped.
 */
export function resolveRules(rules: readonly Rule[], selection: Selection): Resolved {
  if (rules.length > MAX_RULES + 64) throw new Error('Too many rules to resolve.');
  const winners = new Map<string, Rule>();
  for (const rule of rules) {
    checkRule(rule);
    if (!rule.enabled || rule.scope === 'project' && rule.ownerId !== selection.projectId || rule.scope === 'organization' && rule.ownerId !== selection.organizationId
      || rule.scope === 'task' && rule.ownerId !== selection.taskId) continue;
    const previous = winners.get(rule.key);
    if (!previous || priority(rule) > priority(previous) || priority(rule) === priority(previous)
      && (rule.updatedAt > previous.updatedAt || rule.updatedAt === previous.updatedAt && rule.id.localeCompare(previous.id) > 0)) winners.set(rule.key, rule);
  }
  const visible = [...winners.values()].filter(rule => (!selection.categories?.length || mandatory(rule) || selection.categories.includes(rule.category)));
  // Numbers in keys sort as numbers, so an imported document's chunks (….2 before ….10) keep their file order.
  visible.sort((a, b) => Number(mandatory(b)) - Number(mandatory(a)) || priority(b) - priority(a) || a.key.localeCompare(b.key, 'en', { numeric: true }));
  const budget = selection.budget ?? DEFAULT_BUDGET;
  const measure = selection.measure ?? bytes;
  const scale = budget / DEFAULT_BUDGET;
  const used = new Map<Scope, number>();
  const included: Rule[] = [];
  let text = '', omitted = 0;
  for (const rule of visible) {
    const line = ruleLine(rule), size = bytes(line);
    const candidate = (text || HEADING) + line;
    if (measure(candidate) > budget || !mandatory(rule) && (used.get(rule.scope) ?? 0) + size > SCOPE_SHARE[rule.scope] * scale) {
      if (mandatory(rule)) throw new Error(`The rules do not fit what this agent accepts at launch (security, dependencies and the launch instruction are never left out): ${rule.key.slice(0, 60)}. Shorten them or turn off Send rules.`);
      omitted++;
      continue;
    }
    text = candidate;
    included.push(structuredClone(rule));
    used.set(rule.scope, (used.get(rule.scope) ?? 0) + size);
  }
  return { text, included, omitted, size: text ? measure(text) : 0 };
}
