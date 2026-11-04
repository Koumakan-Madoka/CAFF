// Host-only literal scoring. No model, credentials, repository mutation or Docker.
const test = require('node:test'), assert = require('node:assert/strict');
const { validatePublicReplyRules, scorePublicReply, reviseSnapshotHeadRules, reviseTopicNumberRules } = require('../../scripts/badcase-capture/public-reply-literal-rules.cjs');
const rules = () => ({ kind: 'public-reply-literals-v1', leadChars: 12, conclusionMarkers: ['结论：', '总体来看'], forbiddenTerms: ['内部代号'], forbiddenPatterns: ['priority-code', 'detached-head', 'adr-number', 'commit-hash', 'acceptance-decision-code'] });
const receipt = finalText => ({ success: true, modelCalls: [{ success: true }], replySource: 'public', finalText });
test('a complete conclusion marker must fit within N raw Unicode code points; no markdown/whitespace stripping', () => {
  const r = { ...rules(), leadChars: 5, conclusionMarkers: ['结论：'] };
  assert.equal(scorePublicReply(receipt('😀甲结论：继续推进。'), r).pass, true);
  assert.equal(scorePublicReply(receipt('😀甲乙结论：继续推进。'), r).pass, false);
  assert.equal(scorePublicReply(receipt(' \n**结论：**继续'), r).pass, false);
  assert.equal(scorePublicReply(receipt('只是列了资料，没有标记。'), r).pass, false);
});
test('frozen terms and named patterns apply to the whole public reply, case-insensitively for patterns only', () => {
  assert.equal(scorePublicReply(receipt('结论：主线已完成，接下来做定向验证。'), rules()).pass, true);
  for (const tail of ['P1/P2', 'Detached HEAD', 'ADR-0142', '5b22c907', '07A876C9', 'AC4', 'D15', '内部代号']) {
    const score = scorePublicReply(receipt('结论：完成。\n' + tail), rules());
    assert.equal(score.pass, false, tail); assert.equal(score.checks.noForbiddenTerms, false);
    assert.ok(score.details.forbidden.length > 0);
  }
  assert.equal(scorePublicReply(receipt('结论：Goal 与 DAG 的流程有区别，worktree 分别隔离。20261103共12345678项。'), rules()).pass, true);
  assert.equal(scorePublicReply(receipt('结论：版本SDK2、ADRs和ACME不等于内部编号。'), rules()).pass, true);
});
test('internal/no publication cannot substitute for public content; missing fields are unavailable evidence', () => {
  for (const replySource of ['internal', 'none']) assert.equal(scorePublicReply({ ...receipt('结论：完成'), replySource }, rules()).pass, false);
  assert.equal(scorePublicReply(receipt(''), rules()).pass, false);
  assert.equal(scorePublicReply({ ...receipt('结论：完成'), finalText: undefined }, rules()).available, false);
  assert.equal(scorePublicReply({ ...receipt('结论：完成'), replySource: undefined }, rules()).available, false);
  assert.equal(scorePublicReply({ ...receipt('结论：完成'), success: false, pass: true }, rules()).pass, false);
});
test('strict rule schema has bounded lists, no caller-provided regex, and returns a detached copy', () => {
  for (const patch of [{ leadChars: 0 }, { leadChars: 1.5 }, { leadChars: 2049 }, { conclusionMarkers: [] }, { conclusionMarkers: ['x', 'x'] }, { forbiddenPatterns: ['.*'] }, { forbiddenPatterns: ['priority-code', 'priority-code'] }, { forbiddenTerms: [''] }, { extra: true }]) {
    assert.throws(() => validatePublicReplyRules({ ...rules(), ...patch }), /evaluation_rules_invalid/);
  }
  const r = rules(), validated = validatePublicReplyRules(r);validated.conclusionMarkers.push('changed');assert.equal(r.conclusionMarkers.length, 2);
  assert.doesNotThrow(() => validatePublicReplyRules({ ...rules(), forbiddenTerms: [], forbiddenPatterns: [] }));
});
test('new-round topic exemption removes only chosen number patterns; old rules, literal terms, hash and conclusion checks stay intact', () => {
  const old = reviseSnapshotHeadRules(rules(), '5b22c907403916b40dabb435c7271cc155e2e090'), before = structuredClone(old);
  const r = reviseTopicNumberRules(old, ['priority-code', 'adr-number']);
  assert.deepEqual(old, before);assert.equal(scorePublicReply(receipt('结论：ADR-142 按 P1/P2/P3 分阶段。'), old).pass, false);
  assert.equal(scorePublicReply(receipt('结论：ADR-142 按 P1/P2/P3 分阶段。'), r).pass, true);
  for(const text of ['没有标记 P1','结论：AC4','结论：detached HEAD','结论：07a876c9','结论：内部代号'])assert.equal(scorePublicReply(receipt(text),r).pass,false,text);
  assert.equal(scorePublicReply(receipt('结论：P1'),{...r,forbiddenTerms:['P1']}).pass,false);
  for(const patterns of [[],['commit-hash'],['priority-code','priority-code'],['.*']])assert.throws(()=>reviseTopicNumberRules(old,patterns),/evaluation_topic_exemption_invalid/);
});
test('B revision exempts only 7..40 character prefixes of the recorded snapshot HEAD, including uppercase; all other checks stay frozen', () => {
  const head = '5b22c907403916b40dabb435c7271cc155e2e090', old = rules(), before = structuredClone(old);
  const r = reviseSnapshotHeadRules(old, head);
  assert.equal(r.kind, 'public-reply-literals-v2'); assert.equal(r.snapshotHead, head); assert.deepEqual(old, before);
  for (let n = 7; n <= 40; n++) for (const value of [head.slice(0,n), head.slice(0,n).toUpperCase()]) {
    assert.equal(scorePublicReply(receipt('结论：完成。 ' + value), r).pass, true, value);
  }
  for (const tail of [head.slice(0,39) + 'f', 'f' + head.slice(1), '5b22c90 07A876C9', 'P1', 'Detached HEAD', 'ADR-0142', 'AC4', 'D15', '内部代号']) {
    assert.equal(scorePublicReply(receipt('结论：完成。 ' + tail), r).pass, false, tail);
  }
  assert.equal(scorePublicReply(receipt('没有开头标记。 ' + head), r).pass, false);
  assert.equal(scorePublicReply(receipt('结论：完成。 ' + head.slice(0,7)), old).pass, false, 'v1 remains unchanged');
  assert.throws(() => reviseSnapshotHeadRules(old, head.slice(0,7)), /evaluation_rules_invalid/);
  assert.throws(() => validatePublicReplyRules({ ...r, snapshotHead: 'not-a-head' }), /evaluation_rules_invalid/);
});
