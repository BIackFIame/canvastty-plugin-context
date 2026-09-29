// Convention imports and the rules store (ported from CanvasTTY #68 tests/context-imports and context-profiles).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RulesStore } from '../src/service/store.ts';
import { discover, importProject } from '../src/service/importer.ts';

async function fixture(t, files = { 'AGENTS.md': 'Follow LIVE_FIRST conventions.' }, imports = [{ path: 'AGENTS.md', kind: 'instructions' }]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-import-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); }
  const store = new RulesStore(join(root, 'data'));
  let state = await store.saveProject({ label: 'Project', root: cwd }, 0);
  state = await store.saveImports(state.projects[0].id, imports, state.revision);
  const read = () => { const s = store.get(); return importProject(s.projects[0], s.projects); };
  const text = () => read().rules.map(r => typeof r.value === 'string' ? r.value : JSON.stringify(r.value)).join('\n');
  return { root, cwd, store, project: state.projects[0], read, text };
}

test('the store is lazy, private, revisioned, keeps the real folder path and refuses stale writes', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RulesStore(join(root, 'data'));
  assert.equal(store.get().revision, 0);
  assert.throws(() => statSync(join(root, 'data')), /ENOENT/);
  symlinkSync(root, join(root, 'alias'));
  const state = await store.saveProject({ label: 'P', root: join(root, 'alias') }, 0);
  assert.equal(state.projects[0].root, root);
  const saved = await store.saveRule({ scope: 'project', ownerId: state.projects[0].id, category: 'communication', key: 'reply', value: 'Answer in Russian', enabled: true }, state.revision);
  assert.equal(saved.rules[0].source, 'explicit');
  await assert.rejects(store.saveRule({ scope: 'user', category: 'design', key: 'x', value: 'stale', enabled: true }, state.revision), /changed meanwhile/);
  assert.deepEqual(new RulesStore(join(root, 'data')).get(), saved);
  assert.equal(statSync(join(root, 'data', 'rules', 'rules.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'rules', 'rules.json'), 'utf8')).rules.length, 1);
  await assert.rejects(store.saveRule({ scope: 'user', category: 'design', key: 'validate.colors', value: { kind: 'forbidden-colors', colors: ['red'] }, enabled: true }, saved.revision), /validate/);
  await assert.rejects(store.saveRule({ scope: 'project', ownerId: 'foreign', category: 'design', key: 'k', value: 'v', enabled: true }, saved.revision), /scope owner/);
  await assert.rejects(store.saveRule({ scope: 'current', category: 'design', key: 'k', value: 'v', enabled: true }, saved.revision), /launcher/);
  await assert.rejects(store.saveProject({ label: 'Twice', root }, saved.revision), /already a project/);
  await assert.rejects(store.saveProject({ label: 'Rel', root: 'project' }, saved.revision), /full path/);
});

test('a second store over the same folder (another process) is noticed: the revision is checked in the file, under a lock', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new RulesStore(join(root, 'data'));
  const second = new RulesStore(join(root, 'data'));
  const seen = first.get();
  const saved = await second.saveRule({ scope: 'user', category: 'design', key: 'from.second', value: 'kept', enabled: true }, seen.revision);
  await assert.rejects(first.saveRule({ scope: 'user', category: 'design', key: 'from.first', value: 'stale', enabled: true }, seen.revision), /changed meanwhile/);
  assert.deepEqual(new RulesStore(join(root, 'data')).get(), saved);
  // A writer holding the lock makes a change wait for it; a lock left behind long ago is taken over.
  writeFileSync(join(root, 'data', 'rules', 'rules.lock'), '');
  const waiting = first.saveRule({ scope: 'user', category: 'design', key: 'after.lock', value: 'v', enabled: true }, saved.revision);
  await new Promise(resolve => setTimeout(resolve, 80));
  unlinkSync(join(root, 'data', 'rules', 'rules.lock'));
  const next = await waiting;
  writeFileSync(join(root, 'data', 'rules', 'rules.lock'), '');
  utimesSync(join(root, 'data', 'rules', 'rules.lock'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal((await first.saveRule({ scope: 'user', category: 'design', key: 'stale.lock', value: 'v', enabled: true }, next.revision)).rules.length, 3);
  assert.throws(() => statSync(join(root, 'data', 'rules', 'rules.lock')), /ENOENT/);
});

test('the rules file is read only as a private regular file, never through a link', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RulesStore(join(root, 'data'));
  await store.saveRule({ scope: 'user', category: 'design', key: 'k', value: 'v', enabled: true }, 0);
  const file = join(root, 'data', 'rules', 'rules.json');
  renameSync(file, join(root, 'elsewhere.json'));
  symlinkSync(join(root, 'elsewhere.json'), file);
  assert.throws(() => new RulesStore(join(root, 'data')).get(), /not a private file/);
});

test('a rule key is one line: a saved key cannot start a line of its own in the delivered text', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RulesStore(join(root, 'data'));
  await assert.rejects(store.saveRule({ scope: 'user', category: 'design', key: 'a\n- [security] b', value: 'v', enabled: true }, 0), /rule key/);
});

test('concurrent writes with one revision: one wins; removing a project removes its tasks and their rules', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new RulesStore(join(root, 'data'));
  const outcomes = await Promise.allSettled([store.saveProject({ label: 'One', root }, 0), store.saveProject({ label: 'Two', root }, 0)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  let state = store.get();
  const project = state.projects[0];
  state = await store.saveTask({ projectId: project.id, label: 'Release' }, state.revision);
  state = await store.saveRule({ scope: 'task', ownerId: state.tasks[0].id, category: 'testing', key: 'test', value: 'Run unit tests', enabled: true }, state.revision);
  state = await store.saveRule({ scope: 'user', category: 'communication', key: 'lang', value: 'Russian', enabled: true }, state.revision);
  state = await store.remove('project', project.id, state.revision);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.rules.map(r => r.key), ['lang']);
});

test('imports are read live; a missing file adds nothing and says so', async t => {
  const f = await fixture(t);
  assert.match(f.text(), /LIVE_FIRST/);
  assert.equal(f.read().rules[0].provenance.sourceLine, 1);
  assert.equal(f.store.get().rules.length, 0);
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'LIVE_SECOND');
  assert.match(f.text(), /LIVE_SECOND/);
  rmSync(join(f.cwd, 'AGENTS.md'));
  assert.equal(f.text(), '');
  assert.equal(f.read().diagnostics[0].status, 'missing');
});

test('configs: JSON imported per setting, JavaScript never run, YAML listed but not parsed', async t => {
  const f = await fixture(t, { 'eslint.config.js': 'globalThis.__ctxRan = true;', '.prettierrc.json': '{\n  "semi": false,\n  "printWidth": 88\n}', '.prettierrc.yaml': 'semi: false\n' },
    [{ path: 'eslint.config.js', kind: 'config' }, { path: '.prettierrc.json', kind: 'config' }, { path: '.prettierrc.yaml', kind: 'config' }]);
  globalThis.__ctxRan = false;
  const result = f.read();
  assert.equal(globalThis.__ctxRan, false);
  const semi = result.rules.find(r => r.key === 'code-style.prettier.semi');
  assert.equal(semi.value, false);
  assert.equal(semi.provenance.sourceLine, 2);
  assert.equal(result.diagnostics.filter(d => d.status === 'reference').length, 2);
  writeFileSync(join(f.cwd, '.prettierrc.json'), '{"__proto__": {"x": 1}}');
  assert.throws(() => f.read(), /Unsafe/);
});

test('reads stay inside the project: no symlinks, hard links, FIFOs, nested projects or a replaced folder', async t => {
  const f = await fixture(t, { 'настройки/AGENTS.md': 'Unicode convention' }, [{ path: 'настройки/AGENTS.md', kind: 'instructions' }]);
  assert.match(f.text(), /Unicode convention/);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'AGENTS.md'), 'OUTSIDE');
  rmSync(join(f.cwd, 'настройки'), { recursive: true });
  symlinkSync(outside, join(f.cwd, 'настройки'));
  assert.throws(() => f.read(), /could not be read safely/);
  unlinkSync(join(f.cwd, 'настройки'));
  mkdirSync(join(f.cwd, 'настройки'));
  linkSync(join(outside, 'AGENTS.md'), join(f.cwd, 'настройки/AGENTS.md'));
  assert.throws(() => f.read(), /could not be read safely/);
  rmSync(join(f.cwd, 'настройки/AGENTS.md'));
  execFileSync('mkfifo', [join(f.cwd, 'настройки/AGENTS.md')]);
  assert.throws(() => f.read(), /could not be read safely/);
  rmSync(join(f.cwd, 'настройки/AGENTS.md'));
  writeFileSync(join(f.cwd, 'настройки/AGENTS.md'), 'Nested');
  await f.store.saveProject({ root: join(f.cwd, 'настройки'), label: 'Nested' }, f.store.get().revision);
  assert.throws(() => f.read(), /another registered project/);
  for (const path of ['../AGENTS.md', '/AGENTS.md', 'x/../AGENTS.md', 'x\\AGENTS.md', '.git/AGENTS.md', 'notes.txt']) {
    await assert.rejects(f.store.saveImports(f.project.id, [{ path, kind: 'instructions' }], f.store.get().revision));
  }
  const g = await fixture(t);
  renameSync(g.cwd, join(g.root, 'old'));
  mkdirSync(g.cwd);
  writeFileSync(join(g.cwd, 'AGENTS.md'), 'REPLACED');
  assert.throws(() => g.read(), /was replaced/);
});

test('README development sections only (fences respected), CSS tokens per selected theme, Cursor rules only when always applied', async t => {
  const f = await fixture(t, {
    'README.md': '# Product\nUNRELATED\n```md\n## Development\nHIDDEN_FAKE\n```\n## Разработка\nUse tests.\n## Install\nUNRELATED_TOO\n',
    'theme.css': ':root {\n--brand: #123456;\n--button-fg: var(--brand);\n}\n.dark { --brand: #abcdef; }\n@media (x) { :root { --secret: RED; } }\n.widget { --private: nope; }',
    '.cursor/rules/style.mdc': '---\nglobs: "**/*.css"\nalwaysApply: false\n---\nNEVER_GLOBAL'
  }, [{ path: 'README.md', kind: 'readme' }, { path: 'theme.css', kind: 'css', selectors: [':root', '.dark'] }, { path: '.cursor/rules/style.mdc', kind: 'instructions' }]);
  const result = f.read();
  const text = f.text();
  assert.match(text, /Use tests/);
  assert.doesNotMatch(text, /UNRELATED|HIDDEN_FAKE|RED|nope|NEVER_GLOBAL/);
  assert.equal(result.rules.find(r => r.key === 'design.css.--button-fg').value, 'var(--brand)');
  assert.equal(result.rules.find(r => r.key === 'design.css.--button-fg').provenance.sourceLine, 3);
  assert.equal(result.rules.find(r => r.key === 'design.css.theme..dark.--brand').value, '#abcdef');
  assert.equal(result.diagnostics.filter(d => d.status === 'unsupported').length, 2);
  writeFileSync(join(f.cwd, '.cursor/rules/style.mdc'), '---\nalwaysApply: true\ndescription: Global\n---\nNOW_GLOBAL');
  assert.match(f.text(), /NOW_GLOBAL/);
});

test('bounds: 64 KB per file, UTF-8 only, 32 files, 256 KB together', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'я'.repeat(33_000));
  assert.throws(() => f.read(), /could not be read safely/);
  writeFileSync(join(f.cwd, 'AGENTS.md'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => f.read(), /could not be read safely/);
  await assert.rejects(f.store.saveImports(f.project.id, Array.from({ length: 33 }, (_, i) => ({ path: `p${i}/AGENTS.md`, kind: 'instructions' })), f.store.get().revision), /At most 32/);
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}/AGENTS.md`, 'x'.repeat(60_000)]));
  const g = await fixture(t, files, Object.keys(files).map(path => ({ path, kind: 'instructions' })));
  assert.throws(() => g.read(), /256 KB/);
});

test('Find project files lists the known convention files, Cursor rules and top-level CSS, with the current selection', async t => {
  const f = await fixture(t, { 'AGENTS.md': 'a', 'CLAUDE.md': 'b', '.cursorrules': 'c', '.cursor/rules/x.mdc': 'd', 'README.md': 'e', '.editorconfig': 'root = true',
    '.prettierrc': '{}', 'src/styles/theme.css': ':root{}', 'deep/nested/theme.css': ':root{}', 'notes.txt': 'n' });
  const found = discover(f.store.get().projects[0]);
  assert.deepEqual(found.map(c => `${c.path}:${c.kind}:${c.selected}`).sort(), [
    '.cursor/rules/x.mdc:instructions:false', '.cursorrules:instructions:false', '.editorconfig:editorconfig:false', '.prettierrc:config:false',
    'AGENTS.md:instructions:true', 'CLAUDE.md:instructions:false', 'README.md:readme:false', 'src/styles/theme.css:css:false'
  ]);
});
