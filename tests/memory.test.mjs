import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContextService } from '../src/service/context.ts';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'context-memory-'));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(project); await mkdir(outside);
  t.after(() => rm(base, { recursive: true, force: true }));
  const storage = {};
  const host = {
    callHost: async (method, params) => {
      if (method === 'storage.get') return storage[params.key] ?? null;
      if (method === 'storage.set') { storage[params.key] = structuredClone(params.value); return null; }
      if (method === 'redaction.mask') return { text: params.text.replaceAll('SECRET_EXAMPLE', '[masked]') };
      throw new Error(`unexpected host call ${method}`);
    },
    log() {}, emit() {}
  };
  const service = new ContextService({ host, dataDir: join(base, 'data') });
  await service.loadMemoryPolicy();
  const state = await service.store.saveProject({ label: 'Project', root: project }, 0);
  const projectId = state.projects[0].id;
  const caller = { id: 's1', provider: 'claude', role: 'subagent', cwd: project, workingDirectory: project };
  return { base, project, outside, dataDir: join(base, 'data'), storage, host, service, projectId, caller };
}

test('agent memory is masked, project-scoped, pending by default, recalled after approval, and included at launch', async t => {
  const { project, dataDir, projectId, caller, service } = await fixture(t);
  const remembered = await service.tool('remember', { text: 'The migration uses SECRET_EXAMPLE as a temporary token.' }, caller);
  assert.match(remembered.content, /pending/u);
  const pending = await service.memoryState(projectId);
  assert.equal(pending.requireApproval, true);
  assert.equal(pending.records[0].approved, false);
  assert.match(pending.records[0].text, /\[masked\]/u);
  assert.doesNotMatch(pending.records[0].text, /SECRET_EXAMPLE/u);
  assert.equal((await service.tool('recall', { query: 'migration' }, caller)).content, 'No approved project memory matches that query.');
  await service.approveMemory({ projectId, id: pending.records[0].id });
  const recalled = await service.tool('recall', { query: 'migration' }, caller);
  assert.equal(recalled.content[0].approved, true);
  const answer = await service.prepare({ sessionId: 'new', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
  assert.match(answer.files[0].content, /Approved project memory/u);
  assert.match(answer.files[0].content, /\[masked\]/u);
  assert.doesNotMatch(answer.files[0].content, /SECRET_EXAMPLE/u);
  const memoryFiles = await readdir(join(dataDir, 'memory'));
  assert.equal(memoryFiles.length, 1);
  const storedFile = join(dataDir, 'memory', memoryFiles[0]);
  const file = await readFile(storedFile, 'utf8');
  assert.match(file, /claude agent/u);
  assert.equal((await lstat(storedFile)).mode & 0o077, 0, 'memory file is private');
  await assert.rejects(readFile(join(project, '.canvastty', 'memory.json')), { code: 'ENOENT' }, 'memory is not kept in the agent-writable project');
});

test('human can edit and remove memory; approval can be switched off and only a registered project is writable', async t => {
  const { project, outside, projectId, caller, service } = await fixture(t);
  const first = await service.saveMemory({ projectId, text: 'Keep APIs backwards compatible.' });
  const record = first.records[0];
  assert.equal(record.approved, true);
  assert.equal(record.author, 'person');
  const edited = await service.saveMemory({ projectId, id: record.id, text: 'Keep public APIs backwards compatible.' });
  assert.match(edited.records[0].text, /public APIs/u);
  await service.removeMemory({ projectId, id: record.id });
  assert.equal((await service.memoryState(projectId)).records.length, 0);
  await service.setMemoryPolicy({ requireApproval: false });
  const auto = await service.tool('remember', { text: 'Use Node test runner.' }, caller);
  assert.match(auto.content, /approved/u);
  const outsideResult = await service.tool('remember', { text: 'Must not escape project.' }, { ...caller, cwd: outside, workingDirectory: outside });
  assert.equal(outsideResult.isError, true);
  assert.equal((await service.memoryState(projectId)).records.length, 1);
  assert.equal((await service.tool('recall', {}, caller)).content.length, 1);
});

test('memory summary stays within 4 KiB and Codex launch argument cap', async t => {
  const { project, projectId, service } = await fixture(t);
  for (let index = 0; index < 8; index++) await service.saveMemory({ projectId, text: `Decision ${index}: ${'я'.repeat(700)}` });
  const claude = await service.prepare({ sessionId: 'claude', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
  const claudeText = claude.files[0].content;
  const summary = claudeText.slice(claudeText.indexOf('Approved project memory:'));
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 4_096);
  const answer = await service.prepare({ sessionId: 'codex', provider: 'codex', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
  assert.equal(answer.args[0], '-c');
  assert.ok(answer.args[1].length <= 1_024);
  const instructions = JSON.parse(answer.args[1].slice('developer_instructions='.length));
  assert.match(instructions, /Approved project memory/u);
  assert.ok(instructions.length <= 1_024, 'memory is shortened enough to fit Codex’s argument cap');
  for (const provider of ['qwen', 'pi']) {
    const answer = await service.prepare({ sessionId: provider, provider, profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
    assert.deepEqual(answer.args.slice(0, 1), ['--append-system-prompt']);
    assert.ok(answer.args[1].length <= 1_024);
    assert.match(answer.args[1], /Approved project memory/u);
    if (provider === 'pi') assert.match(answer.args[1], /^CanvasTTY Context rules and approved memory:/u);
  }
});

test('a project .canvastty symlink is not used by the private memory store', async t => {
  const { project, outside, service, projectId } = await fixture(t);
  await symlink(outside, join(project, '.canvastty'));
  await service.saveMemory({ projectId, text: 'Do not escape.' });
  assert.equal(await readFile(join(outside, 'memory.json')).catch(() => null), null);
});

test('legacy project memory is imported as pending and later project-file edits cannot approve it', async t => {
  const { project, projectId, caller, service } = await fixture(t);
  const legacyDirectory = join(project, '.canvastty');
  await mkdir(legacyDirectory);
  const legacy = { version: 1, projectRoot: await realpath(project), records: [
    { id: '00000000-0000-4000-8000-000000000001', text: 'Old approved note.', author: 'untrusted agent', createdAt: 1, approved: true }
  ] };
  await writeFile(join(legacyDirectory, 'memory.json'), JSON.stringify(legacy), { mode: 0o600 });
  const migrated = await service.memoryState(projectId);
  assert.equal(migrated.records[0].approved, false, 'legacy approved flags are never trusted');
  assert.match((await service.tool('recall', {}, caller)).content, /No approved/u);
  await writeFile(join(legacyDirectory, 'memory.json'), JSON.stringify({ ...legacy, records: [{ ...legacy.records[0], id: '00000000-0000-4000-8000-000000000002', approved: true }] }));
  assert.equal((await service.memoryState(projectId)).records[0].id, migrated.records[0].id, 'the untrusted source is read once only');
  const launch = await service.prepare({ sessionId: 'later', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
  assert.equal(launch, null, 'pending-only migrated memory does not produce launch instructions');
  await service.approveMemory({ projectId, id: migrated.records[0].id });
  assert.match((await service.tool('recall', { query: 'old' }, caller)).content[0].text, /Old approved note/u, 'a human approval makes the pending proposal usable');
  const approvedLaunch = await service.prepare({ sessionId: 'approved', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
  assert.match(approvedLaunch.files[0].content, /Old approved note/u, 'the explicitly approved migration is included at launch');
});

test('trusted projectRoot keeps launch and memory tools scoped to the original project from a worktree', async t => {
  const { base, project, projectId, service } = await fixture(t);
  const worktree = join(base, 'worktree');
  await mkdir(worktree);
  await service.saveRule({ revision: service.store.get().revision, rule: {
    scope: 'project', ownerId: projectId, category: 'communication', key: 'reply.language', value: 'English', enabled: true
  } });
  await service.saveMemory({ projectId, text: 'The project uses a stable API.' });
  const launch = await service.prepare({ sessionId: 'worktree-card', provider: 'claude', profile: 'normal', role: 'subagent', cwd: worktree,
    projectRoot: project, restoring: false, resume: false, chosen: true, environment: { pluginId: 'canvastty-environments', kind: 'worktree' }, options: { send: true } });
  assert.match(launch.files[0].content, /stable API/u);
  assert.match(launch.files[0].content, /reply\.language/u);
  const caller = { id: 'worktree-card', provider: 'claude', role: 'subagent', cwd: worktree, workingDirectory: worktree, projectRoot: project };
  assert.match((await service.tool('recall', { query: 'stable' }, caller)).content[0].text, /stable API/u);
  const remembered = await service.tool('remember', { text: 'Keep the public interface compatible.' }, caller);
  assert.match(remembered.content, /pending/u);
  assert.equal((await service.memoryState(projectId)).records.length, 2, 'the worktree proposal is stored with the registered original project');
  await assert.rejects(readFile(join(worktree, '.canvastty', 'memory.json')), { code: 'ENOENT' });
});


test('unsupported CLIs start without launch text and show a rules_for/recall fallback badge', async t => {
  const { project, host } = await fixture(t);
  const badges = [];
  const service = new ContextService({ dataDir: join(project, 'unsupported-data'), host: { ...host, callHost: async (method, params) => { badges.push({ method, ...params }); return null; } } });
  for (const provider of ['opencode', 'omp', 'hermes', 'kimi', 'cursor', 'minimax', 'devin', 'antigravity']) {
    badges.length = 0;
    const answer = await service.prepare({ sessionId: provider, provider, profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
    assert.equal(answer, null, `${provider} receives no unverified launch text`);
    assert.equal(badges.length, 1);
    assert.equal(badges[0].method, 'cards.setBadge');
    assert.equal(badges[0].badge.text, 'Rules not delivered');
    assert.ok(badges[0].badge.text.length <= 24 && badges[0].badge.tooltip.length <= 200);
    assert.match(badges[0].badge.tooltip, /no safe per-run instruction channel is verified/u);
    assert.match(badges[0].badge.tooltip, /rules_for or recall/u);
    assert.doesNotMatch(JSON.stringify(answer), /Approved project memory/u);
  }
});

test('pending project memory stays out of launch summary until a person approves it', async t => {
  const { project, caller, service } = await fixture(t);
  const privatePhrase = 'PENDING_LAUNCH_ONLY_REGRESSION';
  const remembered = await service.tool('remember', { text: privatePhrase }, caller);
  assert.match(remembered.content, /pending/u);
  const launch = await service.prepare({ sessionId: 'pending-memory', provider: 'claude', profile: 'normal', role: 'agent', cwd: project, restoring: false, resume: false, chosen: true, environment: null, options: { send: true } });
  assert.doesNotMatch(JSON.stringify(launch), /PENDING_LAUNCH_ONLY_REGRESSION/u);
});
