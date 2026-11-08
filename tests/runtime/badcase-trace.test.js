// Synthetic sessions and local SQLite only; never accesses a real account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const trace = () => require('../../build/server/domain/runtime/badcase-capture/wiki-trace');
const source = { projectId: 'project-a', conversationId: 'room-a', messageId: 'message-a', agentId: 'agent-a' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createWikiStore({ globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') });
  const item = store.addMarkedCase({ source: { ...source, conversationTitle: 'Trace test' }, role: source.agentId,
    actual: 'wrong action', expected: 'correct action', message: 'public answer', traceExcerpt: '', traceState: 'missing',
    messageTruncated: false, traceTruncated: false, sealedCheckpointId: null }).case;
  const entry = (id, parentId, message) => ({ type: 'message', id, parentId, message });
  const session = [{ type: 'session', version: 3, id: 'session-a' },
    entry('prior-user', null, { role: 'user', content: 'previous user' }),
    entry('prior-assistant', 'prior-user', { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] }),
    entry('trigger', 'prior-assistant', { role: 'user', content: 'do this turn' }),
    entry('model-1', 'trigger', { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '.agents/skills/test/SKILL.md' } }], usage: { input: 10, output: 20 }, timestamp: 1000 }),
    entry('result-1', 'model-1', { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(60000) + ' synthetic-known-value' }], details: { complete: 'all bytes' }, isError: false, timestamp: 1300 }),
    entry('model-2', 'result-1', { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: "node bridge send-public --content 'public answer'" } }], usage: { input: 30, output: 40 }, timestamp: 1600 }),
    entry('result-2', 'model-2', { role: 'toolResult', toolCallId: 'call-2', toolName: 'bash', content: [{ type: 'text', text: 'posted' }], isError: false, timestamp: 1700 }),
    entry('model-3', 'result-2', { role: 'assistant', content: [{ type: 'text', text: 'private bookkeeping' }], usage: { input: 50, output: 60 }, timestamp: 2000 }),
    // A later continuation and an unrelated branch must not leak into the packet.
    entry('next-user', 'model-3', { role: 'user', content: 'LATER MUST NOT APPEAR' }),
    entry('next-assistant', 'next-user', { role: 'assistant', content: [{ type: 'text', text: 'LATER ANSWER' }] }),
    entry('branch', 'prior-user', { role: 'assistant', content: [{ type: 'text', text: 'OFF BRANCH' }] })];
  const input = { source, frozenAt: '2026-11-05T00:00:00.000Z', origin: 'mark',
    message: { ...source, content: 'public answer', metadata: { sessionAssistantStartIndex: 1, sessionAssistantEndIndex: 4 } },
    sessionText: session.map(e => JSON.stringify(e)).join('\n'),
    snapshot: { archiveContext: { sections: [{ sectionKey: 'harness_prompt', content: 'exact system synthetic-known-value' },
      { sectionKey: 'conversation_history', content: 'injected history' }, { sectionKey: 'conversation_skills', content: 'configured test skill' }] } },
    modelUsage: { calls: [{ durationMs: 10 }, { durationMs: 20 }, { durationMs: 30 }] },
    checkpoint: null, knownKeyValues: ['synthetic-known-value'] };
  return { root, store, item, input, session };
}
test('first freeze archives complete current-turn outputs/results and retained prefix, not later turns or branches', t => {
  const h = fixture(t), packet = trace().buildWikiTraceBundle(h.input);
  assert.equal(packet.steps.length, 3);
  assert.equal(packet.context.trigger.message.content, 'do this turn');
  assert.equal(packet.context.priorSessionEntries.length, 2);
  assert.equal(packet.steps[0].toolResults[0].message.content[0].text.length, 60004);
  assert.equal(packet.steps[0].toolResults[0].message.details.complete, 'all bytes');
  assert.equal(packet.markedStep, 2);
  assert.equal(packet.steps[1].durationMs, 20);
  assert.ok(packet.context.loadedSkillPaths.includes('.agents/skills/test/SKILL.md'));
  const json = JSON.stringify(packet);
  assert.doesNotMatch(json, /LATER|OFF BRANCH|synthetic-known-value/);
  assert.match(json, /exact system \[\*\]/);
  assert.equal(packet.redaction.policy, 'known_values_only');
  assert.equal(packet.redaction.count, 3); // section + systemPrompt projection + tool result
});
test('Wiki owns immutable packet independently from source messages and does not copy it into every snapshot', t => {
  const h = fixture(t), packet = trace().buildWikiTraceBundle(h.input);
  const first = h.store.freezeCaseTrace(h.item.id, packet);
  assert.equal(first.created, true);
  assert.equal(first.traceBundle.hash, crypto.createHash('sha256').update(JSON.stringify(packet)).digest('hex'));
  h.input.message.content = 'changed';
  const retry = h.store.freezeCaseTrace(h.item.id, { ...packet, markedMessage: 'changed' });
  assert.equal(retry.created, false);
  assert.deepEqual(h.store.readCaseTrace(h.item.id), packet);
  assert.equal(h.store.read().revision, 2);
  assert.equal(h.store.read().cases[0].traceBundle.hash, first.traceBundle.hash);
  assert.ok(fs.statSync(path.join(h.root, 'wiki/snapshots/000000000002.json')).size < 10000);
});
test('failed snapshot attachment recovers the already-frozen packet without rebuilding or overwriting it', t => {
  const h = fixture(t), packet = trace().buildWikiTraceBundle(h.input);
  const original = fs.linkSync;
  try {
    fs.linkSync = (from, to) => {
      if (String(to).endsWith('000000000002.json')) throw Object.assign(Error('synthetic disk failure'), { code: 'ENOSPC' });
      return original(from, to);
    };
    assert.throws(() => h.store.freezeCaseTrace(h.item.id, packet), e => e.code === 'wiki_write_failed');
  } finally { fs.linkSync = original; }
  assert.equal(h.store.read().cases[0].traceBundle, undefined);
  h.store.recoverCaseTrace(h.item.id);
  assert.deepEqual(h.store.readCaseTrace(h.item.id), packet);
  assert.equal(fs.readdirSync(path.join(h.root, 'wiki/traces')).length, 1);
});
test('packet corruption fails closed rather than returning an older packet or rebuilding from live state', t => {
  const h = fixture(t), packet = trace().buildWikiTraceBundle(h.input);
  h.store.freezeCaseTrace(h.item.id, packet);
  const files = fs.readdirSync(path.join(h.root, 'wiki/traces'));
  const file = path.join(h.root, 'wiki/traces', files[0]);
  fs.writeFileSync(file, JSON.stringify({ ...packet, markedMessage: 'tampered' }));
  assert.throws(() => h.store.readCaseTrace(h.item.id), e => e.code === 'wiki_trace_invalid');
  assert.throws(() => h.store.freezeCaseTrace(h.item.id, packet), e => e.code === 'wiki_trace_invalid');
});
test('missing originals and redacted Inspector snapshots stay explicit, never claim a complete input', t => {
  const h = fixture(t);
  const packet = trace().buildWikiTraceBundle({ ...h.input, sessionText: null,
    snapshot: { sections: [{ sectionKey: 'harness_prompt', displayContent: 'already [REDACTED]', redacted: true }] } });
  assert.equal(packet.complete, false);
  assert.ok(packet.missingReasons.includes('session_missing'));
  assert.ok(packet.missingReasons.includes('context_archive_missing'));
  assert.ok(packet.missingReasons.includes('system_prompt_display_redacted'));
  assert.ok(packet.missingReasons.includes('provider_request_bytes_missing'));
  assert.ok(!packet.missingReasons.includes('original_context_unavailable'));
  assert.equal(packet.markedStep, null);
  assert.equal(packet.context.sections[0].content, 'already [REDACTED]');
});
test('missing archive does not mean the recovered trigger and reused prefix are missing', t => {
  const h = fixture(t);
  const packet = trace().buildWikiTraceBundle({ ...h.input,
    snapshot: { sections: [{ sectionKey: 'harness_prompt', displayContent: 'historical cwd [REDACTED]', redacted: true, truncated: false }] } });
  assert.equal(packet.context.trigger.message.content, 'do this turn');
  assert.equal(packet.context.priorSessionEntries[0].message.content, 'previous user');
  assert.equal(packet.context.systemPrompt, 'historical cwd [REDACTED]');
  assert.ok(packet.missingReasons.includes('context_archive_missing'));
  assert.ok(packet.missingReasons.includes('system_prompt_display_redacted'));
  assert.ok(!packet.missingReasons.includes('system_prompt_missing'));
  assert.ok(!packet.missingReasons.includes('original_context_unavailable'));
  const absent = trace().buildWikiTraceBundle({ ...h.input, snapshot: null });
  assert.ok(absent.missingReasons.includes('system_prompt_missing'));
  assert.ok(!absent.missingReasons.includes('system_prompt_display_redacted'));
});
test('failed known-key inventory records unavailable system prompt, never promotes the Inspector placeholder', t => {
  const h = fixture(t);
  const { createAgentContextSnapshot } = require('../../build/server/domain/conversation/turn/context-snapshot');
  const snapshot = createAgentContextSnapshot({ sections: [{ sectionKey: 'harness_prompt', content: 'REAL PROMPT MUST NOT PERSIST' }],
    archiveKnownKeyValues() { throw Error('inventory unreadable'); } });
  assert.equal(snapshot.archiveContext.unavailableReason, 'known_key_inventory_unavailable');
  const packet = trace().buildWikiTraceBundle({ ...h.input, snapshot });
  assert.equal(packet.context.systemPrompt, null);
  assert.equal(packet.context.systemPromptSource, 'unavailable');
  assert.equal(packet.context.archiveUnavailableReason, 'known_key_inventory_unavailable');
  assert.ok(packet.missingReasons.includes('system_prompt_unavailable'));
  assert.equal(packet.complete, false);
  assert.match(packet.context.sections[0].content, /上下文未归档/);
  assert.doesNotMatch(JSON.stringify(packet), /REAL PROMPT MUST NOT PERSIST/);
});
test('provider wire bytes are explicitly not captured, without making B2-complete content incomplete', t => {
  const packet = trace().buildWikiTraceBundle(fixture(t).input);
  assert.ok(packet.missingReasons.includes('provider_request_bytes_missing'));
  assert.equal(packet.complete, true); // B2 requires semantic inputs, not provider transport bytes.
  assert.ok(!packet.missingReasons.includes('system_prompt_display_redacted'));
});
test('fallback display sections retain their original truncation disclosure', t => {
  const h = fixture(t);
  const packet = trace().buildWikiTraceBundle({ ...h.input,
    snapshot: { sections: [{ sectionKey: 'harness_prompt', displayContent: 'partial display', truncated: true }] } });
  assert.ok(packet.missingReasons.includes('context_truncated'));
});
test('new reason codes never migrate or rehash an already-frozen legacy packet', t => {
  const h = fixture(t), legacy = trace().buildWikiTraceBundle(h.input);
  legacy.complete = false; legacy.missingReasons = ['original_context_unavailable'];
  const frozen = h.store.freezeCaseTrace(h.item.id, legacy);
  const before = fs.readFileSync(path.join(h.root, 'wiki/traces', fs.readdirSync(path.join(h.root, 'wiki/traces'))[0]));
  const updated = trace().buildWikiTraceBundle(h.input);
  assert.ok(!updated.missingReasons.includes('original_context_unavailable'));
  assert.equal(h.store.freezeCaseTrace(h.item.id, updated).traceBundle.hash, frozen.traceBundle.hash);
  assert.deepEqual(h.store.readCaseTrace(h.item.id), legacy);
  assert.deepEqual(fs.readFileSync(path.join(h.root, 'wiki/traces', fs.readdirSync(path.join(h.root, 'wiki/traces'))[0])), before);
});
test('v2 scene inventory is metadata-only, never guesses current Git and distinguishes detached/partial/missing evidence', t => {
  const h = fixture(t), checkpoint = { schemaVersion: 2, checkpointId: 'cp', files: {}, deletions: [], skipped: [], uncaptured: [],
    gitSnapshot: { kind: 'git-snapshot-v1', head: 'b'.repeat(40), branch: 'room/test', excludedPatterns: ['node_modules/**'], skillInventoryStatus: 'loaded', loadedSkills: [] } };
  const packet = trace().buildWikiTraceBundle({ ...h.input, checkpoint, sceneChanges: [] });
  assert.equal(packet.complete, true); assert.equal(packet.scene.metadataStatus, 'recorded');
  assert.equal(packet.scene.branch, 'room/test'); assert.equal(packet.scene.detached, false); assert.deepEqual(packet.scene.changes, []);
  assert.ok(!packet.missingReasons.some(r => /scene_/.test(r)));
  const noPatch = trace().buildWikiTraceBundle({ ...h.input, checkpoint });
  assert.equal(noPatch.complete, false); assert.equal(noPatch.scene.changes, null);
  assert.ok(noPatch.missingReasons.includes('scene_changes_not_recorded'));
  const legacy = trace().buildWikiTraceBundle({ ...h.input, checkpoint: { schemaVersion: 1, checkpointId: 'old', files: {} } });
  assert.equal(legacy.scene.metadataStatus, 'missing'); assert.equal(legacy.scene.head, null);
  assert.ok(legacy.missingReasons.includes('scene_git_snapshot_missing'));
  const frozen = h.store.freezeCaseTrace(h.item.id, legacy);
  assert.equal(h.store.freezeCaseTrace(h.item.id, packet).traceBundle.hash, frozen.traceBundle.hash);
  assert.deepEqual(h.store.readCaseTrace(h.item.id), legacy);
});
test('known-only replacement is literal, handles JSON escaping and leaves unrecognized patterns unchanged', () => {
  const original = { content: 'password=not-a-known-value sk-SYNTHETIC_UNRECOGNIZED', nested: ['key"\\\nvalue'] };
  const safe = trace().redactTraceKnownValues(original, ['key"\\\nvalue']);
  assert.equal(safe.value.nested[0], '[*]');
  assert.equal(safe.value.content, original.content);
  assert.equal(safe.count, 1);
  assert.equal(original.nested[0], 'key"\\\nvalue');
});
test('broken chains, ambiguous bounds and mismatched source cannot silently become complete packets', t => {
  const h = fixture(t);
  const broken = h.input.sessionText.replace('"parentId":"model-1"', '"parentId":"missing"');
  assert.ok(trace().buildWikiTraceBundle({ ...h.input, sessionText: broken }).missingReasons.includes('session_invalid'));
  const noStart = { ...h.input.message, metadata: {} };
  assert.ok(trace().buildWikiTraceBundle({ ...h.input, message: noStart }).missingReasons.includes('turn_bounds_missing'));
  const packet = trace().buildWikiTraceBundle({ ...h.input, source: { ...source, messageId: 'other-message' } });
  assert.throws(() => h.store.freezeCaseTrace(h.item.id, packet), e => e.code === 'wiki_trace_association_mismatch');
});
