// Resolution order and budgets (ported from CanvasTTY #68 tests/context-order and context-profiles).
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRules, checkRule } from '../src/shared/rules.ts';
import { conventionProblem, CONVENTION_PRESETS, parseConventionRule } from '../src/shared/presets.ts';

const rule = (id, scope, value, extra = {}) => ({ id, scope, category: 'design', key: 'button.text', value, enabled: true, source: 'explicit', updatedAt: 1, ...extra });

test('scope order: current → task → project → organization → user → defaults; explicit beats imported at one scope', () => {
  const rules = [rule('d', 'defaults', 'default'), rule('u', 'user', 'user'), rule('o', 'organization', 'org', { ownerId: 'org' }),
    rule('p', 'project', 'project', { ownerId: 'p' }), rule('t', 'task', 'task', { ownerId: 't' })];
  const first = (selection) => resolveRules(rules, selection).included[0].value;
  assert.equal(first({}), 'user');
  assert.equal(first({ organizationId: 'org' }), 'org');
  assert.equal(first({ projectId: 'p', organizationId: 'org' }), 'project');
  assert.equal(first({ projectId: 'p', taskId: 't' }), 'task');
  assert.equal(resolveRules([...rules, rule('c', 'current', 'now')], { projectId: 'p', taskId: 't' }).included[0].value, 'now');
  assert.equal(resolveRules([rule('x', 'defaults', 'only default')], {}).included[0].value, 'only default');
  const imported = rule('i', 'project', 'imported', { ownerId: 'p', source: 'imported', updatedAt: 99 });
  assert.equal(resolveRules([imported, rule('e', 'project', 'explicit', { ownerId: 'p' })], { projectId: 'p' }).included[0].value, 'explicit');
  // Another project's rules never apply.
  assert.equal(resolveRules([rule('q', 'project', 'other', { ownerId: 'q' })], { projectId: 'p' }).text, '');
});

test('a disabled override lets the fallback through; a category filter never revives a filtered winner\'s fallback', () => {
  const user = rule('u', 'user', 'beige');
  assert.equal(resolveRules([user, rule('p', 'project', 'black', { ownerId: 'p', enabled: false })], { projectId: 'p' }).included[0].value, 'beige');
  const winner = rule('p', 'project', 'black', { ownerId: 'p', category: 'naming' });
  const filtered = resolveRules([user, winner], { projectId: 'p', categories: ['design'] });
  assert.equal(filtered.text, '');
});

test('imported chunks keep file order (numeric keys); mandatory rules come first', () => {
  const keys = Array.from({ length: 12 }, (_, i) => `convention.agents.abc.${i + 1}`);
  const chunk = (key) => rule(`r-${key}`, 'project', `text of ${key}`, { key, ownerId: 'p', source: 'imported', category: 'architecture' });
  assert.deepEqual(resolveRules([...keys].reverse().map(chunk), { projectId: 'p' }).included.map(r => r.key), keys);
  const result = resolveRules([chunk('convention.agents.abc.10'), chunk('convention.agents.abc.2'), rule('s9', 'user', 'x', { key: 'secrets.9', category: 'security' }), rule('s10', 'user', 'y', { key: 'secrets.10', category: 'security' })], { projectId: 'p' });
  assert.deepEqual(result.included.map(r => r.key), ['secrets.9', 'secrets.10', 'convention.agents.abc.2', 'convention.agents.abc.10']);
});

test('security is kept whatever the category; budgets count UTF-8 and omit whole rules; mandatory overflow throws', () => {
  const rules = [rule('d', 'user', 'я'.repeat(700), { key: 'palette' }), rule('s', 'user', 'Never publish secrets', { category: 'security', key: 'secrets' })];
  const testing = resolveRules(rules, { categories: ['testing'], budget: 1024 });
  assert.match(testing.text, /Never publish/);
  assert.doesNotMatch(testing.text, /palette/);
  const design = resolveRules(rules, { categories: ['design'], budget: 1024 });
  assert.equal(design.omitted, 1);
  assert.ok(Buffer.byteLength(design.text) <= 1024);
  assert.throws(() => resolveRules([rule('s', 'user', 'x'.repeat(900), { category: 'security' })], { budget: 512 }), /never left out/);
  assert.throws(() => resolveRules([rule('c', 'current', 'x'.repeat(900))], { budget: 512 }), /never left out/);
});

test('a string rule is sent as its text, JSON as JSON, with no local origin', () => {
  const imported = rule('i', 'project', 'Line one\nLine two', { ownerId: 'p', source: 'imported', key: 'k', provenance: { sourcePath: 'AGENTS.md', sourceLine: 3 } });
  const text = resolveRules([imported, rule('j', 'user', { foreground: '#000000' }, { key: 'design.components.button' })], { projectId: 'p' }).text;
  assert.match(text, /^CanvasTTY project rules/u);
  assert.match(text, /- \[design\] k: Line one\n {2}Line two\n/u);
  assert.match(text, /design\.components\.button: \{"foreground":"#000000"\}/u);
  assert.doesNotMatch(text, /AGENTS\.md/u);
});

test('rule checks: bounds, dangerous keys, owners; validate.* needs a convention shape and every preset has one', () => {
  assert.throws(() => checkRule(rule('a', 'user', 'я'.repeat(3000))), /4 KB|too long/);
  assert.throws(() => checkRule(rule('a', 'user', { __proto__: 1, ['constructor']: 1 })), /Unsafe/);
  assert.throws(() => checkRule(rule('a', 'project', 'x')), /project of the rule/);
  assert.throws(() => checkRule(rule('a', 'user', 'x', { ownerId: 'p' })), /no owner/);
  assert.throws(() => checkRule(rule('a', 'user', 'bell\u0007')), /Invalid/);
  for (const preset of CONVENTION_PRESETS) assert.ok(parseConventionRule(preset.value), preset.id);
  assert.equal(conventionProblem('validate.colors', { kind: 'forbidden-colors', colors: ['red'] }) !== null, true);
  assert.equal(conventionProblem('design.colors.brand', 'red'), null);
});
