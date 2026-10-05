// The launch contribution per CLI, "Send rules", saved tasks, the launch instruction and the orchestrator tool.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextService } from '../src/service/context.ts';
import { contributionFor } from '../src/service/delivery.ts';

async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-service-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(join(project, 'sub'), { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), 'Run npm test before committing.');
  const service = new ContextService({ dataDir: join(root, 'data') });
  const store = service.store;
  let state = await store.saveProject({ label: 'Site', root: project, organizationId: 'acme' }, 0);
  const projectId = state.projects[0].id;
  state = await store.saveImports(projectId, [{ path: 'AGENTS.md', kind: 'instructions' }], state.revision);
  state = await store.saveTask({ projectId, label: 'Release' }, state.revision);
  const taskId = state.tasks[0].id;
  state = await store.saveRule({ scope: 'project', ownerId: projectId, category: 'communication', key: 'reply.ending', value: 'End every reply with the word MARKER-7.', enabled: true }, state.revision);
  state = await store.saveRule({ scope: 'user', category: 'communication', key: 'reply.language', value: 'Answer in English.', enabled: true }, state.revision);
  state = await store.saveRule({ scope: 'organization', ownerId: 'acme', category: 'security', key: 'secrets', value: 'Never print keys.', enabled: true }, state.revision);
  state = await store.saveRule({ scope: 'task', ownerId: taskId, category: 'communication', key: 'reply.language', value: 'Answer in Russian.', enabled: true }, state.revision);
  const ctx = (options, extra = {}) => ({ sessionId: 's', provider: 'claude', profile: 'normal', role: 'agent', cwd: join(project, 'sub'), restoring: false, resume: false, chosen: true, environment: null, options, ...extra });
  return { root, project, service, projectId, taskId, ctx };
}

test('Claude Code gets the rules as a launch file appended to its system prompt; off, unchosen or empty gives nothing', async t => {
  const { service, ctx, root } = await setup(t);
  const answer = await service.prepare(ctx({ send: true, task: 'none', category: 'all', current: '' }));
  assert.deepEqual(answer.args, ['--append-system-prompt-file', '{launchFiles}/rules.md']);
  assert.equal(answer.files[0].relPath, 'rules.md');
  const text = answer.files[0].content;
  assert.match(text, /MARKER-7/);
  assert.match(text, /Answer in English/);
  assert.match(text, /Run npm test/);
  assert.ok(text.indexOf('Never print keys') < text.indexOf('MARKER-7'), 'security first');
  assert.doesNotMatch(text, /AGENTS\.md/);
  assert.equal(await service.prepare(ctx({ send: false })), null);
  assert.equal(await service.prepare(ctx({}, { chosen: false })), null);
  const otherFolder = await service.prepare(ctx({ send: true }, { cwd: root }));
  assert.equal(otherFolder.files[0].content.includes('MARKER-7'), false, 'another folder: only the user rule');
  assert.equal(await service.prepare(ctx({ send: true }, { provider: 'opencode' })), null, 'unsupported CLI starts without a launch contribution');
});

test('rules reach supported agents on this computer or in a worktree; unsupported CLIs start with an explicit task fallback', async t => {
  const { root, ctx } = await setup(t);
  const badges = [];
  const service = new ContextService({ dataDir: join(root, 'data'), host: { callHost: async (method, params) => { badges.push({ method, ...params }); return null; } } });
  const worktree = await service.prepare(ctx({ send: true }, { environment: { pluginId: 'canvastty-environments', kind: 'worktree' } }));
  assert.equal(worktree.files[0].relPath, 'rules.md');
  assert.equal(badges.length, 0);
  const places = [['ssh-host', 'server'], ['container', 'container'], ['remote-container', 'container']];
  for (const provider of ['claude', 'codex', 'grok', 'qwen', 'pi']) {
    for (const [kind, where] of places) {
      badges.length = 0;
      assert.equal(await service.prepare(ctx({ send: true }, { provider, sessionId: `s-${kind}`, environment: { pluginId: 'canvastty-environments', kind } })), null, `${provider} ${kind}: launched, not refused`);
      assert.equal(badges.length, 1);
      assert.equal(badges[0].method, 'cards.setBadge');
      assert.equal(badges[0].sessionId, `s-${kind}`);
      assert.equal(badges[0].badge.text, 'Rules not delivered');
      assert.ok(badges[0].badge.text.length <= 24 && badges[0].badge.tooltip.length <= 200);
      assert.match(badges[0].badge.tooltip, new RegExp(`^Project rules are not delivered on this ${where}`, 'u'));
    }
  }
  assert.equal(await service.prepare(ctx({ send: true }, { environment: { pluginId: 'other-plugin', kind: 'worktree' } })), null, 'another plugin\'s environment: not known to pass the launch on');
  badges.length = 0;
  assert.equal(await service.prepare(ctx({ send: false }, { environment: { pluginId: 'canvastty-environments', kind: 'ssh-host' } })), null);
  assert.equal(badges.length, 0, 'Send rules off: no note');
});

test('a saved task and the launch instruction win over the project; a task of another project refuses', async t => {
  const { service, ctx, taskId, root, project } = await setup(t);
  const withTask = (await service.prepare(ctx({ send: true, task: taskId, current: 'Keep it short.' }))).files[0].content;
  assert.match(withTask, /Answer in Russian/);
  assert.doesNotMatch(withTask, /Answer in English/);
  assert.ok(withTask.indexOf('Keep it short') < withTask.indexOf('MARKER-7'), 'the launch instruction first');
  mkdirSync(join(root, 'other'));
  let state = await service.store.saveProject({ label: 'Other', root: join(root, 'other') }, service.store.get().revision);
  assert.match((await service.prepare(ctx({ send: true, task: taskId }, { cwd: join(root, 'other') }))).refuse.reason, /another project/);
  assert.match((await service.prepare(ctx({ send: true, task: 'gone' }))).refuse.reason, /no longer exists/);
  const category = (await service.prepare(ctx({ send: true, category: 'design' }))).files[0].content;
  assert.match(category, /Never print keys/, 'security always');
  assert.doesNotMatch(category, /MARKER-7/);
  assert.ok(project);
  assert.ok(state.revision > 0);
});

test('Codex gets developer_instructions (a TOML string ≤ 1024), Grok one --rules line; too long refuses', async t => {
  const { service, ctx } = await setup(t);
  const codex = await service.prepare(ctx({ send: true }, { provider: 'codex' }));
  assert.equal(codex.args[0], '-c');
  assert.match(codex.args[1], /^developer_instructions="CanvasTTY project rules/u);
  assert.ok(codex.args[1].length <= 1024);
  assert.doesNotMatch(codex.args[1], /[\u0000-\u001f\u007f]/u);
  assert.match(JSON.parse(codex.args[1].slice('developer_instructions='.length)), /MARKER-7/);
  const grok = await service.prepare(ctx({ send: true }, { provider: 'grok' }));
  assert.equal(grok.args[0], '--rules');
  assert.doesNotMatch(grok.args[1], /\n/u);
  for (const provider of ['qwen', 'pi']) {
    const answer = await service.prepare(ctx({ send: true }, { provider }));
    assert.deepEqual(answer.args.slice(0, 1), ['--append-system-prompt']);
    assert.ok(answer.args[1].length <= 1024);
    assert.doesNotMatch(answer.args[1], /[\u0000-\u001f\u007f]/u);
    assert.deepEqual(answer.env, {});
    assert.deepEqual(answer.secretEnv, {});
    assert.deepEqual(answer.files, [], 'per-run delivery changes no user or project CLI files');
    assert.match(answer.args[1], /MARKER-7/u);
  }
  assert.deepEqual(contributionFor('qwen', 'Keep the source').args, ['--append-system-prompt', 'Keep the source']);
  assert.deepEqual(contributionFor('pi', 'Keep the source').args, ['--append-system-prompt', 'CanvasTTY Context rules and approved memory: Keep the source']);
  assert.throws(() => contributionFor('codex', 'x'.repeat(1100)), /at most 1024/);
  assert.equal(contributionFor('claude', 'Never bypass review').files[0].content, 'Never bypass review');
  // Long project text is cut to what Codex takes; the omitted count says so.
  const long = await service.store.saveRule({ scope: 'user', category: 'architecture', key: 'long', value: 'z'.repeat(900), enabled: true }, service.store.get().revision);
  assert.ok(long.revision);
  const cut = service.resolve({ cli: 'codex', cwd: ctx({}).cwd });
  assert.ok(cut.omitted >= 1);
  assert.ok(cut.size <= 1024);
});

test('rule text may mention approval words; only an argument CanvasTTY reads as a core setting or flag refuses', () => {
  // Words inside a rule are the rule's own text: CanvasTTY judges an argument's shape (a config key, a flag name).
  for (const text of ["Don't run cleanup dangerously, always confirm first", 'Never bypass review',
    'Keep approval_policy and sandbox_mode as they are', 'Do not edit hooks.json by hand']) {
    assert.deepEqual(contributionFor('codex', text).args, ['-c', `developer_instructions=${JSON.stringify(text)}`]);
    assert.deepEqual(contributionFor('grok', text).args, ['--rules', text]);
  }
  // Grok's --rules value is a separate argument: text shaped like a core setting or a skip-approvals flag is refused.
  assert.throws(() => contributionFor('grok', 'sandbox_mode=danger-full-access'), /sandbox_mode=/);
  assert.throws(() => contributionFor('grok', 'hooks.stop=none'), /hooks\.stop=/);
  assert.throws(() => contributionFor('grok', '--dangerously-skip-permissions'), /flag/);
  assert.throws(() => contributionFor('grok', '- never bypass review'), /flag/);
  assert.throws(() => contributionFor('grok', '--config=approval_policy=never'), /approval_policy=/);
  // A leading dash without those words, or a setting that is not the core's, is fine.
  assert.deepEqual(contributionFor('grok', '- run the tests first').args, ['--rules', '- run the tests first']);
  assert.deepEqual(contributionFor('grok', 'model=fast is our default').args, ['--rules', 'model=fast is our default']);
});

test('the launcher lists saved tasks with their project; rules_for answers for a folder with launchOptions', async t => {
  const { service, project, taskId } = await setup(t);
  assert.deepEqual(service.launchOptions(), { task: [{ value: taskId, label: 'Site · Release' }] });
  const caller = { id: 'o', provider: 'claude', role: 'orchestrator', cwd: join(project, 'sub') };
  const answer = (await service.tool('rules_for', { task: 'release' }, caller)).content;
  assert.equal(answer.project.name, 'Site');
  assert.equal(answer.task, 'Release');
  assert.equal(answer.rules[0].category, 'security');
  assert.ok(answer.rules.some(rule => rule.value === 'Answer in Russian.' && rule.scope === 'task'));
  assert.deepEqual(answer.launchOptions, { 'canvastty-context': { send: true, task: taskId, category: 'all', current: '' } });
  assert.match(answer.text, /MARKER-7/);
  assert.equal((await service.tool('rules_for', { task: 'nope' }, caller)).isError, true);
  assert.equal((await service.tool('rules_for', { folder: 'relative' }, caller)).isError, true);
  assert.equal((await service.tool('rules_for', { provider: 'opencode' }, caller)).isError, true);
  assert.equal((await service.tool('other', {}, caller)).isError, true);
});

test('the page preview shows what each CLI would get, without origins', async t => {
  const { service, projectId } = await setup(t);
  const preview = service.preview({ projectId, provider: 'codex' });
  assert.equal(preview.budget, 1024);
  assert.match(preview.text, /MARKER-7/);
  assert.deepEqual(Object.keys(preview.included[0]).sort(), ['category', 'key', 'scope', 'source']);
  const imported = service.imported(projectId);
  assert.equal(imported.rules[0].provenance.sourcePath, 'AGENTS.md');
});
