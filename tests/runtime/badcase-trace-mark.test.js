const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createChatAppStore } = require('../../build/lib/chat-app-store');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { createBadcaseFlagService } = require('../../build/server/domain/runtime/badcase-capture/badcase-flags');
const { createBadcaseSealingService } = require('../../build/server/domain/runtime/badcase-capture/sealing-service');
const { createAgentContextSnapshot, materializeAgentContextSnapshot } = require('../../build/server/domain/conversation/turn/context-snapshot');
const sourceModule = () => require('../../build/server/domain/runtime/badcase-capture/wiki-trace-source');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mark-')), agentDir = path.join(root, 'agent');
  const chat = createChatAppStore({ agentDir, sqlitePath: path.join(root, 'chat.sqlite') });
  t.after(() => { chat.close(); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(agentDir, 'named-sessions'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ synthetic: { access: 'synthetic-local-access' } }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { synthetic: { apiKey: '$TEST_TRACE_KEY' } } }));
  const known = () => sourceModule().readTraceKnownKeyValues({ agentDir, chatStore: chat, env: { TEST_TRACE_KEY: 'synthetic-model-value' } });
  const snapshot = () => createAgentContextSnapshot({ conversationId: 'room-a', messageId: 'message-a', agentId: 'agent-a',
    archiveKnownKeyValues: known, sections: [{ sectionKey: 'harness_prompt', title: 'System', content: 'exact system synthetic-local-access abcdef1234567890' },
      { sectionKey: 'conversation_history', title: 'History', content: 'history injected' }] });
  const sessionPath = path.join(agentDir, 'named-sessions/test.jsonl');
  fs.writeFileSync(sessionPath, [{ type: 'session', version: 3, id: 's' },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'user trigger' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'public answer synthetic-model-value' }], usage: { input: 10, output: 20 } } }].map(v=>JSON.stringify(v)).join('\n'));
  chat.saveCustomRoleConfig({ id: 'agent-a', name: 'Synthetic', personaPrompt: 'test' });
  chat.createConversation({ id: 'room-a', title: 'Trace', participants: ['agent-a'], projectScopeId: 'project-a' });
  const createMessage = () => chat.createMessage({ id: 'message-a', conversationId: 'room-a', agentId: 'agent-a', role: 'assistant', status: 'completed',
    content: 'public answer synthetic-model-value', contextSnapshot: snapshot(), metadata: { sessionPath, sessionAssistantStartIndex: 0, sessionAssistantEndIndex: 1, badcaseModelTimings: [{ sequence: 1, responseId: '', durationMs: 25 }] },
    modelUsage: { modelCallCount: 1, calls: [{ durationMs: 25 }] } });
  const wiki = createWikiStore({ globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') });
  const captureStore = { captureRoot: path.join(root, 'capture') };
  const flags = createBadcaseFlagService({ captureRoot: captureStore.captureRoot, chatStore: chat, captureStore });
  const input = { projectId: 'project-a', conversationId: 'room-a', messageId: 'message-a', actual: 'wrong action', expected: 'correct action' };
  const wikiStore = { addMarkedCase: v => wiki.addMarkedCase(v) };
  return { root, agentDir, chat, known, snapshot, sessionPath, wiki, flags, captureStore, input, wikiStore, createMessage };
}
test('snapshot retains known-redacted original separately; Inspector remains a lossy safe projection', t => {
  const h=setup(t), s=h.snapshot();
  assert.equal(s.archiveContext.sections[0].content, 'exact system [*] abcdef1234567890');
  assert.doesNotMatch(JSON.stringify(s), /synthetic-local-access/);
  const inspector=materializeAgentContextSnapshot(s);
  assert.equal(inspector.archiveContext, undefined);
  assert.doesNotMatch(JSON.stringify(inspector), /abcdef1234567890/);
});
test('mark freezes before asynchronous sealing, survives deletion and restart, and retry never rereads session', async t => {
  const h=setup(t); h.createMessage();
  let reads=0;
  const freezeTrace = (input, flag, firstMark) => { reads++; return sourceModule().freezeMarkedCaseTrace({
    wikiStore: h.wiki, chatStore: h.chat, captureStore: h.captureStore, agentDir: h.agentDir, knownKeyValues: h.known }, input, flag, firstMark); };
  const service=createBadcaseSealingService({ flags: h.flags, captureStore: h.captureStore, chatStore: h.chat, wikiStore: h.wikiStore, freezeTrace });
  const pending=service.mark(h.input);
  assert.equal(h.wiki.read().cases.length,1,'packet must already exist before mark yields');
  const item=h.wiki.read().cases[0], packet=h.wiki.readCaseTrace(item.id);
  assert.equal(packet.steps.length,1); assert.equal(packet.markedStep,1); assert.equal(packet.complete,true);
  assert.doesNotMatch(JSON.stringify(packet), /synthetic-local-access|synthetic-model-value/);
  const first=await pending;
  assert.equal(first.trace.traceBundle.hash,item.traceBundle.hash);
  fs.writeFileSync(h.sessionPath,'invalid later continuation');
  await service.mark(h.input); assert.equal(reads,2,'idempotence is inside trace service');
  assert.deepEqual(h.wiki.readCaseTrace(item.id),packet);
  h.chat.deleteConversation('room-a'); fs.unlinkSync(h.sessionPath);
  const rebuilt=createWikiStore({ globalRoot:path.join(h.root,'wiki'),sourceWorktree:path.join(h.root,'source') });
  assert.deepEqual(rebuilt.readCaseTrace(item.id),packet);
});
test('missing sources freeze honest partial records; no checkpoint must not block Wiki archive', async t => {
  const h=setup(t); h.createMessage(); fs.unlinkSync(h.sessionPath);
  const result=sourceModule().freezeMarkedCaseTrace({wikiStore:h.wiki,chatStore:h.chat,captureStore:h.captureStore,agentDir:h.agentDir,knownKeyValues:h.known},h.input,{createdAt:new Date().toISOString()},true);
  const packet=h.wiki.readCaseTrace(result.caseId);
  assert.equal(packet.complete,false); assert.ok(packet.missingReasons.includes('session_missing'));
  assert.equal(packet.scene,null); assert.equal(h.wiki.read().cases[0].sealedCheckpointId,null);
});
test('retry after initial source failure never mislabels later mutable input as the original mark-time freeze', async t => {
  const h = setup(t); h.createMessage(); let available = false;
  const service = createBadcaseSealingService({ flags: h.flags, captureStore: h.captureStore, chatStore: h.chat, wikiStore: h.wikiStore,
    freezeTrace: (input, flag, firstMark) => sourceModule().freezeMarkedCaseTrace({ wikiStore: h.wiki, chatStore: h.chat,
      captureStore: h.captureStore, agentDir: h.agentDir, knownKeyValues() {
        if (!available) throw Error('synthetic failure'); return h.known();
      } }, input, flag, firstMark) });
  assert.equal((await service.mark(h.input)).trace.error, 'wiki_trace_unavailable');
  available = true;
  const retry = await service.mark(h.input);
  assert.equal(retry.trace.error, 'wiki_trace_unavailable');
  assert.equal(h.wiki.read().cases[0].traceBundle, undefined);
});
test('model timing recorder only records assistant calls, preserves failed-call timing and never stores content', () => {
  let now = 10;
  const recorder = sourceModule().createTraceModelTimingRecorder(() => now);
  recorder.observe({ type: 'message_start', message: { role: 'user', content: 'do not store' } });
  now = 20; recorder.observe({ type: 'message_start', message: { role: 'assistant' } });
  now = 45; recorder.observe({ type: 'message_end', message: { role: 'assistant', responseId: 'r1', content: 'do not store' } });
  assert.deepEqual(recorder.snapshot(), [{ sequence: 1, responseId: 'r1', durationMs: 25 }]);
  now = 50; recorder.observe({ type: 'message_start', message: { role: 'assistant' } });
  now = 80; recorder.observe({ type: 'message_end', message: { role: 'assistant', stopReason: 'error' } });
  assert.equal(recorder.snapshot()[1].durationMs, 30);
  assert.doesNotMatch(JSON.stringify(recorder.snapshot()), /do not store/);
});
test('known inventory is nonserializable, read-only, and rejects executable key sources', t => {
  const h=setup(t), inventory=h.known();
  assert.equal(JSON.stringify(inventory),'{}');
  assert.ok(inventory.values.includes('synthetic-model-value'));
  assert.ok(inventory.values.includes('synthetic-local-access'));
  fs.writeFileSync(path.join(h.agentDir,'models.json'),JSON.stringify({providers:{a:{apiKey:'!MUST_NOT_RUN'}}}));
  assert.throws(h.known,e=>e.code==='wiki_trace_known_keys_unavailable');
});
