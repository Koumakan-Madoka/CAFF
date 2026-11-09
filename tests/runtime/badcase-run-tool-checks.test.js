// Pure run-check contract: no model, shell, file reader or tool executor.
const test = require('node:test'), assert = require('node:assert/strict');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-run-checks');
const fixtures = require('../fixtures/wikiskill-run-tool-call-command-shapes.json').items;
const questions = [{ id: 'reply', question: '回复直接给出结论。', evidence: 'reply' }];
const check = (patch = {}) => ({ method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call',
  rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }], ...patch });
const message = content => ({ role: 'assistant', stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', content });
const text = value => ({ type: 'text', text: value });
const call = (name, args) => ({ type: 'toolCall', id: 'call-' + name, name, arguments: args });
// Single quotes retain real whitespace, unlike JSON's \\n escape in bash.
const inline = (reason, action = 'pause') => call('bash', { command: 'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action ' + action + " --reason '" + reason + "'" });
const send = value => call('bash', { command: 'node "$CAFF_CHAT_TOOLS_PATH" send-public --content ' + JSON.stringify(value) });
function evaluate(output, config, replyStatus = 'pass') {
  const prepared = api().prepareWikiRunChecks(output, config);
  let judgeCalls = 0;
  const final = api().finishWikiRunChecks(prepared, prepared.needsReplyJudge ? (++judgeCalls, replyStatus) : undefined);
  assert.ok(['pass', 'fail', 'invalid'].includes(final.status));
  return { prepared, final, judgeCalls };
}
for (const kind of ['reply', 'tool', 'both']) for (const shape of ['reply', 'target', 'other', 'text+target', 'send+target']) {
  test(`${kind} checks independently see ${shape}`, () => {
    const blocks = { reply: [text('result')], target: [inline('short')], other: [call('read', { path: 'unexecuted' })],
      'text+target': [text('not a reply when a tool is requested'), inline('short')], 'send+target': [send('result'), inline('short')] }[shape];
    const config = { questions: kind === 'tool' ? [] : questions, ...(kind === 'reply' ? {} : { toolCheck: check() }) };
    const result = evaluate(message(blocks), config);
    // Preserve classifyWikiRunOutput byte-for-byte behavior without tool checks:
    // mixed public/other tools were invalid, and remain invalid in that path.
    const replyReached = shape === 'reply' || shape === 'send+target' && kind === 'both';
    const toolReached = kind !== 'reply' && ['target', 'text+target', 'send+target'].includes(shape);
    assert.equal(result.final.status, replyReached && kind !== 'tool' || toolReached ? 'pass' : 'invalid');
    assert.equal(result.judgeCalls, replyReached && kind !== 'tool' ? 1 : 0);
    assert.equal(result.prepared.reply, replyReached && kind !== 'tool' ? 'result' : null);
  });
}
test('a public reply and target call can each fail independently, but a tool failure suppresses the reply judge', () => {
  const config = { questions, toolCheck: check() };
  const failure = evaluate(message([send('result'), inline('x'.repeat(1001))]), config, 'pass');
  assert.equal(failure.final.status, 'fail'); assert.equal(failure.judgeCalls, 0);
  const replyFailure = evaluate(message([send('result'), inline('short')]), config, 'fail');
  assert.equal(replyFailure.final.status, 'fail'); assert.equal(replyFailure.judgeCalls, 1);
  const missingJudge = evaluate(message([send('result'), inline('short')]), config, 'invalid');
  assert.equal(missingJudge.final.status, 'invalid');
});
test('tool-only pass/fail and both-unconfigured invalid never request a reply judge', () => {
  for (const [reason, status] of [['short', 'pass'], ['x'.repeat(1001), 'fail']]) {
    const result = evaluate(message([inline(reason)]), { questions: [], toolCheck: check() });
    assert.equal(result.final.status, status); assert.equal(result.judgeCalls, 0);
  }
  const result = evaluate(message([text('result')]), { questions: [] });
  assert.equal(result.final.status, 'invalid'); assert.equal(result.judgeCalls, 0);
});
for (const [caseNumber, step, status] of [[21, 27, 'pass'], [21, 28, 'pass'], [22, 29, 'fail'], [22, 30, 'pass'], [23, 44, 'fail'], [23, 45, 'invalid'], [24, 42, 'fail'], [24, 43, 'pass']]) {
  test(`real #${caseNumber} step ${step} inline/pipe/heredoc shape is ${status} without executing it`, () => {
    const source = fixtures.find(f => f.case === caseNumber && f.step === step);
    const result = evaluate(message(source.toolCalls.map((c, i) => ({ type: 'toolCall', id: 'real-' + i, ...c }))), { questions: [], toolCheck: check() });
    assert.equal(result.final.status, status); assert.equal(result.judgeCalls, 0);
    if (status === 'invalid') assert.equal(result.final.reason, 'arguments_unparseable');
  });
}
test('single-quoted and double-quoted inline values, newlines and escaped quotes are literal data', () => {
  for (const command of [
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason \'短理由\'',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action "pause" --reason "短\\\"理由"',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason \'第一行\n第二行\'',
  ]) assert.equal(evaluate(message([call('bash', { command })]), { questions: [], toolCheck: check() }).final.status, 'pass');
});
for (const command of [
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason "$reason"',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason "${reason}"',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason "$(printf hidden)"',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason "`printf hidden`"',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --content-stdin',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason-file /unread/reason.txt',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason "short" < /unread/reason.txt',
  'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason "unterminated',
]) test('unsupported argument syntax cannot pass: ' + command, () => {
  for (const mode of ['on-call', 'forbid']) {
    const result = evaluate(message([send('result'), call('bash', { command })]), { questions, toolCheck: check({ mode }) });
    assert.equal(result.final.status, 'invalid'); assert.equal(result.final.reason, 'arguments_unparseable');
  }
});
test('UTF-16 trim/length matches session-goal new proposal validation, with no silent clipping', () => {
  // session-goal.ts normalizeProposalReason: String(value || '').trim(),
  // reject .length > 1000 (not Unicode code points and not clipText).
  for (const [reason, status] of [['x'.repeat(1000), 'pass'], ['x'.repeat(1001), 'fail'],
    ['  ' + 'x'.repeat(1000) + '\n', 'pass'], ['😀'.repeat(500), 'pass'], ['😀'.repeat(500) + 'x', 'fail']]) {
    assert.equal(evaluate(message([inline(reason)]), { questions: [], toolCheck: check() }).final.status, status);
  }
});
test('the same 1000/1001 inputs agree with the actual session-goal proposal API', () => {
  const { applySessionGoalAction, proposeSessionGoalAction } = require('../../build/server/domain/conversation/session-goal');
  const { wikiToolParameterText } = require(base + 'wiki-tool-check');
  const conversation = { id: 'synthetic-reason-check', type: 'standard', title: 'Synthetic', agents: [], metadata: {}, messages: [] };
  const store = { getConversation: id => id === conversation.id ? conversation : null,
    updateConversation: (id, updates) => (assert.equal(id, conversation.id), Object.assign(conversation, updates)) };
  applySessionGoalAction(store, conversation.id, { action: 'set', objective: 'Synthetic reason boundary',
    acceptanceCriteria: [{ id: 'AC1', statement: 'Only use synthetic data', verifyBy: 'Unit test' }] });
  for (const reason of ['x'.repeat(1000), 'x'.repeat(1001), '  ' + 'x'.repeat(1000) + '\n', '😀'.repeat(500), '😀'.repeat(500) + 'x']) {
    const status = evaluate(message([inline(reason)]), { questions: [], toolCheck: check() }).final.status;
    if (status === 'fail') assert.throws(() => proposeSessionGoalAction(store, conversation.id, { action: 'pause', reason }), error => error.statusCode === 400);
    else {
      const result = proposeSessionGoalAction(store, conversation.id, { action: 'pause', reason });
      assert.equal(result.proposal.reason, wikiToolParameterText(reason));
    }
  }
});
test('both modes check every target invocation; unrelated tools are not a target', () => {
  const forbidden = check({ mode: 'forbid', rules: [{ parameter: 'action', kind: 'forbidden-values', values: ['pause'] }] });
  for (const [blocks, status] of [[[], 'invalid'], [[text('result')], 'pass'], [[call('read', { path: 'file' })], 'pass'],
    [[inline('short', 'complete')], 'pass'], [[inline('short')], 'fail'], [[inline('short', 'complete'), inline('short')], 'fail']]) {
    assert.equal(evaluate(message(blocks), { questions: [], toolCheck: forbidden }).final.status, status);
  }
  for (const calls of [[inline('short'), inline('x'.repeat(1001))], [inline('x'.repeat(1001)), inline('short')]]) {
    assert.equal(evaluate(message(calls), { questions: [], toolCheck: check() }).final.status, 'fail');
  }
});
test('native structured tool parameters support all three rules without interpreting string values as commands', () => {
  const native = check({ target: { kind: 'native', name: 'suggest_goal' }, rules: [
    { parameter: 'reason', kind: 'max-chars', max: 1000 }, { parameter: 'action', kind: 'allowed-values', values: ['complete', 'pause'] },
    { parameter: 'action', kind: 'forbidden-values', values: ['pause'] },
  ] });
  for (const [action, reason, status] of [['complete', 'short', 'pass'], ['pause', 'short', 'fail'], ['clear', 'short', 'fail'], ['complete', 'x'.repeat(1001), 'fail'], ['complete', '$(do not execute)', 'pass']]) {
    assert.equal(evaluate(message([call('suggest_goal', { action, reason })]), { questions: [], toolCheck: native }).final.status, status);
  }
});
test('malformed model envelopes are invalid, empty output is never valid for forbid mode', () => {
  const config = { questions, toolCheck: check({ mode: 'forbid' }) };
  for (const value of [null, { role: 'toolResult', stopReason: 'stop', content: [text('result')] },
    { role: 'assistant', stopReason: 'error', content: [text('result')] }, { role: 'assistant', stopReason: 'length', content: [text('result')] },
    { role: 'assistant', stopReason: 'stop', content: [] }]) {
    const result = evaluate(value, config); assert.equal(result.final.status, 'invalid'); assert.equal(result.judgeCalls, 0);
  }
});
test('closed literal parsing rejects ambiguous flags, shell composition and malformed native arguments', () => {
  for (const command of [
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason short --reason other',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason short && echo other',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason short; echo other',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason sh*rt',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason short > /unwritten/output',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason',
  ]) assert.equal(evaluate(message([call('bash', { command })]), { questions: [], toolCheck: check() }).final.status, 'invalid');
  for (const args of [null, [], 'not a structured object', { reason: { nested: 'not scalar' } }, {}]) {
    const result = evaluate(message([call('suggest_goal', args)]), { questions: [], toolCheck: check({ target: { kind: 'native', name: 'suggest_goal' } }) });
    assert.equal(result.final.status, 'invalid'); assert.equal(result.final.reason, 'arguments_unparseable');
  }
});
test('an explicitly literal variable marker is not expanded; interpolated and escaped syntax never hides an invocation', () => {
  const literal = 'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason \'$not_a_variable\'';
  assert.equal(evaluate(message([call('bash', { command: literal })]), { questions: [], toolCheck: check() }).final.status, 'pass');
  for (const command of [
    'node "$CAFF_CHAT_TOOLS_PATH" "suggest-$kind" --reason short',
    'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason "short" | node -e \'require(process.env.CAFF_CHAT_TOOLS_PATH)\'',
  ]) assert.equal(evaluate(message([call('bash', { command })]), { questions: [], toolCheck: check({ mode: 'forbid' }) }).final.status, 'invalid');
});
test('legacy output compatibility includes send-public heredoc and all no-tool-check paths', () => {
  const classify = require(base + 'wiki-run-replay').classifyWikiRunOutput;
  const publicCall = call('bash', { command: 'cat <<\'PUBLIC_EOF\' | node "$CAFF_CHAT_TOOLS_PATH" send-public --content-stdin\nresult\nPUBLIC_EOF' });
  for (const blocks of [[text('result')], [publicCall], [send('result')], [text('prefix'), inline('short')], [send('result'), inline('short')], [], [call('read', { path: 'data' })]]) {
    const output = message(blocks), legacy = classify(output), result = evaluate(output, { questions });
    assert.equal(result.prepared.reply, legacy.reply);
    assert.equal(result.final.status, legacy.status === 'reached' ? 'pass' : 'invalid');
  }
  assert.equal(evaluate(message([publicCall, inline('short')]), { questions, toolCheck: check() }).final.status, 'pass');
});
test('any CAFF subcommand can be the target, including send-public; its stdin form is unknown', () => {
  const config = { questions: [], toolCheck: check({ target: { kind: 'caff-chat', name: 'send-public' }, rules: [{ parameter: 'content', kind: 'max-chars', max: 5 }] }) };
  assert.equal(evaluate(message([send('short')]), config).final.status, 'pass');
  assert.equal(evaluate(message([send('too long')]), config).final.status, 'fail');
  const heredoc = call('bash', { command: 'cat <<\'PUBLIC_EOF\' | node "$CAFF_CHAT_TOOLS_PATH" send-public --content-stdin\nresult\nPUBLIC_EOF' });
  assert.equal(evaluate(message([heredoc]), config).final.status, 'invalid');
});
test('opaque bash scripts cannot prove a target was not called in forbid mode', () => {
  for (const command of ['node -e \'process.stdout.write("opaque")\'', 'python /unread/script.py', 'echo simple']) {
    const result = evaluate(message([call('bash', { command })]), { questions: [], toolCheck: check({ mode: 'forbid' }) });
    assert.equal(result.final.status, 'invalid'); assert.equal(result.final.reason, 'arguments_unparseable');
  }
});
test('each rule is black-and-white in both modes, with every target invocation checked', () => {
  for (const mode of ['on-call', 'forbid']) for (const [rule, good, bad] of [
    [{ parameter: 'reason', kind: 'max-chars', max: 5 }, 'short', 'longer'],
    [{ parameter: 'reason', kind: 'allowed-values', values: ['short'] }, 'short', 'other'],
    [{ parameter: 'reason', kind: 'forbidden-values', values: ['other'] }, 'short', 'other'],
  ]) {
    const config = { questions: [], toolCheck: check({ mode, rules: [rule] }) };
    assert.equal(evaluate(message([inline(good), inline(good)]), config).final.status, 'pass');
    assert.equal(evaluate(message([inline(good), inline(bad)]), config).final.status, 'fail');
  }
});
test('a known violation dominates an unparseable second invocation in either order', () => {
  const unknown = call('bash', { command: 'node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --reason "$unknown"' });
  for (const blocks of [[unknown, inline('x'.repeat(1001))], [inline('x'.repeat(1001)), unknown]]) {
    const result = evaluate(message(blocks), { questions, toolCheck: check() });
    assert.equal(result.final.status, 'fail'); assert.equal(result.judgeCalls, 0);
  }
});
test('pure checks do not mutate the message, rubric configuration or prepared projection', () => {
  const output = message([send('result'), inline('short')]), config = { questions, toolCheck: check() };
  const before = structuredClone({ output, config }), prepared = api().prepareWikiRunChecks(output, config), saved = structuredClone(prepared);
  api().finishWikiRunChecks(prepared, 'pass'); api().finishWikiRunChecks(prepared, 'fail');
  assert.deepEqual({ output, config }, before); assert.deepEqual(prepared, saved);
});
