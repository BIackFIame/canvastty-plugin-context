// The installable package as CanvasTTY runs it: file integrity, the manifest against CanvasTTY's own validator, the
// bundled service over JSON-RPC lines, and — when CANVASTTY_REPO points at a checkout — CanvasTTY's own supervisor and
// launch pipeline writing the rules file and expanding {launchFiles}.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'canvastty.plugin.json'), 'utf8'));
const base = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-bundle-')));
const project = join(base, 'project');
mkdirSync(project, { recursive: true });
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

test('coreFiles match the package bytes; the service and page are single bundled files', () => {
  for (const file of manifest.coreFiles) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.path}: run npm run build`);
  }
  for (const path of ['services/context.mjs', 'settings/context.js']) assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /^import .* from ["']\.\.?\//mu, `${path} is bundled`);
  assert.equal(manifest.id, 'canvastty-context');
  assert.deepEqual(manifest.permissions, ['storage', 'launch:contribute', 'tools:agents', 'cards:decorate']);
  // rules_for hands orchestrators launchOptions for spawn_agent; they only pick prompt text, so they are delegable.
  assert.equal(manifest.services[0].launch.delegable, true);
});

test('the manifest passes CanvasTTY\'s own validator (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async () => {
  const { validatePluginManifest } = await import(join(process.env.CANVASTTY_REPO, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  assert.deepEqual(checked.services[0].launch.fields.map(field => field.key), ['send', 'task', 'category', 'current']);
  assert.deepEqual(checked.services[0].tools.map(tool => tool.name), ['rules_for', 'remember', 'recall']);
});

function startService(t, dataDir) {
  const child = spawn(process.execPath, [join(root, 'services', 'context.mjs')], { cwd: root, env: { PATH: process.env.PATH, HOME: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const waiting = new Map();
  let nextId = 1;
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method) return;
    const waiter = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  });
  write({ method: 'canvastty.initialize', params: { apiVersion: 2, pluginId: manifest.id, serviceId: 'context', dataDir, locale: 'ru', hostVersion: 'test' } });
  return (method, params) => new Promise((resolve, reject) => {
    const id = `t${nextId++}`;
    waiting.set(id, { resolve, reject });
    write({ id, method, params });
  });
}

test('over JSON-RPC: the page adds a project and a rule, a launch gets it, the tool answers', async t => {
  const request = startService(t, join(base, 'rpc-data'));
  const empty = await request('state');
  assert.equal(empty.state.revision, 0);
  const withProject = await request('saveProject', { project: { label: 'P', root: project }, revision: 0 });
  const projectId = withProject.projects[0].id;
  await request('saveRule', { rule: { scope: 'project', ownerId: projectId, category: 'communication', key: 'reply.ending', value: 'End every reply with the word MARKER-7.', enabled: true }, revision: withProject.revision });
  await assert.rejects(request('saveRule', { rule: { scope: 'user', category: 'design', key: 'k', value: 'v', enabled: true }, revision: withProject.revision }), /changed meanwhile/);
  const launch = await request('canvastty.launch.prepare', { sessionId: 's', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, options: { send: true, task: 'none', category: 'all', current: '' }, chosen: true, environment: null });
  assert.match(launch.files[0].content, /MARKER-7/);
  const off = await request('canvastty.launch.prepare', { sessionId: 's', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, options: { send: false }, chosen: true, environment: null });
  assert.equal(off, null);
  const tool = await request('canvastty.tools.call', { tool: 'rules_for', callerSessionId: 'o', caller: { id: 'o', provider: 'claude', role: 'orchestrator', cwd: project }, input: {} });
  assert.equal(tool.content.rules[0].key, 'reply.ending');
});

test('through CanvasTTY\'s supervisor and launch pipeline: the rules file is written and the argument points at it (CANVASTTY_REPO)', { skip: !process.env.CANVASTTY_REPO }, async (t) => {
  const repo = process.env.CANVASTTY_REPO;
  const { LaunchPipeline } = await import(join(repo, 'src/main/services/LaunchPipeline.ts'));
  const { PluginServiceSupervisor } = await import(join(repo, 'src/main/services/PluginServiceSupervisor.ts'));
  const { validatePluginManifest } = await import(join(repo, 'src/main/services/PluginManager.ts'));
  const checked = validatePluginManifest(manifest);
  const dataDir = join(base, 'core-data');
  // The page's work, done ahead through the same store the service reads.
  const { RulesStore } = await import(join(root, 'src/service/store.ts'));
  const store = new RulesStore(dataDir);
  const state = await store.saveProject({ label: 'P', root: project }, 0);
  await store.saveRule({ scope: 'project', ownerId: state.projects[0].id, category: 'communication', key: 'reply.ending', value: 'End every reply with the word MARKER-7.', enabled: true }, state.revision);
  const supervisor = new PluginServiceSupervisor({ command: process.execPath, hostVersion: '9.9.9', locale: () => 'en', stopGraceMs: 300,
    host: { storageGet: async () => null, storageSet: async () => undefined, emit: () => undefined } });
  t.after(() => supervisor.dispose());
  const entryPath = join(root, 'services', 'context.mjs');
  await supervisor.sync([{ pluginId: checked.id, serviceId: 'context', root, entryPath, sha256: createHash('sha256').update(readFileSync(entryPath)).digest('hex'), dataDir, permissions: checked.permissions }]);
  const pipeline = new LaunchPipeline({
    contributors: () => [{ pluginId: checked.id, pluginName: checked.name, serviceId: 'context', launch: checked.services[0].launch, secrets: false }],
    call: (pluginId, serviceId, method, params, timeoutMs) => supervisor.hostCall(pluginId, serviceId, method, params, timeoutMs),
    secret: async () => null,
    runsRoot: join(base, 'runs')
  });
  const options = pipeline.normalizeOptions('claude', { [checked.id]: { send: true } });
  assert.deepEqual(options, { [checked.id]: { send: true, task: 'none', category: 'all', current: '' } });
  // What rules_for hands an orchestrator passes spawn_agent's delegated check.
  assert.deepEqual(pipeline.normalizeOptions('claude', { [checked.id]: { send: true } }, { delegated: true }), options);
  assert.deepEqual(pipeline.normalizeOptions('codex', { [checked.id]: { send: true, task: 'none', category: 'all', current: '' } }), { [checked.id]: { send: true, task: 'none', category: 'all', current: '' } });
  const prepared = await pipeline.prepare({ sessionId: 'e2e', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, environment: null, options });
  assert.equal(prepared.ok, true, prepared.reason);
  const at = prepared.args.indexOf('--append-system-prompt-file');
  assert.ok(at >= 0);
  assert.match(readFileSync(prepared.args[at + 1], 'utf8'), /MARKER-7/);
  const codex = await pipeline.prepare({ sessionId: 'e2e2', provider: 'codex', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, environment: null, options });
  assert.equal(codex.ok, true, codex.reason);
  assert.ok(codex.args.some(arg => arg.startsWith('developer_instructions=')));
  await prepared.cleanup();
  await codex.cleanup();

  for (const provider of ['qwen', 'pi']) {
    const agentOptions = pipeline.normalizeOptions(provider, { [checked.id]: { send: true } });
    assert.deepEqual(agentOptions, { [checked.id]: { send: true, task: 'none', category: 'all', current: '' } });
    const launch = await pipeline.prepare({ sessionId: `e2e-${provider}`, provider, profile: 'normal', role: 'agent', cwd: project,
      restoring: false, resume: false, environment: null, options: agentOptions });
    assert.equal(launch.ok, true, launch.reason);
    const flag = launch.args.indexOf('--append-system-prompt');
    assert.ok(flag >= 0, `${provider} receives the documented per-run append flag through CanvasTTY's core launch pipeline`);
    assert.ok(launch.args[flag + 1].length <= 1024);
    assert.match(launch.args[flag + 1], /MARKER-7/u);
    assert.deepEqual(launch.env, {}, `${provider} delivery changes no CLI environment or shared configuration`);
    await launch.cleanup();
  }
});
