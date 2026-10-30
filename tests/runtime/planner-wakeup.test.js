const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { applySessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
const load = () => require('../../build/storage/chat/planner-wakeup.repository');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wakeup-store-'));
  const store = createChatAppStore({ agentDir: root, sqlitePath: path.join(root, 'test.sqlite') });
  store.saveCustomRoleConfig({ id: 'owner', name: 'Owner', personaPrompt: 'Synthetic', provider: 'synthetic', model: 'synthetic' });
  const room = store.createConversation({ title: 'Wakeup synthetic', participants: ['owner'] });
  const goal = applySessionGoalAction(store, room.id, { action: 'set', goalId: null, goalRevision: 0, status: 'paused', objective: 'Synthetic', owner: { agentId: 'owner' }, acceptanceCriteria: [{ id: 'c', statement: 'Test', verifyBy: 'Assertions' }], ruledBy: { kind: 'planner', plannerId: 'local-planner', plannerName: 'Synthetic' } }).goal;
  const sessions = new EmbeddedPlannerRepository(store);
  const claim = sessions.claim(room.id);
  sessions.release(room.id, claim.leaseId);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = new (load().PlannerWakeupRepository)(store, { now: () => now, redact: text => text.split('credential-sentinel').join('[redacted]') });
  let now = 100000000;
  repository.toggle(room.id, true);
  const append = (kind = 'proposal_pending', extra = {}) => store.plannerAttentionRepository.append({ conversationId: room.id, goalId: goal.goalId, goalRevision: goal.revision, kind, sourceId: randomUUID(), summary: 'Synthetic', createdAt: new Date(now).toISOString(), ...extra });
  return { root, store, room, goal, repository, sessions, append, time: value => { now = value; }, get now() { return now; } };
}
test('verified wakeup argv pins dontAsk, version range and no-space trusted prefix; no positional prompt after variable options', () => {
  const { buildVerifiedPlannerWakeup } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
  const base = { version: '2.1.310', sessionId: randomUUID(), appendPrompt: 'Synthetic', nodePath: process.execPath, adapterPath: path.resolve(__dirname, '../../build/lib/caff.js') };
  const c = buildVerifiedPlannerWakeup(base);
  assert.equal(c.verified, true);
  assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(c.args[c.args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!c.args.includes('--settings'));
  assert.ok(!c.args.some(arg => arg.includes('blockReadsOutsideWorkingDirectories')));
  assert.equal(c.tools, 'Read,Glob,Grep,Bash');
  assert.equal(c.allowedTools, ['state','goal read','attention read*','goal action --json *','owner message --json *','wakeup finish --attempt * --json *'].map(s => `Bash(${c.adapterPrefix} ${s})`).join(','));
  assert.equal(c.disallowedTools, 'Write,Edit,NotebookEdit,MultiEdit,PowerShell,Agent,Task,Skill,WebFetch,WebSearch,ToolSearch,mcp__*');
  assert.equal(c.args[c.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(c.args.includes('--strict-mcp-config'));
  const candidate = require('../../build/server/domain/runtime/embedded-planner-wakeup-command').buildPlannerWakeupCandidate(base);
  assert.deepEqual(c.args, [...candidate.args, '--permission-mode', 'dontAsk']);
  for (const version of ['2.1.309', '2.2.0', '3.1.310', '2.0.999', '2.1.310-beta'])
    assert.throws(() => buildVerifiedPlannerWakeup({ ...base, version }), /planner_wakeup_tools_unverified/);
  assert.equal(buildVerifiedPlannerWakeup({ ...base, version: '2.1.999' }).verified, true);
  assert.throws(() => buildVerifiedPlannerWakeup({ ...base, adapterPath: path.resolve('space here/caff.js') }), /planner_wakeup_tools_unverified/);
  const variable = new Set(['--tools', '--allowedTools', '--disallowedTools', '--mcp-config']);
  for (let i = 0; i < c.args.length; i++)
    if (variable.has(c.args[i])) {
      assert.ok(c.args[i + 1] && !c.args[i + 1].startsWith('--'));
      assert.ok(i + 2 === c.args.length || c.args[i + 2].startsWith('--'));
    }
  assert.equal(c.args.filter(x => x === 'Synthetic').length, 1); // append-system-prompt only, envelope is never argv
});
for (const kind of ['proposal_pending', 'budget_exhausted', 'failure_paused', 'owner_removed', 'turn_failed'])
  test(`only an opted-in matching planner Goal can reserve ${kind}; claims suppress recurrence`, t => {
    const f = fixture(t);
    const row = f.append(kind);
    const a = f.repository.reserve(f.room.id, 'live');
    assert.equal(a.items[0].sequence, row.sequence);
    assert.equal(a.status, 'reserved');
    assert.equal(f.repository.reserve(f.room.id, 'live'), null);
    f.repository.start(a.id);
    f.repository.finish(f.room.id, a.id, [{ sequence: row.sequence, disposition: 'needs_user', reason: 'User needed' }]);
    f.repository.end(a.id, { exitCode: 0, resultSeen: true });
    assert.equal(f.repository.get(f.room.id, a.id).status, 'needs_user');
    assert.equal(f.repository.counts(f.room.id, f.goal.goalId).needsUserCount, 1);
    assert.equal(f.repository.reserve(f.room.id, 'catch_up'), null);
    assert.equal(f.store.listPlannerAttention({ conversationId: f.room.id, status: 'unresolved' }).items.length, 1);
  });
test('opt-out, unbound/DAG/replaced/null Goal, unknown and completed kinds never reserve or consume quota', t => {
  const f = fixture(t);
  f.append('goal_completed');
  f.append('proposal_pending', { goalId: null, goalRevision: 0 });
  assert.equal(f.repository.reserve(f.room.id, 'live'), null);
  const row = f.append();
  const room = f.store.getConversationWithoutMessages(f.room.id), metadata = structuredClone(room.metadata);
  for (const patch of [{ sessionGoalPlannerBinding: null }, { sessionGoalPlannerBinding: { ...metadata.sessionGoalPlannerBinding, goalId: 'old' } }, { dagNodeGoalBinding: { planId: 'p' } }, { sessionGoal: { ...metadata.sessionGoal, status: 'complete' } }]) {
    f.store.db.prepare('UPDATE chat_conversations SET metadata_json=? WHERE id=?').run(JSON.stringify({ ...metadata, ...patch }), f.room.id);
    assert.equal(f.repository.reserve(f.room.id, 'live'), null);
  }
  f.store.db.prepare('UPDATE chat_conversations SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), f.room.id);
  f.repository.toggle(f.room.id, false);
  assert.equal(f.repository.reserve(f.room.id, 'live'), null);
  assert.equal(f.repository.quota(f.room.id).used, 0);
  assert.ok(row.sequence > 0);
});
test('rolling four/hour quota includes boundary and future reservations; all Goals share it and catch-up is deduplicated across restart', t => {
  const f = fixture(t), start = f.now;
  for (let i = 0; i < 4; i++) {
    f.append();
    const a = f.repository.reserve(f.room.id, i ? 'live' : 'catch_up');
    f.repository.start(a.id);
    f.repository.end(a.id, { exitCode: 1, resultSeen: false });
  }
  f.append();
  assert.equal(f.repository.reserve(f.room.id, 'live'), null);
  assert.equal(f.repository.quota(f.room.id).used, 4);
  f.time(start - 1000);
  assert.equal(f.repository.reserve(f.room.id, 'catch_up'), null);
  f.time(start + 3600000);
  assert.equal(f.repository.reserve(f.room.id, 'live'), null);
  f.time(start + 3600001);
  const a = f.repository.reserve(f.room.id, 'catch_up');
  assert.ok(a);
  const reopened = new (load().PlannerWakeupRepository)(f.store, { now: () => f.now });
  reopened.interrupt();
  assert.equal(reopened.get(f.room.id, a.id).status, 'interrupted');
  assert.equal(reopened.reserve(f.room.id, 'catch_up'), null);
});
test('finish independently rejects wrong room/attempt, extra/missing/duplicate memberships and conflicts atomically; handled checks durable resolution', t => {
  const f = fixture(t), x = f.append(), y = f.append();
  const a = f.repository.reserve(f.room.id, 'live');
  f.repository.start(a.id);
  const items = [{ sequence: x.sequence, disposition: 'handled', reason: 'credential-sentinel' }, { sequence: y.sequence, disposition: 'no_action', reason: 'Inspected' }];
  for (const bad of [items.slice(0, 1), [...items, items[0]], [{ ...items[0], sequence: 999 }, items[1]]])
    assert.throws(() => f.repository.finish(f.room.id, a.id, bad));
  assert.throws(() => f.repository.finish('other-room', a.id, items));
  const result = f.repository.finish(f.room.id, a.id, items);
  assert.equal(result.items[0].disposition, 'unresolved');
  assert.equal(result.items[0].reason, '[redacted]');
  assert.deepEqual(f.repository.finish(f.room.id, a.id, items), result);
  assert.throws(() => f.repository.finish(f.room.id, a.id, items.map(i => ({ ...i, reason: 'changed' }))));
});
test('a late confirmed child exit after store close leaves its persisted fence for startup reconciliation',t=>{
  const f=fixture(t),claim=f.sessions.claim(f.room.id);f.store.close();assert.equal(f.sessions.release(f.room.id,claim.leaseId),false);
  const Database=require('better-sqlite3'),db=new Database(path.join(f.root,'test.sqlite'));
  try{assert.equal(db.prepare('SELECT lease_id FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id).lease_id,claim.leaseId);}finally{db.close();}
});

test('bounded batching, transactional reservation rollback, transcript head/tail retention, redaction, paging and body-only expiration', t => {
  const f = fixture(t);
  for (let i = 0; i < 105; i++)
    f.append();
  f.store.db.exec("CREATE TRIGGER reject_wakeup BEFORE INSERT ON chat_planner_wakeup_items BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.throws(() => f.repository.reserve(f.room.id, 'live'));
  assert.equal(f.repository.quota(f.room.id).used, 0);
  f.store.db.exec('DROP TRIGGER reject_wakeup');
  const a = f.repository.reserve(f.room.id, 'catch_up');
  assert.equal(a.items.length, 100);
  f.repository.start(a.id);
  f.repository.append(a.id, 'assistant', 'HEAD credential-sentinel ' + 'a'.repeat(64000));
  for (let i = 0; i < 160; i++)
    f.repository.append(a.id, 'assistant', '😀'.repeat(2000));
  const page = f.repository.detail(f.room.id, a.id, 0, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 131072);
  assert.ok(page.chunks[0].text.startsWith('HEAD [redacted]'));
  assert.equal(page.truncated, true);
  assert.ok(f.repository.get(f.room.id, a.id).retainedBytes <= 1048576);
  f.repository.end(a.id, { exitCode: 0, resultSeen: false });
  const quota = f.repository.quota(f.room.id).used;
  f.time(f.now + 31 * 86400000);
  for (let i = 0; i < 5; i++)
    f.repository.cleanup();
  assert.equal(f.repository.detail(f.room.id, a.id, 0, 100).chunks.length, 0);
  assert.equal(f.repository.get(f.room.id, a.id).transcriptExpired, true);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_planner_wakeup_items WHERE attempt_id=?').get(a.id).n, 100);
  assert.equal(f.repository.list(f.room.id).items.length, 1);
  assert.equal(quota, 1);
});


function settingsFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wakeup-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedSettingsDir = path.join(root, 'managed');
  const env = { HOME: root, USERPROFILE: root };
  const file = path.join(root, '.claude', 'settings.json');
  const write = (value, target = file) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); return target; };
  const check = (extra = {}) => require('../../build/server/domain/runtime/planner-wakeup-settings').checkPlannerWakeupSettings({ env, managedSettingsDir, ...extra });
  return { root, env, file, managedSettingsDir, write, check };
}
for (const [label, value, kind] of [
  ['bare Bash', { permissions: { allow: [' Bash '] } }, 'bash_allow'],
  ['Bash prefix', { permissions: { allow: [' Bash (sensitive-rule-must-not-leak)'] } }, 'bash_allow'],
  ...['Read','Glob','Grep'].flatMap(tool => [
    [tool, { permissions: { allow: [tool] } }, 'read_allow'],
    [tool + ' prefix', { permissions: { allow: [' ' + tool + '(*) '] } }, 'read_allow'],
  ]),
  ['extra directory', { permissions: { additionalDirectories: ['private-directory-must-not-leak'] } }, 'additional_directories'],
  ['invalid JSON', '{sensitive-json-must-not-leak', 'invalid_json'],
  ['array', [], 'invalid_json'], ['null', null, 'invalid_json'], ['scalar', '123', 'invalid_json'],
]) test(`wakeup settings reject ${label} with only file and category`, t => {
  const f = settingsFixture(t); f.write(value);
  assert.deepEqual(f.check(), { available: false, reasonCode: 'planner_wakeup_settings_unsafe', issue: { file: f.file, kind } });
});
test('wakeup settings reject an existing unreadable file (directory) and unreadable managed fragment directory', t => {
  const f = settingsFixture(t); fs.mkdirSync(f.file, { recursive: true });
  assert.equal(f.check().issue.kind, 'unreadable');
  fs.rmSync(f.file, { recursive: true });
  f.write('{}', path.join(f.managedSettingsDir, 'managed-settings.d'));
  assert.equal(f.check().issue.kind, 'unreadable');
});
test('missing settings and non-read/non-Bash allowances are safe; checks use child home/config dir without caching or parent env', t => {
  const f = settingsFixture(t);
  assert.equal(f.check().available, true);
  f.write({ permissions: { allow: ['WebSearch','Edit'], additionalDirectories: [] } });
  assert.equal(f.check().available, true);
  const configDir = path.join(f.root, 'custom-config'); f.env.CLAUDE_CONFIG_DIR = configDir;
  f.write({ permissions: { allow: ['Bash(*)'] } }, path.join(configDir, 'settings.json'));
  assert.equal(f.check().issue.file, path.join(configDir, 'settings.json'));
  fs.unlinkSync(path.join(configDir, 'settings.json')); assert.equal(f.check().available, true);
  delete f.env.CLAUDE_CONFIG_DIR;
  const other = path.join(f.root, 'different-home');
  f.write({ permissions: { allow: ['Bash'] } }, path.join(other, '.claude', 'settings.json'));
  assert.equal(f.check({ env: { HOME: other, USERPROFILE: f.root }, platform: 'linux' }).available, false);
  assert.equal(f.check({ env: { HOME: other, USERPROFILE: f.root }, platform: 'win32' }).available, true);
});
test('settings accept a leading UTF-8 BOM without skipping unsafe permissions', t => {
  const f = settingsFixture(t);
  f.write('\uFEFF' + JSON.stringify({ permissions: { allow: ['WebSearch','Edit'] } }));
  assert.equal(f.check().available, true);
  f.write('\uFEFF' + JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
  assert.deepEqual(f.check().issue, { file: f.file, kind: 'bash_allow' });
});
for (const name of ['managed-settings.json', 'managed-settings.d/x.json'])
  test(`file-based managed settings are checked: ${name}`, t => {
    const f = settingsFixture(t), target = f.write({ permissions: { allow: ['Bash(*)'] } }, path.join(f.managedSettingsDir, name));
    assert.deepEqual(f.check().issue, { file: target, kind: 'bash_allow' });
  });
