// CONTAINER runtime adapter. Called only AFTER immutable-stage guard/restoration.
// No live source lookup, seed fallback, provider key or production callback.
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
// These names/targets, NOT ephemeral auth values, are receipt material. The two
// auth fields are newly generated local callback credentials, not provider leases.
const bridgeReplacements = Object.freeze([
  ['CAFF_CHAT_API_URL', 'isolated_loopback_callback'],
  ['CAFF_CHAT_INVOCATION_ID', 'new_local_invocation'],
  ['CAFF_CHAT_CALLBACK_TOKEN', 'new_local_callback_auth'],
  ['CAFF_CHAT_TOOLS_PATH', '/work/build/lib/agent-chat-tools.js'],
  ['CAFF_CHAT_TOOLS_RELATIVE_PATH', '/work/build/lib/agent-chat-tools.js'],
]);
const bridgeReplacementsHash = hash(JSON.stringify(bridgeReplacements));
async function startRetainedCaffCallback(capsule, expected, association, originalFetch) {
  const base = '/work/build/server/domain/runtime/badcase-capture/';
  const plan = require(base + 'retained-callback-input').planRetainedEvaluationCallback(capsule, expected, association);
  const trace = JSON.parse(plan.callbackInput.trace);
  for (const [key] of bridgeReplacements) assert.equal(Object.hasOwn(process.env, key), false);
  const callback = await require(base + 'evaluation-callback').startEvaluationCallback({
    ...plan.callbackInput, directory: '/work/callback', lifetimeMs: 20000,
  });
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await callback.stop();
        // Timeout, DNS and generic network failure are NOT proof of closure.
        let refused = false;
        try { await originalFetch(callback.apiUrl + '/api/agent-tools/context', { signal: AbortSignal.timeout(1000) }); }
        catch (e) { refused = e?.cause?.code === 'ECONNREFUSED'; }
        assert.equal(refused, true);
      } finally { for (const [key] of bridgeReplacements) delete process.env[key]; }
    })(); return stopping;
  }
  try {
    assert.equal(callback.traceReceipt.traceHash, plan.receipt.callbackInputHash);
    assert.deepEqual(callback.traceReceipt.association, association);
    for (const [key, value] of [
      ['CAFF_CHAT_API_URL', callback.apiUrl], ['CAFF_CHAT_INVOCATION_ID', callback.credentials.invocationId],
      ['CAFF_CHAT_CALLBACK_TOKEN', callback.credentials.callbackToken],
      ['CAFF_CHAT_TOOLS_PATH', '/work/build/lib/agent-chat-tools.js'], ['CAFF_CHAT_TOOLS_RELATIVE_PATH', '/work/build/lib/agent-chat-tools.js'],
    ]) process.env[key] = value;
    return { apiUrl: callback.apiUrl, stop, plan, trace };
  } catch (e) { await stop(); throw e; }
}
async function probeRetainedCaffTools(session, config, callback) {
  const tools = session.agent.state.tools;
  const tool = (name, args) => {
    const t = tools.find(t => t.name === name); assert.ok(t);
    return t.execute('retained-bridge-' + name, args, AbortSignal.timeout(3000));
  };
  const text = result => { assert.notEqual(result.isError, true); return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); };
  // An exclusive diagnostic-only subtree in this variant. Never overwrite an
  // archived file to make a probe pass; this is NOT a replayed model tool call.
  const relative = '.caff-bridge-probe', directory = config.cwd + '/' + relative;
  fs.mkdirSync(directory, { mode: 0o700 });
  await tool('write', { path: relative + '/file.txt', content: 'before\n' });
  assert.equal(text(await tool('read', { path: relative + '/file.txt' })).trim(), 'before');
  await tool('edit', { path: relative + '/file.txt', edits: [{ oldText: 'before', newText: 'after' }] });
  assert.equal(text(await tool('read', { path: relative + '/file.txt' })).trim(), 'after');
  assert.equal(fs.readFileSync(directory + '/file.txt', 'utf8'), 'after\n');
  assert.equal(text(await tool('bash', { command: 'printf "%s:" "$(id -u)"; pwd', timeout: 2 })).trim(), '65534:' + config.cwd);
  const cli = args => tool('bash', { command: 'node "$CAFF_CHAT_TOOLS_PATH" ' + args, timeout: 2 });
  const before = JSON.parse(text(await cli('read-context'))), trace = callback.trace, association = callback.plan.callbackInput.association;
  // Real bridge projection is bounded at 24, with the triggering user added if
  // absent. Validate that exact projection; never claim it returned all history.
  const selected = trace.publicMessages.slice(-24), user = trace.publicMessages.find(m => m.id === association.userMessageId);
  if (!selected.some(m => m.id === user.id)) selected.unshift(user);
  const project = ({ turnId, ...message }) => message; // production public API omits turnId
  assert.deepEqual(before.publicMessages, selected.map(project));
  assert.deepEqual(before.latestUserMessage, project(user));
  assert.equal(before.conversation.id, association.conversationId);
  assert.equal(before.conversation.title, trace.conversation.title);
  assert.deepEqual(before.conversation.metadata, trace.conversation.metadata);
  assert.deepEqual(before.privateMessages, []); assert.deepEqual(before.pendingDelegations, []);
  assert.equal(before.participants.length, trace.participants.length);
  for (const p of trace.participants) {
    const actual = before.participants.find(a => a.id === p.id); assert.ok(actual);
    for (const key of ['id', 'name', 'description']) assert.equal(actual[key], p[key]);
  }
  const sent = JSON.parse(text(await cli('send-public --content RETAINED_BRIDGE_PROBE_RESULT --no-finalize')));
  assert.equal(sent.message.id, association.assistantMessageId);
  const after = JSON.parse(text(await cli('read-context')));
  assert.equal(after.publicMessages.find(m => m.id === association.assistantMessageId).content, 'RETAINED_BRIDGE_PROBE_RESULT');
  const remaining = trace.publicMessages.slice(-23);
  if (!remaining.some(m => m.id === user.id)) remaining.unshift(user);
  assert.deepEqual(after.publicMessages.filter(m => m.id !== association.assistantMessageId), remaining.map(project));
  await assert.rejects(tool('list_rooms', {}), /^Error: evaluation_callback_route_unavailable$/);
}
module.exports = { bridgeReplacements, bridgeReplacementsHash, startRetainedCaffCallback, probeRetainedCaffTools };
