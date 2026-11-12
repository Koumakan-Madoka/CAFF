// D13/D16 execution path. Same comparison/Docker kernel; no runtime fallback,
// automatic prompt iteration, or pooling across the gate and test partitions.
const crypto = require('node:crypto');
const { runComparison } = require('./direct-comparison.cjs');
const { runSingleCallComparison } = require('./single-call-comparison.cjs');
const { validKey, readCaffDeepseekKey, CODEX_PROFILE } = require('./direct-model.cjs');
const { wikiComparisonTotals: totals } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
const { decideWikiGate } = require('../../build/server/domain/runtime/badcase-capture/wiki-gate-policy');
const {decideWikiExperimentGate,wikiExperimentRun}=require('../../build/server/domain/runtime/badcase-capture/wiki-experiment-plan');
const {assertWikiScoringJudge}=require('./wiki-receipt-scoring.cjs');
const {wikiObjectiveAssertionIds}=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-scoring');
const { wikiGoalCaseNumber } = require('../../build/server/domain/runtime/badcase-capture/wiki-suite');
const fail = code=>Object.assign(Error(code),{code});
async function runStagedBatch(config, plan, options) {
  // Never send v4 through the legacy gate/test policy. The versioned kernel
  // also enforces its own confirmation and fresh current-evidence checks.
  if(plan.summary.kind==='wiki-mode-holdout-comparison-v2')return require('./holdout-validation-batch.cjs').runHoldoutValidationBatch(config,plan,options);
  if(plan.summary.kind==='wiki-mode-holdout-comparison-v1')return require('./holdout-gate-batch.cjs').runHoldoutGateBatch(config,plan,options);
  const judgeFor=item=>config.experiment?.definition?.kind==='wiki-experiment-v2'
    ? (Object.hasOwn(options.judges || {},item.sourceCaseId)?options.judges[item.sourceCaseId]:undefined) : options.judge;
  if(plan.summary.experiment){
    if(!config.experiment?.plan)throw fail('wiki_experiment_confirmation_required');
    for(const c of plan.prepared.filter(c=>c.supported))assertWikiScoringJudge(c.comparisonConfig.scoring,judgeFor(c),{runChecks:c.execution?.level==='run'});
  }
  const emit=options.onEvent || (()=>{}), executionId=crypto.randomUUID(), results=[];
  let key, runtimeHash=null, fatal=false;
  const native=plan.summary.model===CODEX_PROFILE;
  if(!native && plan.prepared.some(c=>c.supported && c.stage==='gate')) {
    key=validKey((options.readKey || readCaffDeepseekKey)());
    const s=JSON.stringify(plan.summary);
    if(s.includes(key) || s.includes(JSON.stringify(key).slice(1,-1))) throw fail('evaluation_output_contains_key');
  }
  emit({event:'batch_plan',...plan.summary,executionId});
  async function executeCase(item, skipReason) {
    let result={sourceCaseId:item.sourceCaseId,split:item.split,stage:item.stage,category:item.category,replayId:item.replayId || null,
      ...(native ? {family:item.family,reportOnly:item.reportOnly,targetReproduction:item.targetReproduction,
        ...(item.classification ? {classification:item.classification} : {}),...(item.topicExemption?{topicExemption:item.topicExemption}:{})} : {}),
      ...(item.execution?{execution:structuredClone(item.execution)}:{}),
      ...(plan.summary.experiment && item.comparisonConfig?.scoring ? {rubric:item.comparisonConfig.scoring.rubric,hardAssertionIds:wikiObjectiveAssertionIds(item.comparisonConfig.rules??{kind:'completion-public-reply-v1'})} : {}),
      comparison:item.comparison || null,status:'not-run',runs:[],modelCallsKnown:0,callsUnavailable:false};
    if(item.reportOnly) result.reason='non_gpt_source_report_only';
    else if(skipReason || fatal) result.reason=skipReason || 'prior_integrity_error';
    else if(!item.supported) { result.status='unsupported';result.reason=item.reason; }
    else {
      const runs=[],calls=new Map();
      try {
        const fresh=require('./batch-comparison.cjs').prepareBatch(config,options);
        if(fresh.summary.planHash!==plan.summary.planHash) throw fail('evaluation_batch_input_changed');
        const compare=item.execution?.level==='run' ? options.runProductionRunComparison || runSingleCallComparison : native ? options.runProductionComparison || runComparison : runComparison;
        const comparison=await compare(item.comparisonConfig,{...options,...(plan.summary.experiment?{judge:judgeFor(item),experimentPlanHash:plan.summary.experiment.planHash}:{}),executionId,confirmed:true,...(native?{}:{readKey:()=>key}),onEvent:event=>{
          if(event.event==='plan') {
            if(runtimeHash!==null && runtimeHash!==event.runtimeHash) throw fail('evaluation_batch_runtime_changed');
            runtimeHash=event.runtimeHash;
          }
          const slot=event.variant+':'+event.iteration;
          if(event.event==='model_call') { if(!calls.has(slot)) calls.set(slot,[]);calls.get(slot).push(event); }
          if(event.event==='run') runs.push({...event,modelCalls:calls.get(slot)||[]});
          emit({...event,sourceCaseId:item.sourceCaseId,stage:item.stage,split:item.split,category:item.category});
        }});
        result={...result,status:comparison.completed?'completed':'error',runs:comparison.runs,
          modelCallsKnown:comparison.modelCallsKnown,callsUnavailable:comparison.callsUnavailable===true};
        fatal ||= comparison.fatal===true;
      } catch (e) {
        // An integrity/staging failure is not a model's failed answer. Preserve
        // known attempts, mark the case incomplete, and stop further execution.
        result={...result,status:'error',reason:/^(evaluation|wiki)_[a-z_]+$/.test(e?.code || '')?e.code:'case_execution_failed',runs,modelCallsKnown:[...calls.values()].reduce((n,a)=>n+a.length,0),callsUnavailable:true};
        fatal=true;
      }
    }
    result.totals=totals([result],plan.summary.repeats);
    results.push(result);emit({event:'case_summary',...result});
  }
  for(const item of plan.prepared.filter(c=>c.stage==='gate')) await executeCase(item);
  const gateDecision=plan.summary.experiment?decideWikiExperimentGate(plan.summary.experiment,results.filter(c=>!c.reportOnly).map(c=>({caseId:c.sourceCaseId,status:c.status,
    runs:c.runs.map(wikiExperimentRun)}))):decideWikiGate(results,plan.summary.evaluation.targetReproductionCaseIds,plan.summary.repeats);
  emit({event:'gate_decision',executionId,candidate:plan.summary.candidate,gateDecision});
  for(const item of plan.prepared.filter(c=>c.stage==='test')) await executeCase(item,gateDecision.outcome==='accepted'?null:'gate_'+gateDecision.outcome);
  const completed=gateDecision.outcome!=='indeterminate' && results.filter(c=>!c.reportOnly && (c.stage==='gate' || gateDecision.outcome==='accepted')).every(c=>c.status==='completed');
  const result={...plan.summary,executionId,runtimeHash,completed,cases:results,gateDecision,
    byStage:Object.fromEntries(['gate','test'].map(s=>[s,totals(results.filter(c=>c.stage===s),plan.summary.repeats)])),
    modelCallsKnown:results.reduce((n,c)=>n+c.modelCallsKnown,0),callsUnavailable:results.some(c=>c.callsUnavailable)};
  emit({event:'batch_summary',...result}); return result;
}
function formatStagedBatch(result, sourceCases, deletedCases) {
  if(result.kind==='wiki-mode-holdout-comparison-v2')return require('./holdout-validation-batch.cjs').formatHoldoutValidationBatch(result, sourceCases, deletedCases);
  if(result.kind==='wiki-mode-holdout-comparison-v1')return require('./holdout-gate-batch.cjs').formatHoldoutGateBatch(result, sourceCases, deletedCases);
  const labels={gate:'门槛',test:'测试'}, categories={reproduction:'复现题',probe:'探针题',control:'防误伤题'};
  const native=result.model===CODEX_PROFILE;
  const d=result.gateDecision, lines=[native?'WikiSkill 生产配置单模式两阶段对照':'WikiSkill 单模式两阶段对照（不作为采纳依据）','计划 '+result.planHash,
    '模型 '+result.model+(native?' / thinking '+result.modelConfig.thinking+' / '+result.modelConfig.api+' / Fast关闭 / SSE':''),
    `门槛判定：${{accepted:'接受',rejected:'拒绝',indeterminate:'无法判定'}[d.outcome]}`,
    `修好：原版 ${d.repair.original.passed}/${d.repair.original.total}，候选 ${d.repair.candidate.passed}/${d.repair.candidate.total}；单侧 Fisher p=${d.repair.pValue ?? 'N/A'} < 0.05；${d.repair.passed?'满足':'不满足'}`,
    `无误伤：原版 ${d.noHarm.original.passed}/${d.noHarm.original.total}，候选 ${d.noHarm.candidate.passed}/${d.noHarm.candidate.total}；少通过 ${d.noHarm.loss} 次，容许 ${d.noHarm.allowedLoss} 次；${d.noHarm.passed?'满足':'不满足'}`];
  if(result.cases?.some(c=>c.runs?.some(r=>r.goalState==='approximate-minimal-v1')))lines.push('Goal 状态近似：独立最小种子，不还原历史 Goal；仅 Goal 工具返回可见，冻结输入不变。');
  if(d.byLevel)for(const level of ['trace','run']){
    const t=d.byLevel[level];lines.push(`${level} 级门槛：原版 ${t.original.passed}/${t.original.total}，候选 ${t.candidate.passed}/${t.candidate.total}；无效 ${t.original.invalid}/${t.candidate.invalid}，错误 ${t.original.errors}/${t.candidate.errors}`);
  }
  if(result.experiment){
    lines.push('评分：硬断言＋AI 裁判；字面指标仅供参考','实验 '+result.experiment.planHash);
    for(const c of result.experiment.cases)lines.push('断言 '+c.caseId+' / '+c.rubricHash+(c.judge?'；裁判 '+c.judge.backend+' / '+c.judge.model
      +' / modelHash '+c.judge.modelHash+' / promptHash '+c.judge.promptHash:'；仅工具检查，无需裁判')
      +(c.traceToolCheck==='structured-v1'?'；工具调用检查按结构化记录判定':c.execution?.level==='run'?'':'；本计划未启用 trace 工具调用检查'));
  }else lines.push('评分：字面规则');
  for(const stage of ['gate','test']) {
    lines.push(labels[stage]+'（单独统计）','用例\t题型\t状态\t原版通过/有效(错误/未执行)\t候选通过/有效(错误/未执行)');
    for(const c of result.cases.filter(c=>c.stage===stage)) lines.push([wikiGoalCaseNumber(c.sourceCaseId) ? '#'+wikiGoalCaseNumber(c.sourceCaseId) : c.sourceCaseId,categories[c.category],c.reportOnly?'非GPT来源，仅报告、不计入结论':c.status+(c.reason?' / '+c.reason:'')+(c.replayId?.startsWith('replay-version-')?' / 样例生产配置新版本，非历史复现':''),...['original','candidate'].map(v=>{const t=c.totals[v];return c.reportOnly?'不计入':`${t.passed}/${t.scored}(${t.errors}/${t.notRun})`+(t.invalid===undefined?'':` 无效${t.invalid}`);})].join('\t'));
    for(const v of ['original','candidate']) {const t=result.byStage[stage][v];lines.push(`${labels[stage]} ${v}: ${t.passed}/${t.planned} 通过，${t.failed} 失败，${t.errors} 环境错误，${t.notRun} 未执行；有效 ${t.scored}，通过率 ${t.passRate===null?'N/A':(100*t.passRate).toFixed(1)+'%'}`);}
  }
  if(result.disclosures?.includes('post_observation_snapshot_head_rule_revision'))lines.push('看过结果后发现，所有已保存回复都会引用现场快照 SHA，这条规则无法区分原版和候选，因此按用户裁决修正规则；旧轮作废，不计入判定。仅放行各题封存现场记录 HEAD 的7–40位前缀，两版本共用新规则，旧规则与结果保留。');
  for(const c of result.cases.filter(c=>c.topicExemption))lines.push(`新轮主题编号豁免 ${wikiGoalCaseNumber(c.sourceCaseId)?'#'+wikiGoalCaseNumber(c.sourceCaseId):c.sourceCaseId}：${c.topicExemption.patterns.join(', ')}；${c.topicExemption.reason}；原版/候选同规则，旧轮不改分。`);
  lines.push(native?(result.experiment?'结论绑定上述生产模型、实验与裁判配置，变更后须整批重跑；小样本不保证提分；非GPT来源、探针和其他模式不计入GPT修好结论。':'结论绑定上述生产模型与配置，变更后须重跑；字面规则不是语义判断，小样本不保证提分；非GPT来源、探针和其他模式不计入GPT修好结论。'):'代理模型 DeepSeek；小样本；题组经原基线筛选，存在挑题偏差；只复现了汇报难懂一类，探针与其他模式只报告。',
    '环境错误每题原/候选共最多补5次；模型循环、超时、超调用上限计不通过。',
    '测试题仅门槛接受后运行一次；被拒改动及 diff 保留，不自动叠加为基线或修改生产 prompt。',
    '已记录模型请求 '+result.modelCallsKnown+(result.callsUnavailable?'（存在未知/不完整记录）':''));
  return lines.join('\n')+'\n';
}
module.exports={runStagedBatch,formatStagedBatch};
