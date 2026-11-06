const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(r => setImmediate(r));
function setup(t, fetcher, options = {}) {
  const dom = new JSDOM('<section id="pipeline"></section>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html' });
  t.after(() => dom.window.close()); dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-pipeline.js'), 'utf8'));
  const root = dom.window.document.querySelector('#pipeline'), calls = [];
  const packet = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', complete: false, origin: 'backfill', frozenAt: '2026-11-05T00:00:00Z', source: { conversationId: 'room', messageId: 'msg' },
    markedStep: 1, markedMessage: 'actual full reply', missingReasons: ['original_context_unavailable'], context: { trigger: { message: { content: 'original request' } }, systemPrompt: null, loadedSkillPaths: ['test/SKILL.md'] },
    steps: [{ step: 1, entryId: 'a1', output: { content: [{ type: 'text', text: '<script>unsafe</script> full model text' }] }, toolResults: [{ message: { content: [{ type: 'text', text: 'long-result-' + 'x'.repeat(3000) + ' final-needle' }] } }], durationMs: null }], metrics: {}, scene: null };
  const data = { cases: [
    { id: 'c1', n: 1, kind: 'text-only', split: 'train', actual: 'wrong behavior', expected: 'right', message: 'DO NOT USE EXCERPT', source: { agentId: 'role-family-gpt', conversationTitle: 'Source room' }, traceBundle: { hash: 'a'.repeat(64), origin: 'backfill', complete: false, missingReasons: packet.missingReasons, stepCount: 1 } },
    { id: 'c2', n: 19, kind: 'marked-badcase', split: 'gate', actual: 'scene issue', expected: 'fix', source: { agentId: 'role-family-gpt', conversationTitle: 'Scene room' }, sealedCheckpointId: 'cp', traceBundle: { hash: 'b'.repeat(64), origin: 'backfill', complete: false, missingReasons: ['sealed_marked_turn_not_recorded'], stepCount: 0 } },
    { id: 'c3', n: 4, kind: 'text-only', split: 'test', actual: 'old source', source: { agentId: 'role-family-gpt' } },
    { id: 'c4', n: 17, kind: 'marked-badcase', split: 'train', actual: 'other model', source: { agentId: 'role-family-deepseek' } },
  ], caseStates: [], replayCases: [] };
  const panel = dom.window.CaffShared.createBadcasePipeline({ root, fetchJson: async url => { calls.push(url); return fetcher ? fetcher(url, packet) : { traceBundle: JSON.parse(JSON.stringify(packet)) }; }, ...options });
  panel.render(data);
  async function expand() { const d = root.querySelector('[data-trace-case="c1"]'); d.open = true; d.dispatchEvent(new dom.window.Event('toggle')); await tick(); await tick(); }
  return { root, data, packet, calls, panel, window: dom.window, expand };
}
test('pipeline has truthful stepper, actor groups, two funnels, backfill states and source-only exclusions without writes', t => {
  const h = setup(t); assert.equal(h.calls.length, 0);
  assert.equal(h.root.querySelectorAll('[data-lane]').length, 2);
  assert.equal(h.root.querySelector('[data-case-id="c1"] .stepper').children.length, 9);
  for (const text of ['按下一步分组', '旧题的来源', '非 GPT 来源', '回填部分完成', '历史现场元数据缺失', '评分 v2', 'DeepSeek 推荐尚未生成']) assert.ok(h.root.textContent.includes(text), text);
  assert.doesNotMatch(h.root.textContent, /批准补全|示例.*JEV|已成为测试用例.*[1-9]/);
  assert.equal(h.root.querySelector('[data-case-id="c3"]').closest('[data-actor]').dataset.actor, 'source');
});
test('legacy context reason means missing newer archive, not missing recovered input or reused turns', t => {
  const h = setup(t);
  assert.match(h.root.textContent, /没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复/);
  assert.doesNotMatch(h.root.textContent, /未保存当时的原始上下文/);
  h.data.cases[0].traceBundle.missingReasons = ['context_archive_missing', 'system_prompt_display_redacted', 'provider_request_bytes_missing'];
  h.panel.render(h.data);
  for (const text of ['没有新版上下文归档', '系统提示词为历史展示版', '未保存供应商请求原始字节']) assert.ok(h.root.textContent.includes(text), text);
  assert.equal(h.calls.length, 0);
});
test('expand fetches frozen packet lazily, shows full output/results and exports only from its read-only endpoints', async t => {
  const h = setup(t); await h.expand(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0], '/api/wikiskill/cases/c1/trace');
  const trace = h.root.querySelector('[data-trace-case="c1"]');
  assert.equal(trace.querySelectorAll('[data-trace-section]').length, 3);
  assert.match(trace.textContent, /original request|full model text/); assert.match(trace.textContent, /final-needle/);
  assert.doesNotMatch(trace.textContent, /DO NOT USE EXCERPT/); assert.equal(trace.querySelector('script'), null);
  assert.ok([...trace.querySelectorAll('details.trace-value')].some(d => !d.open));
  assert.equal(trace.querySelector('[data-export="json"]').getAttribute('href'), '/api/wikiskill/cases/c1/trace/export.json');
  assert.equal(trace.querySelector('[data-export="md"]').getAttribute('href'), '/api/wikiskill/cases/c1/trace/export.md');
  const q = trace.querySelector('[data-trace-search]'); q.value = 'final-needle'; q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(trace.querySelector('mark').textContent, 'final-needle'); assert.match(trace.querySelector('[data-trace-matches]').textContent, /1/);
  assert.equal(h.calls.length, 1); assert.equal(h.data.cases[0].message, 'DO NOT USE EXCERPT');
});
test('failed reads never fall back to excerpts and allow an explicit retry', async t => {
  let failing = true; const h = setup(t, (_url, packet) => { if (failing) throw Error('private-path'); return { traceBundle: packet }; });
  await h.expand(); const trace = h.root.querySelector('[data-trace-case="c1"]');
  assert.match(trace.textContent, /读取失败/); assert.doesNotMatch(trace.textContent, /private-path|DO NOT USE EXCERPT/);
  failing = false; trace.querySelector('[data-trace-retry]').click(); await tick(); await tick();
  assert.match(trace.textContent, /full model text/); assert.equal(h.calls.length, 2);
});
test('recommendation is read-only until an explicit user confirmation, then binds IDs and hashes; declined confirmations never write', t => {
  const sent = [], prompts = []; let accept = false;
  const h = setup(t, null, { onConfirmDecision: body => sent.push(body), confirm: message => { prompts.push(message); return accept; } });
  const r = { caseId: 'c1', traceHash: 'a'.repeat(64), hash: 'c'.repeat(64), request: { state: { steps: [{ step: 1, body: '<script>literal</script> decision' }, { step: 2, body: 'public reply' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'single', evidenceVerified: true, cutStepSuggestion: 1, cutSource: 'deepseek', answers: { kind: '单步型', reason: '<script>reason</script>', evidence: '<script>literal</script>' } } };
  h.data.dehydrations = [r]; h.panel.render(h.data);
  assert.equal(h.calls.length, 0); assert.equal(sent.length, 0); assert.match(h.root.querySelector('[data-actor="you"]').textContent, /请确认能否脱水/);
  const host = h.root.querySelector('[data-dehydration="c1"]'); assert.equal(host.querySelector('script'), null); assert.match(host.textContent, /DeepSeek 建议/); assert.match(host.textContent, /程序已核对为该步卡片原文的子串/); assert.doesNotMatch(host.textContent, /90.0%|概率/);
  host.querySelector('[data-dehydration-confirm]').click(); assert.equal(sent.length, 0); accept = true;
  host.querySelector('[data-dehydration-cut]').value = '2'; host.querySelector('[data-dehydration-confirm]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { caseId: 'c1', traceHash: r.traceHash, recommendationHash: r.hash, kind: 'single', cutStep: 2 }); assert.match(prompts.at(-1), /#1.*第 2 步/);
  host.querySelector('[data-dehydration-kind]').value = 'throughout'; host.querySelector('[data-dehydration-confirm]').click(); assert.equal(sent[1].cutStep, null);
  h.panel.setWritable(false); assert.equal(host.querySelector('[data-dehydration-confirm]').disabled, true);
  r.decision = { kind: 'throughout', level: 'reference', cutStep: null, hash: 'd'.repeat(64) }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-dehydration-confirm]'), null); assert.equal(h.root.querySelector('[data-case-id="c1"]').closest('[data-actor]').dataset.actor, 'reference');
  assert.match(h.root.textContent, /已冻结：贯穿型.*只作参考/); assert.equal(h.calls.length, 0);
});
test('frozen user override shows planner provenance without replacing the original DeepSeek judgment', t => {
  const h = setup(t);
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'throughout', cutStepSuggestion: 1, cutSource: 'marked_step_fallback', fallbackReason: 'not_single', evidenceVerified: false,
      answers: { kind: '贯穿型', cutStep: '无', reason: '整段取向', evidence: '' } },
    decision: { kind: 'single', level: 'run', cutStep: 1, hash: 'd'.repeat(64), confirmation: { source: 'user-via-planner', reference: '<script>message</script>' } } }];
  h.panel.render(h.data);
  const host = h.root.querySelector('[data-dehydration="c1"]');
  assert.match(host.textContent, /DeepSeek 建议：贯穿型/); assert.match(host.textContent, /已冻结：单步型.*第 1 步/);
  assert.match(host.textContent, /确认来源：用户经规划者转达/); assert.match(host.textContent, /用户改判/);
  assert.match(host.textContent, /<script>message<\/script>/); assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelector('[data-dehydration-confirm]'), null); assert.equal(h.calls.length, 0);
});
test('run output loads read-only; invalid attempts never fail and original-without-valid-output cases are excluded', async t => {
  const h = setup(t, url => ({ reservation: { request: { context: { tools: [{ name: 'write' }] } } }, result: { message: { content: [{ type: 'text', text: '<script>full output</script>' }] } } }));
  const r = { id: 'e'.repeat(64), caseId: 'c1', traceHash: 'a'.repeat(64), decisionHash: 'd'.repeat(64), variant: { kind: 'original' }, status: 'invalid', baselineStatus: 'no_valid_output', eligibleForScoring: false, caseEligibleForGateAndScreen: false, model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', resultHash: 'f'.repeat(64), modelCalls: 1, toolExecutions: 0 };
  h.data.runReplays = [r, { ...r, id: '1'.repeat(64), status: 'error' }];
  h.data.dehydrations = [{ caseId: 'c1', traceHash: r.traceHash, recommendation: { kindSuggestion: 'single' }, request: { state: { steps: [] } }, decision: { kind: 'single', level: 'run', hash: r.decisionHash } }];
  h.panel.render(h.data); assert.equal(h.calls.length, 0);
  assert.match(h.root.textContent, /无效 1/); assert.match(h.root.textContent, /请求失败 1/); assert.match(h.root.textContent, /不算通过也不算不通过/);
  assert.match(h.root.textContent, /原版无有效输出/); assert.match(h.root.textContent, /不进门槛和初筛/); assert.doesNotMatch(h.root.textContent, /未到达|按不通过计/);
  assert.equal(h.root.querySelector('[data-case-id="c1"] .stepper').children[7].className, 'skip');
  assert.ok(h.root.querySelector('[data-run-export="json"]')); assert.ok(h.root.querySelector('[data-run-export="md"]'));
  const d = h.root.querySelector('[data-run-details]'); d.open = true; d.dispatchEvent(new h.window.Event('toggle')); await tick(); await tick();
  assert.equal(h.calls[0], '/api/wikiskill/cases/c1/run-replays/' + r.id);
  assert.match(d.textContent, /<script>full output<\/script>/); assert.equal(d.querySelector('script'), null);
  assert.match(d.textContent, /write/); assert.equal(h.calls.length, 1);
});
test('user reference-only withdrawal keeps prior confirmation and full run visible but excludes them from current funnel and totals', async t => {
  const h = setup(t, () => ({ reservation: { request: { metadata: { cutStep: 1 } } }, result: { message: { content: [{ type: 'text', text: 'OLD RUN FULL OUTPUT' }] } } }));
  const first = { kind: 'single', level: 'run', cutStep: 1, hash: 'd'.repeat(64), confirmation: { source: 'user-via-planner', reference: 'first-confirmation' } };
  const current = { kind: 'throughout', level: 'reference', cutStep: null, hash: 'f'.repeat(64), supersedesDecisionHash: first.hash,
    reason: '<script>贯穿全程</script>', confirmation: { source: 'user-via-planner', reference: 'user-withdrawal' } };
  h.data.cases[0].n = 12;
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), request: { state: { steps: [{ step: 1, body: 'plan' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'single', cutStepSuggestion: 1, cutSource: 'deepseek', answers: { reason: 'original recommendation', evidence: 'plan' } }, decision: current, decisionHistory: [first] }];
  const oldRun = { id: 'e'.repeat(64), caseId: 'c1', traceHash: 'a'.repeat(64), decisionHash: first.hash, variant: { kind: 'original' }, status: 'invalid', modelCalls: 1, toolExecutions: 0,
    excludedReason: 'user_reclassified_reference', supersededByDecisionHash: current.hash };
  h.data.runReplays = [oldRun]; h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c1"]'); assert.equal(card.closest('[data-actor]').dataset.actor, 'reference');
  assert.match(card.textContent, /已冻结：贯穿型.*只作参考/); assert.match(card.textContent, /已被用户改判，不计入/);
  assert.match(card.textContent, /首次确认|历史确认/); assert.match(card.textContent, /first-confirmation/); assert.match(card.textContent, /original recommendation/);
  assert.match(card.textContent, /<script>贯穿全程<\/script>/); assert.equal(card.querySelector('script'), null);
  assert.match(h.root.querySelector('[data-run-totals]').textContent, /共 0 次.*无效 0/);
  assert.match(h.root.querySelector('[data-run-totals]').textContent, /已被用户改判，不计入.*1 次/);
  assert.match(h.root.querySelector('[data-lane="run"]').textContent, /只作参考/);
  assert.equal(h.root.querySelector('[data-lane="run"] .f-step b').textContent, '0');
  const d = card.querySelector('[data-run-details]'); assert.ok(d); assert.match(d.querySelector('summary').textContent, /已被用户改判，不计入/);
  d.open = true; d.dispatchEvent(new h.window.Event('toggle')); await tick(); await tick();
  assert.match(d.textContent, /OLD RUN FULL OUTPUT/); assert.equal(h.calls.length, 1); assert.equal(card.querySelector('[data-dehydration-confirm]'), null);
});
test('fallback output explains the exact failure and never presents missing answers as a model judgment', t => {
  const h = setup(t);
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'unclear', cutStepSuggestion: 1, cutSource: 'marked_step_fallback', fallbackReason: 'parse_failed', evidenceVerified: false, answers: null } }];
  h.panel.render(h.data); assert.match(h.root.textContent, /两次输出仍无法解析.*回退到发消息步骤，请你挑选/);
  assert.match(h.root.textContent, /未取得可解析答案，不代表模型给出了判断/); assert.doesNotMatch(h.root.textContent, /概率/);
  h.data.dehydrations[0].recommendation.fallbackReason = 'evidence_mismatch'; h.panel.render(h.data);
  assert.match(h.root.textContent, /依据与该步卡片原文不匹配/); assert.equal(h.calls.length, 0);
});
test('regroup proposal shows before/after and exclusions read-only, never claiming a new group is active', t => {
  const h = setup(t); h.data.regroupProposals = [{ status: 'proposed', hash: 'f'.repeat(64), seed: 'fixed-seed', policy: 'trace-run-stratified-v1',
    counts: { trace: { train: 1, gate: 1, test: 0 }, run: { train: 5, gate: 1, test: 0 } }, warnings: ['no_new_trace_test'],
    rows: [{ caseId: 'c1', caseNumber: 1, level: 'run', previousSplit: 'train', proposedSplit: 'gate', reason: null },
      { caseId: 'deleted-case', caseNumber: 7, previousSplit: 'train', proposedSplit: null, reason: 'deleted_missing_system_prompt' }] }];
  h.panel.render(h.data); const panel = h.root.querySelector('[data-regroup-proposal]'); assert.ok(panel);
  assert.match(panel.textContent, /分组提议.*尚未生效/s); assert.match(panel.textContent, /分组前后对照/);
  assert.match(panel.textContent, /没有新的 trace 级测试题/); assert.match(panel.textContent, /#7.*删除/s);
  assert.equal(h.data.cases[0].split, 'train'); assert.equal(h.calls.length, 0);
  assert.match(h.root.querySelector('[data-case-id="c1"]').textContent, /提议：门槛.*尚未生效/);
  assert.equal(panel.querySelector('button'), null, 'no auto-application or intermediate confirmation endpoint');
});
test('unassigned cases are separately listed before/after a proposal, never described as participating or confirmed', t => {
  const h = setup(t); h.data.cases[1].split = null; h.data.cases[1].actual = '<script>pending scene</script>';
  h.panel.render(h.data);
  const pending = () => h.root.querySelector('[data-regroup-pending]');
  assert.ok(pending()); assert.match(pending().textContent, /待分配.*#19/s);
  assert.match(pending().textContent, /不参与本次重新分组/); assert.equal(pending().querySelector('script'), null);
  const card = h.root.querySelector('[data-case-id="c2"]');
  assert.match(card.querySelector('.bc-meta').textContent, /待分配/);
  assert.match(card.querySelector('.steps-detail').textContent, /待分配/);
  h.data.regroupProposals = [{ hash: 'f'.repeat(64), seed: 'fixed', rows: [], warnings: [], counts: { trace: { train: 0, gate: 0, test: 0 }, run: { train: 0, gate: 0, test: 0 } } }];
  h.panel.render(h.data);
  assert.ok(pending()); assert.equal(h.root.querySelector('[data-regroup-proposal] tbody').children.length, 0);
  h.data.regroupConfirmations = [{ status: 'active', hash: 'e'.repeat(64), proposalHash: 'f'.repeat(64), rows: [], counts: h.data.regroupProposals[0].counts, confirmation: {} }];
  h.panel.render(h.data); assert.ok(pending()); assert.match(pending().textContent, /后续分组流程/);
  assert.equal(h.data.cases[1].split, null); assert.equal(h.calls.length, 0);
});
test('confirmed grouping shows original proposal, user adjustment and active groups read-only without claiming scoring readiness', t => {
  const h = setup(t), proposalHash = 'f'.repeat(64), confirmHash = 'e'.repeat(64);
  h.data.cases[0].split = 'gate';
  h.data.cases.push({ id: 'trace20', n: 20, sealedCheckpointId: 'cp20', split: 'test', actual: 'frozen test', source: { agentId: 'role-family-gpt' } });
  const rows = [{ caseId: 'c1', caseNumber: 1, level: 'run', previousSplit: 'train', proposedSplit: 'gate', confirmedSplit: 'gate', reason: null },
    { caseId: 'c2', caseNumber: 19, level: 'trace', previousSplit: 'gate', proposedSplit: 'gate', confirmedSplit: 'gate', confirmationReason: 'frozen_trace_split', reason: null },
    { caseId: 'trace20', caseNumber: 20, level: 'trace', previousSplit: 'test', proposedSplit: 'train', confirmedSplit: 'test', confirmationReason: 'frozen_trace_split', reason: null }];
  h.data.regroupProposals = [{ status: 'proposed', hash: proposalHash, seed: 'fixed-seed', rows, counts: { trace: { train: 1, gate: 1, test: 0 }, run: { train: 0, gate: 1, test: 0 } }, warnings: ['no_new_trace_test'] }];
  h.data.regroupConfirmations = [{ status: 'active', hash: confirmHash, proposalHash, rows, counts: { trace: { train: 0, gate: 1, test: 1 }, run: { train: 0, gate: 1, test: 0 } },
    confirmation: { source: 'user-via-planner', reference: '<script>confirmed-message</script>' }, reason: '组别冻结；#20 仍供评分 v2 测试',
    adjustments: [rows[2]], confirmedAt: '2026-11-05T00:00:00Z' }];
  h.panel.render(h.data); const panel = h.root.querySelector('[data-regroup-confirmed]'); assert.ok(panel);
  assert.match(panel.textContent, /用户确认的分组.*已生效/s); assert.ok(panel.textContent.includes(proposalHash)); assert.ok(panel.textContent.includes(confirmHash));
  assert.match(panel.textContent, /用户经规划者转达/); assert.match(panel.textContent, /原提议/); assert.match(panel.textContent, /保留.*trace.*组别/);
  const r = [...panel.querySelectorAll('tbody tr')].find(r => r.firstElementChild.textContent === '#20'); assert.match(r.textContent, /测试.*训练.*测试/s);
  assert.equal(panel.querySelector('script'), null); assert.match(panel.textContent, /<script>confirmed-message<\/script>/);
  assert.doesNotMatch(panel.textContent, /没有新的 trace 级测试题|分组提议 · 尚未生效/);
  for (const n of [1, 19, 20]) {
    const card = h.root.querySelector('#bc-' + n); assert.match(card.textContent, /用户确认.*组/); assert.doesNotMatch(card.textContent, /尚未生效|等待分组|重新分组待用户确认/);
    assert.equal(card.querySelector('.stepper').children[4].className, 'done');
  }
  assert.match(h.root.textContent, /分组不代表.*判分/); assert.equal(h.calls.length, 0); assert.equal(panel.querySelector('button'), null);
});
test('new checkpoint metadata is shown separately from legacy missing fields and never claims replay success', t => {
  const h = setup(t);
  h.data.cases[1].traceBundle.scene = { metadataStatus: 'recorded', metadataSource: 'checkpoint_git_snapshot_v2', head: 'a'.repeat(40), branch: 'room/test', skippedCount: 0 };
  h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c2"]');
  assert.match(card.textContent, /现场元数据已冻结/); assert.doesNotMatch(card.textContent, /待采集能力合入|现场待接入/);
  assert.equal(card.querySelector('.stepper').children[1].className, 'done');
  assert.equal(card.closest('[data-actor]').dataset.actor, 'system');
  assert.match(card.querySelector('.next-line').textContent, /有现场，走 trace 级/);
  assert.doesNotMatch(card.querySelector('.next-line').textContent, /请确认能否脱水/);
  assert.match(h.root.querySelector('[data-lane="trace"]').textContent, /不能把封存当作已通过回放检查/);
  h.data.cases[1].traceBundle.scene.metadataStatus = 'partial'; h.panel.render(h.data);
  assert.match(h.root.querySelector('[data-case-id="c2"]').textContent, /现场部分记录/);
  assert.equal(h.calls.length, 0);
});
test('sealed scenes show trace-only guidance and never offer recommendation even with stale eligibility', t => {
  const sent = [], h = setup(t, null, { onRequestRecommendation: body => sent.push(body), confirm: () => true });
  h.data.cases[1].dehydrationRecommendation = { eligible: true }; // stale server projection cannot reopen the action
  h.panel.render(h.data); const card = h.root.querySelector('[data-case-id="c2"]');
  assert.equal(card.querySelector('[data-dehydration-recommend]'), null);
  assert.match(card.textContent, /有现场，走 trace 级/); assert.doesNotMatch(card.textContent, /可另选脱水/);
  assert.equal(sent.length, 0); assert.equal(h.calls.length, 0);
});
test('request button is explicit, eligibility-bound, read-only when disabled and never sends automatically', t => {
  const sent = []; let accept = false;
  const h = setup(t, null, { onRequestRecommendation: body => sent.push(body), confirm: () => accept });
  h.data.cases[0].dehydrationRecommendation = { eligible: true };
  h.panel.render(h.data);
  const button = h.root.querySelector('[data-dehydration-recommend="c1"]'); assert.ok(button); assert.equal(button.textContent, '请求推荐');
  assert.equal(h.root.querySelector('[data-dehydration-recommend="c3"]'), null); assert.equal(h.root.querySelector('[data-dehydration-recommend="c4"]'), null);
  assert.equal(sent.length, 0); button.click(); assert.equal(sent.length, 0); accept = true; button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { caseId: 'c1', traceHash: 'a'.repeat(64) });
  h.panel.setWritable(false); assert.equal(button.disabled, true); button.click(); assert.equal(sent.length, 1);
  h.data.cases[0].dehydrationRecommendation = { eligible: false }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-dehydration-recommend="c1"]'), null); assert.equal(h.calls.length, 0);
});
test('unavailable system prompt is disclosed and an ineligible case has no recommendation button', t => {
  const sent = [], h = setup(t, null, { onRequestRecommendation: body => sent.push(body) });
  h.data.cases[0].dehydrationRecommendation = { eligible: false };
  h.data.cases[0].traceBundle.missingReasons = ['system_prompt_unavailable']; h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c1"]');
  assert.match(card.textContent, /系统提示词不可用.*占位文字不能用于脱水或回放/);
  assert.equal(card.querySelector('[data-dehydration-recommend]'), null);
  assert.equal(sent.length, 0); assert.equal(h.calls.length, 0);
});
test('one failed parse offers fallback confirmation OR one manual retry and retains earlier raw evidence', t => {
  const sent = [], h = setup(t, null, { onRequestRecommendation: body => sent.push(body), onConfirmDecision() {}, confirm: () => true });
  h.data.cases[0].dehydrationRecommendation = { eligible: true };
  const first = { caseId: 'c1', traceHash: 'a'.repeat(64), hash: 'c'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
    recommendation: { schemaVersion: 2, retryPolicy: 'manual', kindSuggestion: 'unclear', cutStepSuggestion: 1, cutSource: 'marked_step_fallback', fallbackReason: 'parse_failed', answers: null, attempts: [{ content: 'REAL INVALID JSON' }] } };
  h.data.dehydrations = [first]; h.panel.render(h.data);
  assert.match(h.root.textContent, /本次输出无法解析/); assert.match(h.root.textContent, /默认切在发消息那一步/);
  assert.ok(h.root.querySelector('[data-dehydration-confirm]')); h.root.querySelector('[data-dehydration-recommend]').click();
  assert.equal(sent[0].retryOf, first.hash); assert.equal(sent.length, 1);
  h.data.dehydrations.push({ ...first, hash: 'd'.repeat(64), retryOf: first.hash });
  h.data.cases[0].dehydrationRecommendation = { eligible: false }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-dehydration-recommend]'), null); assert.match(h.root.textContent, /此前推荐.*保留/s);
  assert.ok(h.root.textContent.includes(first.hash)); assert.match(h.root.textContent, /REAL INVALID JSON/);
  assert.equal(h.calls.length, 0);
});
test('stale packet responses after a data refresh cannot replace current evidence', async t => {
  const pending = []; const h = setup(t, () => new Promise(r => { pending.push(r); })); await h.expand();
  h.data.cases[0].traceBundle.hash = 'c'.repeat(64); h.panel.render(h.data);
  pending[0]({ traceBundle: { ...h.packet, markedMessage: 'STALE RESPONSE' } }); await tick(); await tick();
  assert.doesNotMatch(h.root.textContent, /STALE RESPONSE/);
});
