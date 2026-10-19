// Adapter safety tests execute the actual helper in a VM with inert callback/FS.
// This is not Docker or real SDK/tool evidence.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const fixture = require('../helpers/badcase-caff-bridge-fixture.cjs');
const realPlan = require('../../build/server/domain/runtime/badcase-capture/retained-callback-input').planRetainedEvaluationCallback;
function adapter(v, options = {}) {
  const env = { ...(options.env || {}) }, events = [], mod = { exports: {} };
  let starts = 0, stops = 0;
  const files = new Map(), toolCalls = [];
  const fakeFs = { mkdirSync: p => { if (files.has(p) || options.probeDirectoryExists) throw Error('inert_exists'); files.set(p, null); },
    readFileSync: p => { assert.ok(files.has(p)); return files.get(p); } };
  const callback = { apiUrl: 'http://127.0.0.1:12345', credentials: { invocationId: 'new-invocation', callbackToken: 'a'.repeat(64) },
    traceReceipt: { traceHash: options.wrongHash ? '0'.repeat(64) : realPlan(v.capsule, v.expected, v.association).receipt.callbackInputHash, association: v.association },
    stop: async () => { stops++; events.push('stop'); if (options.stopFailure) throw Error('inert_stop'); } };
  const context = { module: mod, Buffer, AbortSignal, process: { env }, require: name => {
    if (name === 'node:assert/strict') return { ...assert, deepEqual: (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))) };
    if (name === 'node:crypto') return crypto;
    if (name === 'node:fs') return fakeFs;
    if (name.endsWith('/retained-callback-input')) return { planRetainedEvaluationCallback: realPlan };
    assert.ok(name.endsWith('/evaluation-callback'));
    return { startEvaluationCallback: async input => { starts++; events.push('start');
      assert.equal(input.trace, JSON.stringify(v.trace)); assert.equal(input.directory, '/work/callback'); assert.equal(input.lifetimeMs, 20000);
      assert.equal(Object.hasOwn(input, 'seed'), false); return callback; } };
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../scripts/badcase-capture/retained-caff-callback.cjs'), 'utf8'), context);
  const originalFetch = async () => { events.push('closed-probe');
    if (options.listenerStillLive) return {};
    throw Object.assign(Error('network'), { cause: { code: options.closeCode || 'ECONNREFUSED' } }); };
  let posted = false;
  const result = s => ({ content: [{ type: 'text', text: s }] });
  const projection = () => {
    const messages = v.trace.publicMessages.map(({ turnId, ...m }) => m), user = messages.find(m => m.id === v.association.userMessageId);
    const publicMessages = [...messages, ...(posted ? [{ id: v.association.assistantMessageId, content: 'RETAINED_BRIDGE_PROBE_RESULT' }] : [])].slice(-24);
    if (!publicMessages.some(m => m.id === user.id)) publicMessages.unshift(user);
    return { publicMessages, latestUserMessage: user, participants: v.trace.participants,
      conversation: { id: v.association.conversationId, ...v.trace.conversation }, privateMessages: [], pendingDelegations: [] };
  };
  const tool = name => ({ name, execute: async (id, args) => {
    toolCalls.push(name);
    if (options.toolError) return { isError: true, content: [{ type: 'text', text: 'error' }] };
    const file = '/work/root/' + args.path;
    if (name === 'write') { files.set(file, args.content); return result(''); }
    if (name === 'read') return result(files.get(file));
    if (name === 'edit') { files.set(file, files.get(file).replace(args.edits[0].oldText, args.edits[0].newText)); return result(''); }
    if (name === 'list_rooms') { if (options.routeAllowed) return result('allowed'); throw Error('evaluation_callback_route_unavailable'); }
    assert.equal(name, 'bash');
    if (args.command.includes('id -u')) return result((options.wrongUid ? '0' : '65534') + ':/work/root');
    assert.ok(args.command.startsWith('node "$CAFF_CHAT_TOOLS_PATH" '));
    if (args.command.includes('send-public')) { assert.ok(args.command.includes('--no-finalize')); posted = true; return result(JSON.stringify({ message: { id: options.wrongSentId ? 'wrong' : v.association.assistantMessageId } })); }
    assert.ok(args.command.endsWith('read-context')); const p = projection();
    if (options.wrongContext) p.publicMessages = [];
    return result(JSON.stringify(p));
  } });
  const tools = ['write', 'read', 'edit', 'bash', 'list_rooms'].map(tool);
  if (options.missingBash) tools.splice(3, 1);
  return { api: mod.exports, env, events, toolCalls, starts: () => starts, stops: () => stops,
    start: () => mod.exports.startRetainedCaffCallback(v.capsule, v.expected, v.association, originalFetch),
    probe: s => mod.exports.probeRetainedCaffTools({ agent: { state: { tools } } }, { cwd: '/work/root' }, s) };
}
test('actual callback adapter binds only five declared env replacements, uses retained trace not seed and removes them after real-refusal check', async t => {
  const h = adapter(fixture(t)), s = await h.start();
  assert.equal(h.starts(), 1); assert.equal(Object.keys(h.env).length, 5);
  assert.equal(h.env.CAFF_CHAT_TOOLS_PATH, '/work/build/lib/agent-chat-tools.js');
  assert.equal(h.env.CAFF_CHAT_TOOLS_RELATIVE_PATH, '/work/build/lib/agent-chat-tools.js');
  assert.equal(h.env.CAFF_CHAT_API_URL, s.apiUrl);
  assert.equal(h.env.CAFF_CHAT_CALLBACK_TOKEN, 'a'.repeat(64));
  assert.equal(h.api.bridgeReplacementsHash, crypto.createHash('sha256').update(JSON.stringify(h.api.bridgeReplacements)).digest('hex'));
  assert.equal(JSON.stringify(h.api.bridgeReplacements).includes('a'.repeat(64)), false);
  await Promise.all([s.stop(), s.stop()]); assert.equal(h.stops(), 1); assert.deepEqual(h.env, {});
  assert.deepEqual(h.events, ['start', 'stop', 'closed-probe']);
});
test('actual adapter refuses ambient bridge authority before start; callback attestation or stop failure cannot succeed or leave auth env', async t => {
  for (const key of ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH']) {
    const h = adapter(fixture(t), { env: { [key]: 'ambient' } }); await assert.rejects(h.start()); assert.equal(h.starts(), 0);
  }
  const h = adapter(fixture(t), { wrongHash: true }); await assert.rejects(h.start()); assert.equal(h.stops(), 1); assert.deepEqual(h.env, {});
  for (const options of [{ stopFailure: true }, { listenerStillLive: true }, { closeCode: 'ETIMEDOUT' }, { closeCode: 'EAI_AGAIN' }, { closeCode: 'ABORT_ERR' }]) {
    const h = adapter(fixture(t), options), s = await h.start(); await assert.rejects(s.stop()); assert.deepEqual(h.env, {});
  }
});
test('actual probe checks file/shell/CLI/capability results and long history uses the production bounded projection (inert tools)', async t => {
  const longHistory = ({ trace }) => {
    const user = trace.publicMessages.find(m => m.role === 'user'); user.createdAt = '2026-01-01T00:00:00.000Z';
    trace.publicMessages = [user, ...Array.from({ length: 30 }, (_, i) => ({ ...trace.publicMessages[0], id: 'prior' + String(i).padStart(2, '0'),
      createdAt: new Date(Date.parse(user.createdAt) + (i + 1) * 10).toISOString() }))];
  };
  const h = adapter(fixture(t, 'resume', 'linux', longHistory)), s = await h.start();
  await h.probe(s); assert.deepEqual(h.toolCalls, ['write', 'read', 'edit', 'read', 'bash', 'bash', 'bash', 'bash', 'list_rooms']);
  await s.stop(); assert.deepEqual(h.env, {});
  for (const options of [{ probeDirectoryExists: true }, { toolError: true }, { missingBash: true }, { wrongUid: true }, { wrongContext: true }, { wrongSentId: true }, { routeAllowed: true }]) {
    const h = adapter(fixture(t), options), s = await h.start();
    try { await assert.rejects(h.probe(s)); } finally { await s.stop(); }
  }
});
test('common retained runtime starts callback before SDK, probes after factory and disposes runtime before stopping callback for fresh/resume', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const mode of ['fresh', 'resume']) {
    const h = harness(fixture(t, mode), { nodeVersion: 'v24.21.0', architecture: 'amd64' }, { bridge: true });
    const r = await h.run(); assert.equal(r.callbackWired, true); assert.equal(r.callbackClosed, true); assert.equal(r.invocationSubmitted, false);
    assert.equal(r.observation.historyMessages, mode === 'resume' ? 3 : 0);
    assert.equal(h.disposals(), 1); assert.equal(h.callbackStops(), 1);
    assert.ok(h.events.indexOf('restore') < h.events.indexOf('callback-start'));
    assert.ok(h.events.indexOf('callback-start') < h.events.indexOf('load:/work/runtime/dist/bundle/index.js'));
    assert.ok(h.events.indexOf('factory') < h.events.indexOf('tools-probe'));
    assert.deepEqual(h.events.slice(-2), ['dispose', 'callback-stop']);
    assert.equal(h.context.fetch, h.originalFetch); assert.deepEqual(h.context.process.env, {}); assert.equal(h.modelGuardRestored(), true);
  }
});
test('callback start/probe/close or runtime dispose failures always reject, clean env and restore model guards', async t => {
  const harness = require('../helpers/badcase-retained-caff-vm.cjs');
  for (const options of [{ callbackStartFailure: true }, { importFailure: true }, { callbackProbeFailure: true }, { callbackStopFailure: true }, { disposeFailure: true }]) {
    const h = harness(fixture(t), { nodeVersion: 'v24.21.0', architecture: 'amd64' }, { bridge: true, ...options });
    await assert.rejects(h.run()); assert.equal(h.callbackStops(), options.callbackStartFailure ? 0 : 1);
    assert.equal(h.context.fetch, h.originalFetch); assert.deepEqual(h.context.process.env, {}); assert.equal(h.modelGuardRestored(), true);
  }
});
