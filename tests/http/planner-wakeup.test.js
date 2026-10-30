const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), path = require('node:path'), { once } = require('node:events'), { WebSocket } = require('ws');
const { fixture } = require('../helpers/planner-wakeup');
const completed = f => f.wait(async () => { const r = await f.call('wakeups'); return r.body.items?.[0]?.finishedAt ? r.body.items[0] : null; });
test('live scheduler -> pipe fake CLI -> actual caff/P1 -> production finish; five triggers batch, attribution and needs-user suppression persist', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('wakeups', { enabled: true })).status, 200);
  for (const k of ['proposal_pending', 'budget_exhausted', 'failure_paused', 'owner_removed', 'turn_failed'])
    f.append(k);
  const a = await completed(f);
  assert.equal(a.status, 'needs_user');
  assert.equal(f.launches().length, 1);
  const launch = f.launches()[0];
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launch.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(launch.env.CLAUDE_CODE_NO_FLICKER, undefined);
  assert.equal(launch.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, undefined);
  assert.equal(launch.env.CAFF_CHAT_TOKEN, undefined);
  assert.equal(launch.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(launch.env.CAFF_ROOM_ID, f.room.id);
  assert.equal(launch.env.CAFF_PLANNER_CREDENTIAL_FILE, f.file);
  assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(launch.args[launch.args.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!launch.args.includes('--settings'));
  assert.ok(!launch.args.some(arg => arg.includes('blockReadsOutsideWorkingDirectories')));
  const { buildVerifiedPlannerWakeup } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
  assert.deepEqual(launch.args, buildVerifiedPlannerWakeup({ version: '2.1.310', sessionId: launch.args[2], appendPrompt: launch.args[launch.args.indexOf('--append-system-prompt') + 1] }).args);
  for (const bare of ['Read','Glob','Grep']) assert.ok(!launch.args[launch.args.indexOf('--allowedTools') + 1].split(',').includes(bare));
  assert.ok(Buffer.byteLength(launch.prompt) <= 65536);
  const detail = await f.call('wakeups/' + a.id);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.chunks.some(x => x.kind === 'assistant'));
  assert.ok(!JSON.stringify(detail.body).includes('THINKING_MUST_NOT_BE_STORED'));
  for (const value of [f.token, 'provider-sentinel', 'http://proxy-user:proxy-pass@invalid'])
    assert.ok(!JSON.stringify(detail.body).includes(value));
  assert.ok(detail.body.chunks.some(x => x.kind === 'receipt' && x.text.includes('needs_user')));
  const message = f.app.store.db.prepare("SELECT metadata_json FROM chat_messages WHERE conversation_id=? AND role='user'").get(f.room.id);
  assert.equal(JSON.parse(message.metadata_json).principal.kind, 'planner');
  const state = await f.call('state');
  assert.equal(state.body.needsUserCount, 5);
  assert.equal(state.body.quota.used, 1);
  await f.call('wakeups', { enabled: false });
  await f.call('wakeups', { enabled: true });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(f.launches().length, 1);
});
test('settings changed after opt-in block each launch without claims/quota; diagnostics name file/category only; fixing file allows same item', async t => {
  const logs = [], f = await fixture(t, { log: entry => logs.push(entry) });
  assert.equal((await f.call('wakeups', { enabled: true })).status, 200);
  const file = path.join(f.root, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(private-rule-sentinel)'] }, privateField: 'private-field-sentinel' }));
  const row = f.append();
  const state = await f.wait(async () => { const r = await f.call('state'); return r.body.wakeupReasonCode === 'planner_wakeup_settings_unsafe' ? r.body : null; });
  await f.wait(() => logs.some(x => x.reasonCode === 'planner_wakeup_settings_unsafe'));
  assert.equal(state.available, true); assert.equal(state.wakeupAvailable, false);
  assert.deepEqual(state.wakeupSettingsIssue, { file, kind: 'bash_allow' });
  assert.equal(f.launches().length, 0); assert.equal(state.quota.used, 0);
  assert.equal(f.sessions.hasLease(f.room.id), false);
  assert.equal((await f.call('wakeups')).body.items.length, 0);
  assert.ok(f.records.pending(f.room.id, f.goal.goalId).some(x => x.sequence === row.sequence));
  assert.equal(f.app.store.listPlannerAttention({ conversationId: f.room.id, status: 'unresolved' }).items[0].sequence, row.sequence);
  const blocked = await f.call('wakeups', { enabled: true }); assert.equal(blocked.status, 503);
  const diagnostic = JSON.stringify({ state, logs, body: blocked.body });
  assert.ok(!diagnostic.includes('private-rule-sentinel')); assert.ok(!diagnostic.includes('private-field-sentinel'));
  assert.ok(logs.some(x => x.settingsIssue?.file === file && x.settingsIssue?.kind === 'bash_allow'));
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read(*)','WebSearch','Edit'] } }));
  const readState = await f.wait(async () => { const r = await f.call('state'); return r.body.wakeupSettingsIssue?.kind === 'read_allow' ? r.body : null; });
  await f.wait(() => logs.some(x => x.settingsIssue?.kind === 'read_allow'));
  assert.equal(readState.wakeupReasonCode, 'planner_wakeup_settings_unsafe');
  assert.equal(f.launches().length, 0); assert.equal(readState.quota.used, 0);
  assert.ok(f.records.pending(f.room.id, f.goal.goalId).some(x => x.sequence === row.sequence));
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['WebSearch','Edit'] } }));
  // The exact same occurrence remains pending; no cached unsafe decision.
  await f.call('wakeups', { enabled: true }); const a = await completed(f);
  assert.equal(f.launches().length, 1); assert.equal((await f.call('state')).body.quota.used, 1);
  assert.equal(f.app.store.db.prepare('SELECT attention_sequence FROM chat_planner_wakeup_items WHERE attempt_id=?').get(a.id).attention_sequence, row.sequence);
  fs.writeFileSync(file, JSON.stringify({ permissions: { additionalDirectories: ['private-directory-sentinel'] } }));
  const next = f.append(); await f.wait(() => logs.some(x => x.settingsIssue?.kind === 'additional_directories'));
  assert.equal(f.launches().length, 1); assert.equal((await f.call('state')).body.quota.used, 1);
  assert.ok(f.records.pending(f.room.id, f.goal.goalId).some(x => x.sequence === next.sequence));
});

test('stdin command card includes all actual-prefix commands, closed action examples and explicit canonical escapes within the total budget', async t => {
  const f = await fixture(t);
  await f.call('wakeups', { enabled: true }); f.append();
  const a = await completed(f), launch = f.launches()[0];
  const { buildVerifiedPlannerWakeup } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
  const { parsePlannerCommand } = require('../../build/lib/planner-cli');
  const prefix = buildVerifiedPlannerWakeup({ version: '2.1.310', sessionId: launch.args[2], appendPrompt: '' }).adapterPrefix;
  for (const suffix of ['state', 'goal read', 'attention read --after <n> --limit <n>', "goal action --json '<object>'", "owner message --json '<object>'", `wakeup finish --attempt ${a.id} --json '<array>'`])
    assert.ok(launch.prompt.split('\n').includes(prefix + ' ' + suffix), suffix);
  assert.match(launch.prompt, /Only these six commands/); assert.match(launch.prompt, /no --help/);
  assert.match(launch.prompt, /state -> goal read -> delegated action -> finish/);
  assert.match(launch.prompt, /nothing before or after/);
  const examples = launch.prompt.split('\n').filter(line => line.startsWith(prefix + " goal action --json '") && !line.includes('<object>'));
  const actions = examples.map(line => {
    const raw = line.slice((prefix + " goal action --json '").length, -1);
    return parsePlannerCommand(['goal', 'action', '--json', raw], f.room.id).body.action;
  });
  assert.deepEqual(actions.sort(), ['pause','resume','complete','set-owner','accept-proposal','dismiss-proposal','update-delivery','revise'].sort());
  for (const character of ['"', '\\', "'", '$', '`', ';', '&', '|', '<', '>', '(', ')'])
    assert.ok(launch.prompt.includes(character + ' -> \\u' + character.charCodeAt(0).toString(16).padStart(4, '0')), JSON.stringify(character));
  assert.ok(launch.prompt.includes('outside printable ASCII 0x20-0x7E'));
  assert.ok(launch.prompt.includes('lowercase hex') && launch.prompt.includes('surrogate pairs'));
  const finishExample = launch.prompt.split('\n').find(line => line.startsWith(prefix + ` wakeup finish --attempt ${a.id} --json '[`));
  assert.ok(finishExample);
  const receipt = JSON.parse(finishExample.slice(finishExample.indexOf("--json '") + 8, -1));
  assert.equal(receipt[0].reason, "Owner's request (reviewed)");
  assert.match(launch.prompt, /caff_payload_noncanonical/);
  const policy = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  assert.ok(Buffer.byteLength(policy) + Buffer.byteLength(launch.prompt) <= 65536);
});
test('fake CLI follows the stdin command card through state, full Goal, delegated proposal ruling and one production finish', async t => {
  const f = await fixture(t, { mode: 'command-card' });
  const { proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
  const proposal = proposeSessionGoalAction(f.app.store, f.room.id, { action: 'resume', reason: 'Synthetic owner request' }, { agentId: 'owner', agentName: 'Owner' }).proposal;
  await f.call('wakeups', { enabled: true });
  const a = await completed(f);
  assert.equal(a.status, 'succeeded');
  const trace = JSON.parse(fs.readFileSync(path.join(f.root, 'fake-command-card.json'), 'utf8'));
  assert.deepEqual(trace.commands, ['state','goal read','attention read','goal action','owner message','wakeup finish']);
  assert.equal(trace.conversationId, f.room.id); assert.equal(trace.goalId, f.goal.goalId);
  assert.equal(trace.ruling.proposalId, proposal.id); assert.equal(trace.ruling.ruledBy.kind, 'planner');
  assert.equal(trace.ruling.ruledBy.plannerId, 'local-planner');
  assert.equal(trace.finish.items[0].reason, "Owner's request (reviewed)");
  assert.equal(trace.finish.items[0].disposition, 'handled');
  assert.equal((await f.call('wakeups/' + a.id)).body.chunks.filter(c => c.kind === 'receipt').length, 1);
  assert.equal(f.launches().length, 1);
});

test('redaction preserves envelope keys/identities and the complete policy-plus-envelope stays within 64 KiB',async t=>{
  const f=await fixture(t,{expandingRedaction:true});await f.call('wakeups',{enabled:true});
  for(let i=0;i<100;i++)f.append('proposal_pending',{summary:'goal'.repeat(125)});
  await f.wait(()=>f.launches().length>0);const launch=f.launches()[0];await f.call('wakeups',{enabled:false});
  const data=JSON.parse(launch.prompt.slice(launch.prompt.lastIndexOf('\n')+1));
  assert.equal(data.goal?.goalId,f.goal.goalId);assert.equal(data.roomId,f.room.id);
  const policy=launch.args[launch.args.indexOf('--append-system-prompt')+1];assert.ok(Buffer.byteLength(policy)+Buffer.byteLength(launch.prompt)<=65536);
  assert.ok(data.items.length>0&&data.items.length<100);assert.ok(data.items.every(i=>[...i.summary].length<=500));
  await completed(f);
});

test('attached and retained PTY suppress print without quota; attention is advisory only; releasing process admits pending batch', async (t) => {
  const f = await fixture(t);
  const url = f.base.replace('http:', 'ws:') + `/api/conversations/${f.room.id}/planner/terminal`;
  const ws = new WebSocket(url, { headers: { Origin: f.base } }), events = [];
  t.after(() => ws.terminate());
  ws.on('message', d => events.push(JSON.parse(d)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', version: 1, token: f.boot.apiSecurity.csrfToken, cols: 120, rows: 30 }));
  await f.wait(() => events.some(e => e.type === 'ready'));
  await f.call('wakeups', { enabled: true });
  f.append();
  await f.wait(() => events.some(e => e.type === 'attention' && e.unresolvedCount === 1));
  assert.equal(f.launches().length, 0);
  assert.equal((await f.call('state')).body.quota.used, 0);
  const detached = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'detach' }));
  await detached;
  await new Promise(r => setTimeout(r, 120));
  assert.equal(f.launches().length, 0);
  const again = new WebSocket(url, { headers: { Origin: f.base } });
  t.after(() => again.terminate());
  await once(again, 'open');
  const ready = once(again, 'message');
  again.send(JSON.stringify({ type: 'auth', version: 1, token: f.boot.apiSecurity.csrfToken, cols: 120, rows: 30 }));
  await ready;
  again.send(JSON.stringify({ type: 'terminate' }));
  const a = await completed(f);
  assert.equal(a.status, 'needs_user');
  assert.equal(f.launches().length, 1);
});
for (const mode of ['missing', 'no-finish', 'bad-json', 'bad-init', 'oversize', 'hang'])
  test(`print ${mode} has a durable explicit outcome and never auto-retries`, { timeout: 30000 }, async (t) => {
    const f = await fixture(t, { mode, wallMs: mode === 'hang' ? 100 : 10000 });
    await f.call('wakeups', { enabled: true });
    f.append();
    const a = await completed(f);
    assert.equal(a.status, mode === 'missing' ? 'needs_user' : mode === 'no-finish' ? 'unknown' : 'failed');
    if (mode === 'missing')
      assert.equal(a.reasonCode, 'planner_session_unavailable');
    if (mode === 'bad-init') {
      assert.equal((await f.call('state')).body.wakeupReasonCode, 'planner_wakeup_tools_unverified');
      f.append();
    }
    await new Promise(r => setTimeout(r, 100));
    assert.equal(f.launches().length, 1);
    assert.equal((await f.call('state')).body.quota.used, 1);
  });
test('spawn failure is recorded/charged without a leaked lease and without automatic replay', async (t) => {
  const f = await fixture(t, { launchPrint: () => { throw Object.assign(new Error('private sentinel'), { code: 'planner_process_spawn_failed' }); } });
  await f.call('wakeups', { enabled: true });
  f.append();
  const a = await completed(f);
  assert.equal(a.status, 'failed');
  assert.equal(a.reasonCode, 'planner_process_spawn_failed');
  assert.equal(f.sessions.hasLease(f.room.id), false);
  assert.equal(f.launches().length, 0);
});
test('audit persistence failure fails closed without crashing or recursively replaying',async t=>{
  const f=await fixture(t);f.app.store.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON chat_planner_wakeup_chunks BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await f.call('wakeups',{enabled:true});f.append();const a=await completed(f);assert.equal(a.status,'failed');assert.equal(a.reasonCode,'planner_wakeup_storage_unavailable');
  assert.equal((await f.call('state')).body.wakeupReasonCode,'planner_wakeup_storage_unavailable');f.append();await new Promise(r=>setTimeout(r,100));assert.equal(f.launches().length,1);
});

test('shutdown interrupts a running print attempt and preserves its claim/quota on reopen', { timeout: 30000 }, async (t) => {
  const f = await fixture(t, { mode: 'hang' });
  await f.call('wakeups', { enabled: true });
  f.append();
  await f.wait(() => f.launches().length === 1);
  await f.close();
  const { createChatAppStore } = require('../../build/lib/chat-app-store'), { PlannerWakeupRepository } = require('../../build/storage/chat/planner-wakeup.repository');
  const store = createChatAppStore({ agentDir: f.root, sqlitePath: path.join(f.root, 'chat.sqlite') });
  try {
    const repo = new PlannerWakeupRepository(store), a = repo.list(f.room.id).items[0];
    assert.equal(a.status, 'interrupted');
    assert.equal(repo.quota(f.room.id).used, 1);
    assert.equal(repo.reserve(f.room.id, 'catch_up'), null);
  }
  finally {
    store.close();
  }
});
test('startup catch-up claims an unresolved occurrence once; unknown/completed/null Goal items and opt-out never launch', async (t) => {
  const f = await fixture(t, { preseed: true });
  const a = await completed(f);
  assert.equal(a.source, 'catch_up');
  assert.equal(f.launches().length, 1);
  await f.call('wakeups', { enabled: false });
  f.append();
  f.append('goal_completed');
  f.append('proposal_pending', { goalId: null, goalRevision: 0 });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(f.launches().length, 1);
});
test('wakeup API guards user toggle/planner receipt, local reads, strict queries/bodies and cross-room attempts', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('wakeups', { enabled: true }, true)).status, 403);
  assert.equal((await f.call('wakeups', { enabled: true }, false, { 'X-CAFF-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await f.call('wakeups', { enabled: true }, false, { Origin: 'http://foreign.invalid' })).status, 403);
  assert.equal((await f.call('wakeups', undefined, false, { 'X-CAFF-CSRF-Token': 'bad' })).status, 403);
  for (const body of ['{"enabled":true,"enabled":true}', { enabled: true, extra: true }, 'x'.repeat(1025)])
    assert.ok([400, 413].includes((await f.call('wakeups', body)).status));
  for (const suffix of ['wakeups?limit=0', 'wakeups?before=0', 'wakeups?limit=1&limit=2', 'wakeups?x=1'])
    assert.equal((await f.call(suffix)).status, 400);
  await f.call('wakeups', { enabled: true });
  const row = f.append();
  const a = await completed(f);
  const receipt = { items: [{ sequence: row.sequence, disposition: 'needs_user', reason: "User's decision; no $(shell) 中文 🙂" }] };
  assert.equal((await f.call(`wakeups/${a.id}/finish`, receipt)).status, 403);
  assert.equal((await f.call(`wakeups/${a.id}/finish`, receipt, true)).status, 200);
  assert.equal((await f.call(`wakeups/${a.id}/finish`, { items: [] }, true)).status, 400);
  const malformed=await fetch(f.base+`/api/conversations/${f.room.id}/planner/wakeups/${a.id}/finish`,{method:'POST',headers:{Authorization:'Bearer '+f.token,'X-CAFF-Principal':'planner','Content-Type':'application/json'},body:Buffer.from([0xc0,0xaf])});assert.equal(malformed.status,400);
  const foreign = f.app.store.createConversation({ title: 'Other', participants: ['owner'] });
  const r = await fetch(f.base + `/api/conversations/${foreign.id}/planner/wakeups/${a.id}`, { headers: { Authorization: 'Bearer ' + f.token, 'X-CAFF-Principal': 'planner' } });
  assert.equal(r.status, 404);
  assert.equal((await f.call(`wakeups/${a.id}?afterChunk=-1`)).status, 400);
});
for (const extra of [{ version: '2.2.0' }, { version: '2.1.309' }, { adapterPath: path.resolve('space here/caff.js') }])
  test('unverified version/path gates wakes separately from the terminal baseline with fixed reason', async (t) => {
    const f = await fixture(t, extra);
    const state = await f.call('state');
    assert.equal(state.body.available, extra.version !== '2.1.309');
    assert.equal(state.body.wakeupAvailable, false);
    assert.equal(state.body.wakeupReasonCode, 'planner_wakeup_tools_unverified');
    assert.equal((await f.call('wakeups', { enabled: true })).status, 503);
    f.append();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(f.launches().length, 0);
  });
