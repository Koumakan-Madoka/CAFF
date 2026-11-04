// Global target pipeline uses the existing host/Docker orchestration. These
// tests spend no model calls or credentials; target substitution uses real seals.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { getGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { prepareSealedPromptTarget } = require('../../scripts/badcase-capture/sealed-direct-input.cjs');
const { collectWikiCandidateFiles } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const { prepareComparison, runComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const { prepareBatch, runBatch, formatBatch } = require('../../scripts/badcase-capture/batch-comparison.cjs');
const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const targetId = 'global-harness-behavior-v1', target = getGlobalPromptTarget(targetId);
function seal(t, { missingTarget = false, resume = false, baseText = target.baseText } = {}) {
  return fixture(t, resume ? 'resume' : 'fresh', ({ cp, r, config, put }) => {
    config.toolBridgeEnabled = true; config.portableRuntime = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: cp.targetDir, provider: r.runConfig.provider, model: r.runConfig.model, resume, thinking: 'off', fast: false, retireUserScopeSkills: true };
    if (resume) r.sessionLineCount = 2;
    r.promptBlobHash = r.normalizedPromptHash = put('Identity: custom actor\nYour private persona instructions:\nKeep this exact role.\n\nRoom work context:\n- Fixture\n\nRules:\n' + (missingTarget ? 'Unsupported old rules.' : baseText) + '\n- Preserve routing.\n\nRouting instructions:\n- No handoff.\n\nUser: inspect files.');
    const association = { projectId: cp.projectId, conversationId: cp.conversationId, turnId: cp.turnId, agentId: cp.agentId, userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association, assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Fixture', type: 'standard', metadata: {} }, participants: [{ id: cp.agentId, name: 'Actor', description: 'Test' }], publicMessages: [{ id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Inspect files.', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
}
function setup(t, { confirmed = true, tool = false, missingTarget = false, staged = false, resume = false, publicReply = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'global-comparison-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(scope);
  const sources = store.addTextCases(Array.from({ length: 16 }, (_, n) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'history-project-' + n, conversationId: 'history-room', messageId: 'message-' + n, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'Unclear report', expected: 'Unique expected visible outcome number ' + n, message: 'Internal jargon', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  const split = store.setReplaySplit({ caseIds: sources.slice(0, 8).map(c => c.id) });
  // The approved seven-task suite replaces two old training tasks with an
  // already exposed training source. Keep the original 8-source partition and
  // all three holdouts intact; do not require nine evaluation tasks instead.
  const selected = [...sources.filter(c => split.testCaseIds.includes(c.id)),
    ...sources.filter(c => split.trainCaseIds.includes(c.id)).slice(0, 3), sources[8]];
  const train = store.read().cases.filter(c => c.split === 'train').map(c => c.id), guideline = '先核实，再用读者能理解的语言说明结论。';
  const v = store.saveDraft({ caseIds: train, model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Clear', failureMode: 'jargon', symptoms: 'unclear', rootCauseHypothesis: 'audience', guideline, caseIds: train }], unclassified: [] });
  store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  const seals = selected.map(() => seal(t, { missingTarget, resume })), categories = staged ? ['reproduction', 'control', 'control', 'reproduction', 'reproduction', 'probe', 'control'] : ['reproduction', 'reproduction', 'reproduction', 'probe', 'control', 'control', 'control'];
  const rules = publicReply ? { kind: 'public-reply-literals-v1', leadChars: 20, conclusionMarkers: ['done'], forbiddenTerms: ['P2'], forbiddenPatterns: ['commit-hash'] }
    : { kind: 'file-literals-v1', files: [{ path: 'REPORT.md', contains: ['RESULT'], notContains: ['TODO'] }] };
  for (let i = 0; i < 7; i++) {
    // A missing declared target is still an honestly registered old seal. The
    // global evaluation must mark it unsupported, never fall back to its role.
    const prepared = prepareSealedPromptTarget(seals[i].request, targetId);
    store.addReplayCase({ sourceCaseId: selected[i].id, category: categories[i], task: 'Write the current state to REPORT.md.',
      fixture: { commit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'R' + (i + 1), filesHash: 'c'.repeat(64) },
      request: seals[i].request, rules, checkpointHash: missingTarget ? sha(JSON.stringify(seals[i].cp)) : prepared.provenance.checkpointHash });
  }
  const files = collectWikiCandidateFiles(store.read()), candidate = store.createGlobalCandidate({ versionId: v.id, entryIds: [v.entries[0].id], targetId: tool ? 'tool-description-list_rooms' : targetId, files });
  if (confirmed) store.confirmGlobalCandidate({ candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: store.read().revision, files });
  const config = { ...scope, candidateId: candidate.id, repoRoot: root, dependencyRoot: root, image: { imageId: 'sha256:' + '1'.repeat(64) }, cases: selected.map((c, i) => ({ sourceCaseId: c.id, category: categories[i] })) };
  if (staged) { config.repeats = 10; config.evaluation = { kind: 'wikiskill-gate-v1', targetEntryId: 'entry-1', gateCaseIds: selected.slice(3).map(c => c.id), testCaseIds: selected.slice(0,3).map(c => c.id) }; }
  const single = { request: seals[0].request, globalWikiCandidate: { ...scope, candidateId: candidate.id }, repoRoot: root, dependencyRoot: root, image: config.image, repeats: 3, rules, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' };
  const state = { keys: 0, executions: 0, events: [], failAt: 0 }, key = 'synthetic-global-evaluation-key-123456';
  const options = { confirmed: true, readKey: () => { state.keys++; return key; }, onEvent: event => state.events.push(event),
    stage: (_repo, _deps, _image, input) => [{ path: 'probe.cjs', bytes: Buffer.from(JSON.stringify(input)) }, { path: 'runtime/test', bytes: Buffer.from('fixed-runtime') }],
    execute: async (_image, files, opts) => {
      state.executions++; assert.equal(opts.key, key); assert.equal(opts.network, 'bridge');
      const m = manifestFor(files), input = JSON.parse(files[0].bytes), failed = state.executions === state.failAt, text = 'RESULT';
      return { code: 0, cleaned: true, containerId: 'a'.repeat(64), isolation: { privileged: false }, receipt: { kind: 'direct-caff-turn-v1', inputHash: m.inputHash, runtimeHash: m.runtimeHash, success: !failed,
        beforeHash: expectedTreeHash(input), afterHash: expectedTreeHash(input), replySource: 'public', finalText: 'done', toolCalls: [], recordedModelConfig: input.recordedModelConfig,
        ...(input.sessionText ? { replaySession: require('../../scripts/badcase-capture/direct-model.cjs').replaySessionInfo(input.sessionText) } : {}),
        fileEvidence: [{ path: 'REPORT.md', state: 'file', base64: Buffer.from(text).toString('base64'), sha256: sha(text), size: text.length }],
        modelCalls: [{ model: 'deepseek/deepseek-v4-flash', durationMs: 1, success: !failed, usage: null }] } };
    } };
  const plan = () => prepareBatch(config, options), run = () => runBatch(config, { ...options, expectedPlanHash: plan().summary.planHash });
  return { root, store, sources, split, seals, candidate, config, single, state, options, plan, run, guideline };
}
test('old and manually merged real seals both carry the adopted baseline on both arms, with only one new candidate change', t => {
  const h = setup(t), snapshot = h.store.read(), review = { id: 'review-fixture', comparisonId: 'comparison-' + 'a'.repeat(64), candidateId: h.candidate.id, candidateHash: h.candidate.candidateHash, targetId, decision: 'adopted', baselineChanged: true, createdAt: '2026-11-04T00:00:00Z' };
  // Seed operator-owned adoption metadata; review creation itself is covered by
  // production-batch tests. Target preparation below reads real immutable seals.
  snapshot.baselines.push(require('../../build/server/domain/runtime/badcase-capture/wiki-baseline').buildWikiBaseline(snapshot, h.candidate, review)); snapshot.comparisonReviews.push(review); snapshot.revision++;
  fs.writeFileSync(path.join(h.config.globalRoot, 'snapshots', String(snapshot.revision).padStart(12, '0') + '.json'), JSON.stringify({ schemaVersion: 1, checksum: sha(JSON.stringify(snapshot)), record: snapshot }));
  const train = snapshot.versions[0].caseIds, v = h.store.saveDraft({ caseIds: train, model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Impact', failureMode: 'jargon', symptoms: 'unclear', rootCauseHypothesis: 'audience', guideline: '先说明用户影响，再按需给出证据。', caseIds: train }], unclassified: [] });
  h.store.review({ versionId: v.id, entryId: 'entry-1', expectedRevision: h.store.read().revision, decision: 'approved' });
  const candidate = h.store.createGlobalCandidate({ versionId: v.id, entryIds: ['entry-1'], targetId, files: [] }); h.store.confirmGlobalCandidate({ candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: h.store.read().revision, files: [] });
  const c = { ...h.single, globalWikiCandidate: { ...h.single.globalWikiCandidate, candidateId: candidate.id } };
  const originalSeal = prepareSealedPromptTarget(c.request, targetId).input;
  const inputs = [];
  for (const request of [c.request, seal(t, { baseText: h.candidate.candidateText }).request]) {
    const p = prepareComparison({ ...c, request }, h.options); assert.equal(p.supported, true);
    assert.equal(p.inputs.original.prompt, originalSeal.prompt.replace(target.baseText, h.candidate.candidateText));
    assert.equal(p.inputs.candidate.prompt, p.inputs.original.prompt.replace(h.candidate.candidateText, candidate.candidateText));
    assert.deepEqual({ ...p.inputs.original, prompt: '' }, { ...p.inputs.candidate, prompt: '' });
    assert.equal(p.inputs.original.prompt.split(h.candidate.appendedSection).length - 1, 1);
    assert.equal(p.inputs.candidate.prompt.split(h.candidate.appendedSection).length - 1, 1);
    assert.equal(p.inputs.candidate.prompt.split(candidate.appendedSection).length - 1, 1); inputs.push(p);
  }
  assert.equal(inputs[0].inputs.original.prompt, inputs[1].inputs.original.prompt);
  assert.equal(inputs[0].summary.promptBaseline.alreadyMerged, false); assert.equal(inputs[1].summary.promptBaseline.alreadyMerged, true);
  assert.equal(inputs[0].summary.promptBaseline.baseHash, h.candidate.candidateHash); assert.equal(inputs[1].summary.promptBaseline.appliedToBothVariants, true);
  const unknown = seal(t, { baseText: h.candidate.candidateText + '\n\nWikiSkill 已审核准则：\n- 未经采纳。' });
  assert.equal(prepareComparison({ ...c, request: unknown.request }, h.options).supported, false);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('real sealed draft preview is read-only and cannot authorize direct execution, even if a caller forwards the preview option', async t => {
  const h=setup(t,{confirmed:false}),before=h.store.read();
  assert.throws(()=>prepareComparison(h.single,h.options),/wiki_candidate_confirmation_required/);
  const p=prepareComparison(h.single,{...h.options,allowDraftCandidate:true});assert.equal(p.supported,true);assert.equal(p.summary.candidateConfirmationRequired,true);assert.ok(p.inputs.candidate.prompt.includes(h.guideline));assert.deepEqual(h.store.read(),before);
  await assert.rejects(runComparison(h.single,{...h.options,allowDraftCandidate:true}),/wiki_candidate_confirmation_required/);assert.equal(h.state.keys,0);assert.equal(h.state.executions,0);
});
test('registered global replay freezes public reply rules and scores real callback text without file references in input', async t => {
  const h = setup(t, { publicReply: true });
  assert.ok(h.store.read().replayCases.every(c => c.rules.kind === 'public-reply-literals-v1'));
  const p = prepareComparison(h.single, h.options); assert.equal(p.supported, true);
  assert.equal(p.inputs.original.fileEvidencePaths, undefined);
  const r = await runComparison(h.single, h.options);
  assert.equal(r.totals.original.passed, 3); assert.equal(r.totals.candidate.passed, 3);
  assert.ok(r.runs.every(row => row.replyChecks.conclusionMarker === 'done'));
  assert.ok(r.runs.every(row => row.fileEvidence === undefined));
});
test('D13/D16 global staged suite alternates 10 valid runs, rejects without running tests and has no cross-stage total', async t => {
  const h = setup(t, { staged: true }), before = h.store.read(), p = h.plan();
  assert.equal(p.summary.repeats, 10); assert.equal(p.summary.evaluation.kind, 'wikiskill-gate-v1');
  const r = await h.run();
  assert.equal(h.state.executions,80); assert.equal(r.completed,true); assert.equal(r.gateDecision.outcome,'rejected');
  assert.equal(r.totals,undefined); assert.equal(r.bySplit,undefined); assert.equal(r.byStage.gate.original.passed,40);
  assert.equal(r.byStage.test.original.notRun,30);
  for (const c of r.cases.filter(c=>c.stage==='gate')) assert.deepEqual(c.runs.map(r=>r.variant),Array.from({length:10},()=>['original','candidate']).flat());
  assert.ok(r.cases.filter(c=>c.stage==='test').every(c=>c.reason==='gate_rejected' && !c.runs.length));
  assert.equal(h.state.events.filter(e=>e.event==='gate_decision').length,1); assert.deepEqual(h.store.read(),before);
  assert.match(formatBatch(r),/门槛/); assert.match(formatBatch(r),/测试/); assert.doesNotMatch(formatBatch(r),/总体|合计.*7/);
});
function stagedDriver(h, { improve = false, environment = 0, modelLimit = false, timeout = false } = {}) {
  let current; const emit = h.options.onEvent, execute = h.options.execute;
  h.options.onEvent = e => { if (e.event==='plan') current=e.sourceCaseId; emit(e); };
  h.options.execute = async (...args) => {
    const task = await execute(...args), n = h.state.executions;
    if (n<=environment) return {...task,failed:true,reason:'worker_failed',receipt:undefined};
    if (timeout && n===1) return {...task,failed:true,code:124,reason:'model_timeout',receipt:undefined,inputHash:task.receipt.inputHash,runtimeHash:task.receipt.runtimeHash};
    if (modelLimit && n===1) { task.receipt.success=false; return task; }
    const input=JSON.parse(args[1][0].bytes), candidate=input.prompt.includes(h.guideline);
    if (improve && h.config.cases.find(c=>c.sourceCaseId===current).category==='reproduction' && !candidate) {
      task.receipt.fileEvidence=[{path:'REPORT.md',state:'file',base64:Buffer.from('WRONG').toString('base64'),sha256:sha('WRONG'),size:5}];
    }
    return task;
  };
}
test('acceptance runs test stage exactly once after gate event; decision and separate rates survive store reopen', async t => {
  const { createWikiComparisonStore }=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const h=setup(t,{staged:true}); stagedDriver(h,{improve:true}); const r=await h.run();
  assert.equal(r.gateDecision.outcome,'accepted'); assert.equal(h.state.executions,140);
  const events=h.state.events, at=events.findIndex(e=>e.event==='gate_decision');
  assert.ok(at>0); assert.ok(events.findIndex(e=>e.event==='run' && e.stage==='test')>at);
  assert.equal(r.gateDecision.repair.original.passed,0); assert.equal(r.gateDecision.repair.candidate.passed,20);
  const store=createWikiComparisonStore(h.config), saved=store.save(r);
  assert.equal(saved.totals,undefined); assert.equal(saved.byStage.test.original.planned,30);
  assert.deepEqual(createWikiComparisonStore(h.config).read()[0],saved);
  const forged=structuredClone(r); forged.gateDecision.outcome='rejected'; assert.throws(()=>store.save(forged),/wiki_comparison_invalid/);
});
test('environment errors are separate attempts, at most five extra per question; exhaustion is indeterminate and test is untouched', async t => {
  for (const errors of [1,6]) {
    const h=setup(t,{staged:true}); stagedDriver(h,{environment:errors,improve:true}); const r=await h.run();
    assert.equal(r.byStage.gate.original.errors+r.byStage.gate.candidate.errors,errors);
    assert.ok(r.cases.every(c=>c.runs.length<=25));
    if(errors===1) { assert.equal(r.gateDecision.outcome,'accepted'); assert.equal(h.state.executions,141); assert.equal(r.byStage.gate.original.scored,40); }
    else { assert.equal(r.gateDecision.outcome,'indeterminate'); assert.equal(h.state.executions,85); assert.equal(r.byStage.test.original.attempted,0); assert.equal(r.completed,false); }
    const {createWikiComparisonStore}=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
    const saved=createWikiComparisonStore(h.config).save(r); assert.deepEqual(saved.byStage,r.byStage);
  }
});
test('native proxy failures use shared replacements only with verified launcher evidence; exhausted budget, missing cleanup and drift stop', async t => {
  for (const mode of ['recover', 'exhausted', 'cleanup', 'hash']) {
    const h=setup(t,{staged:true,publicReply:true}),dir=path.join(h.root,'.pi-sandbox');fs.mkdirSync(dir);
    const profile=require('../../scripts/badcase-capture/codex-transport.cjs').PROFILE;
    const access='test.'+Buffer.from(JSON.stringify({exp:2000000600,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.test';
    const authFile=path.join(dir,'auth.json');fs.writeFileSync(authFile,JSON.stringify({'openai-codex':{type:'oauth',access,expires:2000000600000}}));
    Object.assign(h.single,{modelProfile:profile.model,keySource:'caff-codex-access',codexAuthFile:authFile,repeats:10,executionPolicy:'alternating-valid-v1'});
    h.options.knownValues=[];h.options.prepareTarget=(...args)=>{const p=prepareSealedPromptTarget(...args);p.input.recordedModelConfig={provider:'openai-codex',model:'gpt-6.1-sol',thinking:'xhigh',fast:false};return p;};
    let sends=0,executions=0;
    h.options.createCodexTransport=(c,g)=>require('../../scripts/badcase-capture/codex-transport.cjs').createCodexTransport(c,{...g,now:()=>2000000000000,createDispatcher:()=>({destroy:async()=>{}}),fetch:async()=>{if(++sends<=(mode==='exhausted'?6:1))throw Object.assign(new TypeError('PRIVATE '+access),{cause:Object.assign(Error('PRIVATE'),{code:'ECONNRESET'})});return new Response('data: synthetic\n\n');}});
    h.options.executeCodex=async(_image,files,opts)=>{executions++;const m=manifestFor(files,{replayWorkspace:true}),input=JSON.parse(files[0].bytes);
      const launcher={containerId:'a'.repeat(64),cleaned:mode!=='cleanup',isolation:{network:'none'},inputHash:mode==='hash'?'0'.repeat(64):m.inputHash,runtimeHash:m.runtimeHash};
      try{await opts.sendNativeRequest(Buffer.from(JSON.stringify({headers:{'content-type':'application/json',accept:'text/event-stream'},body:Buffer.from(JSON.stringify({model:'gpt-6.1-sol',input:[],stream:true,store:false,reasoning:{effort:'xhigh'}})).toString('base64')})));}
      catch{return {...launcher,failed:true,reason:'evaluation_codex_proxy_failed'};}
      return {...launcher,code:0,receipt:{kind:'direct-caff-turn-v1',inputHash:m.inputHash,runtimeHash:m.runtimeHash,beforeHash:expectedTreeHash(input),success:true,recordedModelConfig:input.recordedModelConfig,modelConfig:{api:profile.api,thinking:'xhigh',fast:false,transport:'sse',credentialDelivery:'host-only-mailbox'},modelCalls:[{model:profile.model,success:true,durationMs:1,httpStatus:200,usage:null}],finalText:'done',replySource:'public'}};
    };
    const r=await runComparison(h.single,h.options);
    assert.equal(r.runs[0].status,'error');assert.equal(r.runs[0].reason,'evaluation_codex_proxy_failed');assert.equal(r.runs[0].environmentDiagnostic.exceptionType,'TypeError');assert.equal(r.runs[0].environmentDiagnostic.code,'ECONNRESET');
    assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);assert.equal(JSON.stringify(r).includes(access),false);
    if(mode==='recover'){assert.equal(executions,21);assert.equal(r.completed,true);assert.equal(r.fatal,false);assert.equal(r.totals.original.errors,1);assert.equal(r.totals.original.passed,10);assert.equal(r.totals.candidate.passed,10);}
    else{assert.equal(executions,mode==='exhausted'?6:1);assert.equal(r.fatal,true);assert.equal(r.completed,false);}
  }
});
test('model loop/request ceiling and proven container model timeout count as fail, not retriable environment error', async t=>{
  for(const mode of ['modelLimit','timeout']) {
    const h=setup(t,{staged:true}); stagedDriver(h,{[mode]:true}); const r=await h.run();
    assert.equal(h.state.executions,80); assert.equal(r.byStage.gate.original.failed,1); assert.equal(r.byStage.gate.original.errors,0);
  }
});
test('staged HTTP environmental failures retain request metering, are replaced, and never count as a model fail',async t=>{
  const h=setup(t,{staged:true}), execute=h.options.execute;
  h.options.execute=async(...args)=>{const task=await execute(...args);if(h.state.executions===1){task.receipt.success=false;task.receipt.modelCalls[0].success=false;task.receipt.modelCalls[0].httpStatus=503;}return task;};
  const r=await h.run(); assert.equal(h.state.executions,81);assert.equal(r.byStage.gate.original.errors,1);assert.equal(r.byStage.gate.original.failed,0);
  assert.equal(r.modelCallsKnown,81);assert.equal(r.callsUnavailable,false);assert.equal(r.gateDecision.outcome,'rejected');
});
test('staged unavailable/corrupt file evidence stops the entire batch, retaining calls and all unrun slots', async t => {
  for (const fault of ['absent', 'unsupported', 'corrupt']) await t.test(fault, async t => {
    const h = setup(t, { staged: true }), execute = h.options.execute;
    h.options.execute = async (...args) => {
      const task = await execute(...args);
      if (fault === 'absent') delete task.receipt.fileEvidence;
      else if (fault === 'unsupported') task.receipt.fileEvidence = [{ path: 'REPORT.md', state: 'unsupported' }];
      else task.receipt.fileEvidence[0].sha256 = '0'.repeat(64);
      return task;
    };
    const r = await h.run(), first = r.cases.find(c => c.stage === 'gate');
    assert.equal(h.state.executions, 1);
    assert.equal(r.completed, false); assert.equal(r.gateDecision.outcome, 'indeterminate');
    assert.equal(first.runs[0].reason, 'file_evidence_unavailable'); assert.equal(first.runs[0].status, 'error');
    assert.equal(r.modelCallsKnown, 1); assert.equal(r.callsUnavailable, false);
    assert.equal(r.byStage.gate.original.errors, 1); assert.equal(r.byStage.gate.original.notRun, 40);
    assert.equal(r.byStage.gate.candidate.notRun, 40); assert.equal(r.byStage.test.original.attempted, 0);
    assert.ok(r.cases.filter(c => c.stage === 'gate').slice(1).every(c => c.reason === 'prior_integrity_error' && !c.runs.length));
    const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
    assert.deepEqual(createWikiComparisonStore(h.config).save(r).byStage, r.byStage);
  });
});
test('staged receipt/launcher hash drift is fatal, not a replaceable environment error', async t => {
  for (const field of ['beforeHash', 'inputHash', 'runtimeHash', 'launcherInputHash', 'launcherRuntimeHash']) await t.test(field, async t => {
    const h = setup(t, { staged: true }), execute = h.options.execute;
    h.options.execute = async (...args) => {
      const task = await execute(...args);
      if (field.startsWith('launcher')) task[field === 'launcherInputHash' ? 'inputHash' : 'runtimeHash'] = '0'.repeat(64);
      else task.receipt[field] = '0'.repeat(64);
      return task;
    };
    const r = await h.run();
    assert.equal(h.state.executions, 1); assert.equal(r.gateDecision.outcome, 'indeterminate');
    assert.equal(r.cases.find(c => c.stage === 'gate').runs[0].reason, 'run_evidence_unavailable');
    assert.equal(r.byStage.test.original.attempted, 0); assert.equal(r.callsUnavailable, true);
  });
});
test('staged recorded thinking evidence missing or changed is fatal, not an environmental replacement', async t => {
  for (const missing of [true, false]) {
    const h = setup(t, { staged: true }), execute = h.options.execute;
    h.options.execute = async (...args) => { const task = await execute(...args);
      if (missing) delete task.receipt.recordedModelConfig; else task.receipt.recordedModelConfig.thinking = 'xhigh'; return task; };
    const r = await h.run(); assert.equal(h.state.executions, 1); assert.equal(r.completed, false);
    assert.equal(r.gateDecision.outcome, 'indeterminate'); assert.equal(r.byStage.test.original.attempted, 0);
    assert.ok(r.cases.filter(c => c.stage === 'gate').slice(1).every(c => c.reason === 'prior_integrity_error'));
  }
});
test('staged project-resource evidence missing or changed is fatal, not an environmental replacement', async t => {
  for (const missing of [true, false]) {
    const h = setup(t, { staged: true }), execute = h.options.execute;
    h.options.prepareTarget = (...args) => { const p = prepareSealedPromptTarget(...args);
      p.input.projectResources = { kind: 'replay-project-resources-v1', manifestHash: '1'.repeat(64), files: [], contextFile: null, skillPaths: [] }; return p; };
    h.options.execute = async (...args) => { const task = await execute(...args);
      if (!missing) task.receipt.projectResources = { kind: 'replay-project-resources-v1', manifestHash: '2'.repeat(64), fileCount: 0,
        contextFile: null, skillPaths: [], verified: true, loadedContextFiles: 0, loadedSkills: 0 }; return task; };
    const r = await runComparison({ ...h.single, repeats: 10, executionPolicy: 'alternating-valid-v1' }, h.options);
    assert.equal(h.state.executions, 1); assert.equal(r.fatal, true); assert.equal(r.completed, false);
    assert.equal(r.runs[0].reason, 'run_evidence_unavailable'); assert.equal(r.totals.original.passed, 0);
  }
});
test('staged resume prefix evidence missing or changed is fatal rather than an environmental replacement', async t => {
  for (const missing of [true, false]) {
    const h = setup(t, { staged: true, resume: true }), execute = h.options.execute;
    h.options.execute = async (...args) => { const task = await execute(...args);
      if (missing) delete task.receipt.replaySession; else task.receipt.replaySession.prefixHash = '0'.repeat(64); return task; };
    const r = await h.run(); assert.equal(h.state.executions, 1); assert.equal(r.completed, false);
    assert.equal(r.gateDecision.outcome, 'indeterminate'); assert.equal(r.byStage.test.original.attempted, 0);
    assert.ok(r.cases.filter(c => c.stage === 'gate').slice(1).every(c => c.reason === 'prior_integrity_error'));
  }
});
test('staged explicit dependency archive/cache/lock/Node drift is fatal, not five environmental replacements', async t => {
  for (const field of ['archiveHash', 'cacheKey', 'lockHash', 'nodeVersion']) await t.test(field, async t => {
    const h = setup(t), cacheRoot = path.join(h.root, 'dependency-cache'); fs.mkdirSync(cacheRoot);
    h.single.image = { ...h.single.image, architecture: 'amd64', nodeVersion: 'v24.21.0' };
    const pkg = { name: 'synthetic-staged-dependencies', version: '1.0.0' };
    const file = (path, value) => { const bytes = Buffer.from(JSON.stringify(value)); return { path, base64: bytes.toString('base64'), sha256: sha(bytes) }; };
    const extras = [file('package.json', pkg), file('package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } })];
    h.options.prepareTarget = (...args) => { const p = prepareSealedPromptTarget(...args); p.input.files.push(...extras); return p; };
    const { cacheReplayDependencies } = require('../../scripts/badcase-capture/replay-dependencies.cjs');
    const input = h.options.prepareTarget(h.single.request, targetId).input, bytes = Buffer.from('synthetic staged cache');
    await cacheReplayDependencies(input, h.single.image, cacheRoot, { runBuild: async (_image, _files, options) => {
      fs.writeFileSync(options.outputFile, bytes); return { code: 0, cleaned: true, receipt: { kind: 'npm-replay-dependencies-v1',
        nodeVersion: h.single.image.nodeVersion, npmVersion: '11.11.1', installCommand: 'npm ci --include=dev --no-audit --no-fund', archiveHash: sha(bytes), modelCalls: 0 } };
    } });
    const execute = h.options.execute;
    h.options.execute = async (...args) => { const task = await execute(...args), wire = JSON.parse(args[1][0].bytes);
      task.receipt.dependencies = { ...wire.dependencies, installed: true, [field]: 'conflicting-synthetic-identity' }; return task; };
    const r = await runComparison({ ...h.single, repeats: 10, executionPolicy: 'alternating-valid-v1',
      dependencies: { kind: 'npm-ci-linux-v1', cacheRoot } }, h.options);
    assert.equal(h.state.executions, 1); assert.equal(r.fatal, true); assert.equal(r.completed, false);
    assert.equal(r.runs[0].reason, 'run_evidence_unavailable'); assert.equal(r.modelCallsKnown, 0);
  });
});
test('staged cleanup uncertainty and plaintext/encoded key leaks remain fatal', async t => {
  for (const fault of ['cleanup', 'plaintext', 'encoded']) await t.test(fault, async t => {
    const h = setup(t, { staged: true }), execute = h.options.execute;
    h.options.execute = async (...args) => {
      const task = await execute(...args);
      if (fault === 'cleanup') task.cleaned = false;
      else if (fault === 'plaintext') task.receipt.finalText = args[2].key;
      else task.receipt.fileEvidence[0].base64 = Buffer.from(args[2].key).toString('base64');
      return task;
    };
    const r = await h.run();
    assert.equal(h.state.executions, 1); assert.equal(r.gateDecision.outcome, 'indeterminate');
    assert.equal(r.byStage.test.original.attempted, 0);
    assert.equal(JSON.stringify(h.state.events).includes('synthetic-global-evaluation-key-123456'), false);
  });
});
test('staged known missing files are ordinary fails, not unavailable evidence or fatal stops', async t => {
  const h = setup(t, { staged: true }), execute = h.options.execute;
  h.options.execute = async (...args) => {
    const task = await execute(...args); task.receipt.fileEvidence = [{ path: 'REPORT.md', state: 'missing' }]; return task;
  };
  const r = await runComparison({ ...h.single, repeats: 10, executionPolicy: 'alternating-valid-v1' }, h.options);
  assert.equal(h.state.executions, 20); assert.equal(r.completed, true); assert.equal(r.fatal, false);
  assert.equal(r.totals.original.failed, 10); assert.equal(r.totals.candidate.failed, 10);
  assert.equal(r.totals.original.errors, 0);
});
test('staged CLI saves a rejected round and its gate event without calling test models or producing an overall total',async t=>{
  const {main}=require('../../scripts/badcase-capture/compare-wiki-batch.cjs');
  const {createWikiComparisonStore}=require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const h=setup(t,{staged:true}),config=path.join(h.root,'config.json'),output=path.join(h.root,'events.jsonl');fs.writeFileSync(config,JSON.stringify(h.config));
  const write=process.stdout.write,code=process.exitCode;let printed='';process.stdout.write=s=>{printed+=s;return true;};
  try {await main(['--config',config,'--run','--confirmed','--expected-plan',h.plan().summary.planHash,'--output',output,'--json'],h.options);}
  finally {process.stdout.write=write;process.exitCode=code;}
  const r=JSON.parse(printed),saved=createWikiComparisonStore(h.config).read()[0];
  assert.equal(r.comparisonId,saved.id);assert.equal(saved.gateDecision.outcome,'rejected');assert.equal(saved.completed,true);
  assert.equal(saved.totals,undefined);assert.equal(saved.byStage.test.original.notRun,30);assert.equal(h.state.executions,80);
  assert.ok(fs.readFileSync(output,'utf8').includes('gate_decision'));
});
test('staged planning pins 10 repetitions, target mode and all gate/test IDs before any key use',t=>{
  const h=setup(t,{staged:true});
  for(const change of [c=>{c.repeats=3;},c=>{c.evaluation.targetEntryId='entry-2';},c=>c.evaluation.gateCaseIds.pop(),c=>{c.evaluation.testCaseIds=c.evaluation.gateCaseIds;}]) {
    const c=structuredClone(h.config);change(c);assert.throws(()=>prepareBatch(c,h.options));
  }
  assert.equal(h.state.keys,0);assert.equal(h.state.executions,0);
});
test('confirmed global candidate changes exactly one shared fragment, not the custom role, callback, files or config', async t => {
  const h = setup(t), before = h.store.read(), p = prepareComparison(h.single, h.options);
  assert.equal(p.supported, true); assert.equal(h.state.keys, 0);
  assert.equal(p.inputs.candidate.prompt, p.inputs.original.prompt.replace(target.baseText, h.candidate.candidateText));
  assert.deepEqual({ ...p.inputs.candidate, prompt: '' }, { ...p.inputs.original, prompt: '' });
  assert.match(p.inputs.candidate.prompt, /Keep this exact role/);
  assert.equal(p.summary.globalWikiCandidate.candidateHash, h.candidate.candidateHash); assert.equal(p.summary.targetId, targetId);
  const r = await runComparison(h.single, h.options); assert.equal(r.completed, true); assert.equal(h.state.executions, 6);
  assert.deepEqual(h.store.read(), before);
});
test('global comparison refuses drafts, tool evaluation, bypass role/text/scope and mismatched target before Key/model access', async t => {
  const draft = setup(t, { confirmed: false }); await assert.rejects(runComparison(draft.single, draft.options), /candidate_confirmation_required/);
  const tool = setup(t, { tool: true }); await assert.rejects(runComparison(tool.single, tool.options), /target_unsupported/);
  const h = setup(t);
  for (const patch of [{ candidateRole: 'bypass' }, { wikiCandidate: { sourceWorktree: h.config.sourceWorktree, candidateId: h.candidate.id } },
    { globalWikiCandidate: { ...h.single.globalWikiCandidate, candidateText: 'bypass' } }, { globalWikiCandidate: { ...h.single.globalWikiCandidate, projectId: 'history-project' } }]) assert.throws(() => prepareComparison({ ...h.single, ...patch }, h.options), /config_invalid/);
  const prepareTarget = (req, id, replacement) => { const p = prepareSealedPromptTarget(req, id, replacement); p.provenance.originalTargetHash = 'e'.repeat(64); return p; };
  assert.throws(() => prepareComparison(h.single, { ...h.options, prepareTarget }), /target_mismatch/);
  assert.equal(h.state.keys + draft.state.keys + tool.state.keys, 0); assert.equal(h.state.executions + draft.state.executions + tool.state.executions, 0);
});
test('global batch derives sealed requests/rules from global registrations, preserves 7 slots and frozen holdout without touching projects', async t => {
  const h = setup(t), before = h.store.read(), p = h.plan();
  assert.equal(p.summary.kind, 'wiki-global-batch-comparison-v1'); assert.equal(p.summary.projectId, undefined);
  assert.equal(p.summary.repeats, 3); assert.equal(p.summary.preparedReplayableCount, 7); assert.equal(p.summary.wikiTrainingCount, 13);
  assert.equal(p.summary.split.testCaseIds.length, 3); assert.equal(p.summary.candidate.targetId, targetId);
  assert.deepEqual(p.summary.split.caseIds, h.split.caseIds); assert.equal(p.summary.excludedSplitTrainingCaseIds.length, 2);
  assert.equal(JSON.stringify(p.summary).includes(h.root), false); assert.equal(h.state.keys, 0);
  const r = await h.run(); assert.equal(r.completed, true); assert.equal(h.state.executions, 42); assert.equal(h.state.keys, 1);
  assert.equal(r.totals.original.planned, 21); assert.equal(r.totals.candidate.passed, 21);
  assert.equal(r.byCategory.reproduction.original.planned, 9); assert.equal(r.byCategory.probe.original.planned, 3); assert.equal(r.byCategory.control.original.planned, 9);
  assert.equal(r.bySplit.test.candidate.planned, 9); assert.equal(r.modelCallsKnown, 42);
  assert.match(formatBatch(r), /复现 original: 9\/9/); assert.match(formatBatch(r), /控制 candidate: 9\/9/); assert.match(formatBatch(r), /探针 original: 3\/3/);
  assert.match(formatBatch(r), /只复现了汇报难懂一类/); assert.deepEqual(h.store.read(), before);
});
test('global batch rejects dropped, duplicate or reclassified slots, caller rules/requests and legacy scope fields before side effects', async t => {
  const h = setup(t), original = h.plan().summary.planHash;
  for (const change of [c => { c.cases = c.cases.filter(i => i.sourceCaseId !== h.split.testCaseIds[0]); }, c => c.cases.push(c.cases[0]), c => { c.cases[0].category = 'control'; }, c => { c.cases[0].request = {}; }, c => { c.cases[0].rules = {}; }, c => { c.projectId = 'p1'; }, c => { c.captureRoot = h.root; }]) {
    const config = structuredClone(h.config); change(config); assert.throws(() => prepareBatch(config, h.options));
  }
  await assert.rejects(runBatch({ ...h.config, repeats: 2 }, { ...h.options, expectedPlanHash: original }), /confirmation_required/);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('missing declared targets keep all 7 denominators, emit unsupported and never spend a Key or substitute a role', async t => {
  const h = setup(t, { missingTarget: true }), r = await h.run();
  assert.equal(r.preparedReplayableCount, 0); assert.equal(r.completed, false); assert.equal(r.cases.length, 7);
  assert.ok(r.cases.every(c => c.status === 'unsupported')); assert.equal(r.totals.original.notRun, 21); assert.equal(r.totals.original.passRate, null);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('missing registrations remain in the confirmed seven-task suite, including holdout and control denominators', async t => {
  const h = setup(t), directory = path.join(h.config.globalRoot, 'snapshots'), file = path.join(directory, fs.readdirSync(directory).filter(n => n.endsWith('.json')).sort().at(-1));
  const envelope = JSON.parse(fs.readFileSync(file));
  const missing = [h.split.testCaseIds[0], h.config.cases.find(c => c.category === 'control' && !h.split.testCaseIds.includes(c.sourceCaseId)).sourceCaseId];
  envelope.record.replayCases = envelope.record.replayCases.filter(c => !missing.includes(c.sourceCaseId));
  envelope.checksum = sha(JSON.stringify(envelope.record)); fs.writeFileSync(file, JSON.stringify(envelope));
  const r = await h.run(); assert.equal(r.completed, false); assert.equal(r.cases.length, 7); assert.equal(r.preparedReplayableCount, 5);
  assert.equal(h.state.executions, 30); assert.equal(r.totals.original.planned, 21); assert.equal(r.totals.original.passed, 15); assert.equal(r.totals.original.notRun, 6);
  assert.equal(r.bySplit.test.original.notRun, 3); assert.equal(r.byCategory.control.original.notRun, 3);
  assert.equal(r.cases.filter(c => c.status === 'unsupported').length, 2); assert.equal(r.totals.original.passRate, 1); assert.equal(r.totals.original.plannedPassRate, 15 / 21);
});
test('a leaked file in the final global case is caught in whole-batch preflight before any Key/model use', async t => {
  const h = setup(t), last = h.plan().prepared.at(-1).comparisonConfig.request.captureRoot;
  h.options.prepareTarget = (request, id, replacement) => {
    const p = prepareSealedPromptTarget(request, id, replacement);
    if (request.captureRoot === last) p.input.files = [{ path: 'leak.txt', base64: Buffer.from(h.guideline).toString('base64'), sha256: sha(h.guideline) }];
    return p;
  };
  assert.throws(() => h.plan(), /candidate_leak/); assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0); assert.equal(h.state.events.length, 0);
});
test('the public batch CLI plans the global seven-task suite without reading a Key, running a model or writing results', t => {
  const h = setup(t), configFile = path.join(h.root, 'config.json'); fs.writeFileSync(configFile, JSON.stringify(h.config));
  const cp = require('node:child_process').spawnSync(process.execPath, [path.resolve('scripts/badcase-capture/compare-wiki-batch.cjs'), '--config', configFile, '--plan'],
    { encoding: 'utf8', env: { ...process.env, CAFF_BADCASE_MODEL_KEY: '', CAFF_BADCASE_MODEL_KEY_FILE: path.join(h.root, 'must-not-read') } });
  assert.equal(cp.status, 0, cp.stderr); const planned = JSON.parse(cp.stdout);
  assert.equal(planned.kind, 'wiki-global-batch-comparison-v1'); assert.equal(planned.planHash, h.plan().summary.planHash);
  assert.equal(planned.preparedOnly, true); assert.equal(planned.dockerVerified, false); assert.equal(planned.cases.length, 7);
  assert.equal(h.state.keys, 0); assert.equal(h.state.executions, 0);
});
test('global result store survives reopen, deduplicates and projects only score/provenance fields without touching wiki revision', async t => {
  const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const h = setup(t), r = await h.run(), before = h.store.read(), store = createWikiComparisonStore(h.config);
  r.cases[0].runs[0].finalText = 'private reply ' + h.root;
  r.cases[0].runs[0].fileEvidence = [{ base64: Buffer.from('private bytes').toString('base64') }];
  r.cases[0].runs[0].isolation = { privileged: false, unknown: h.root };
  r.totals.original.passed = 999; // Stored aggregates are derived from rows, not caller totals.
  const saved = store.save(r), again = store.save(r), reopened = createWikiComparisonStore(h.config).read();
  assert.equal(saved.id, again.id); assert.equal(reopened.length, 1); assert.equal(reopened[0].id, saved.id);
  assert.equal(reopened[0].totals.original.passed, 21); assert.equal(reopened[0].bySplit.test.original.planned, 9);
  assert.equal(reopened[0].byCategory.reproduction.candidate.planned, 9); assert.equal(reopened[0].cases[0].runs.length, 6);
  for (const literal of [h.root, 'private reply', 'private bytes', 'base64', 'finalText', 'unknown']) assert.equal(JSON.stringify(reopened).includes(literal), false);
  assert.deepEqual(h.store.read(), before);
  // A separately requested execution is not collapsed just because its scores match.
  const second = await h.run(); assert.notEqual(store.save(second).id, saved.id); assert.equal(store.read().length, 2);
});
test('persisted partial results keep errors, unknown calls, unsupported and not-run slots; invalid/stale evidence never overwrites', async t => {
  const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const h = setup(t); h.state.failAt = 1; const r = await h.run(), store = createWikiComparisonStore(h.config);
  r.callsUnavailable = r.cases[0].callsUnavailable = true;
  const saved = store.save(r); assert.equal(saved.completed, false); assert.equal(saved.totals.original.errors, 1);
  assert.equal(saved.totals.original.notRun, 20); assert.equal(saved.totals.candidate.notRun, 21); assert.equal(saved.callsUnavailable, true);
  for (const mutate of [c => { c.kind = 'wiki-batch-comparison-v1'; }, c => { c.candidate.candidateHash = 'e'.repeat(64); },
    c => { c.cases[0].runs.push(c.cases[0].runs[0]); }, c => { c.cases[0].runs[0].status = 'skipped'; },
    c => { c.cases[0].sourceCaseId = 'foreign'; }, c => { c.cases[0].split = c.cases[0].split === 'train' ? 'test' : 'train'; }]) {
    const altered = structuredClone(r); mutate(altered); assert.throws(() => store.save(altered), /wiki_comparison_invalid/);
  }
  assert.equal(store.read().length, 1);
  const directory = path.join(h.config.globalRoot, 'comparisons'), file = path.join(directory, fs.readdirSync(directory).find(n => n.endsWith('.json')));
  fs.writeFileSync(file, '{}'); assert.throws(() => store.read(), /wiki_comparison_record_invalid/);
});
test('global CLI execution persists the same summary for the read-only page, including incomplete batches; plan does not write', async t => {
  const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const { main } = require('../../scripts/badcase-capture/compare-wiki-batch.cjs');
  const h = setup(t); h.state.failAt = 1;
  const config = path.join(h.root, 'cli-config.json'), output = path.join(h.root, 'events.jsonl'); fs.writeFileSync(config, JSON.stringify(h.config));
  const write = process.stdout.write, code = process.exitCode; let printed = '';
  process.stdout.write = data => { printed += data; return true; };
  try {
    await main(['--config', config, '--plan'], h.options);
    assert.equal(createWikiComparisonStore(h.config).read().length, 0); assert.equal(h.state.executions, 0);
    printed = '';
    await main(['--config', config, '--run', '--confirmed', '--expected-plan', h.plan().summary.planHash, '--output', output, '--json'], h.options);
    const result = JSON.parse(printed), saved = createWikiComparisonStore(h.config).read()[0];
    assert.equal(result.comparisonId, saved.id); assert.deepEqual(result.totals, saved.totals); assert.equal(saved.completed, false);
    assert.equal(saved.totals.original.errors, 1); assert.equal(h.state.executions, 1);
    assert.ok(fs.readFileSync(output, 'utf8').includes('batch_summary'));
  } finally { process.stdout.write = write; process.exitCode = code; }
});
test('unsupported sealed tasks persist all denominators with N/A and zero executions', async t => {
  const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const h = setup(t, { missingTarget: true }), r = await h.run(), saved = createWikiComparisonStore(h.config).save(r);
  assert.equal(saved.totals.original.notRun, 21); assert.equal(saved.totals.original.passRate, null);
  assert.equal(saved.cases.every(c => c.status === 'unsupported'), true); assert.equal(h.state.executions, 0);
});
test('global HTTP exposes persisted projections read-only after reopen and rejects result injection; corrupt results fail closed', async t => {
  const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
  const h = setup(t), r = await h.run(), store = createWikiComparisonStore(h.config), saved = store.save(r), before = h.store.read();
  const controller = createBadcaseWikiController({ ...h.config, host: '127.0.0.1', port: 4313 });
  const req = { method: 'GET', headers: { host: '127.0.0.1:4313' }, socket: { remoteAddress: '127.0.0.1' } }; let response;
  const res = { writeHead() {}, end(body) { response = JSON.parse(body); } };
  assert.equal(await controller({ req, res, pathname: '/api/wikiskill' }), true);
  assert.equal(response.comparisons[0].id, saved.id); assert.deepEqual(response.comparisons[0].totals, r.totals);
  assert.equal(JSON.stringify(response.comparisons).includes(h.root), false); assert.deepEqual(h.store.read(), before);
  for (const pathname of ['/api/wikiskill/comparisons', '/api/wikiskill/compare', '/api/wikiskill/results']) assert.equal(await controller({ req: { method: 'POST' }, res, pathname }), false);
  const directory = path.join(h.config.globalRoot, 'comparisons'), file = path.join(directory, fs.readdirSync(directory).find(n => n.endsWith('.json')));
  fs.writeFileSync(file, '{}'); await assert.rejects(controller({ req, res, pathname: '/api/wikiskill' }), e => e.statusCode === 409 && e.issues[0].code === 'wiki_comparison_record_invalid');
});
test('global CLI result save failure keeps fsynced evidence and does not rerun models', async t => {
  const { main } = require('../../scripts/badcase-capture/compare-wiki-batch.cjs');
  const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
  const h = setup(t); h.state.failAt = 1;
  const config = path.join(h.root, 'cli-config.json'), output = path.join(h.root, 'events.jsonl'); fs.writeFileSync(config, JSON.stringify(h.config));
  const blocker = path.join(h.config.globalRoot, 'comparisons'); fs.writeFileSync(blocker, 'owned test blocker');
  await assert.rejects(main(['--config', config, '--run', '--confirmed', '--expected-plan', h.plan().summary.planHash, '--output', output], h.options), /wiki_comparison_write_failed/);
  assert.equal(h.state.executions, 1);
  const summary = JSON.parse(fs.readFileSync(output, 'utf8').trim().split('\n').at(-1)); assert.equal(summary.event, 'batch_summary');
  fs.unlinkSync(blocker); const saved = createWikiComparisonStore(h.config).save(summary);
  assert.equal(saved.totals.original.errors, 1); assert.equal(h.state.executions, 1);
});
test('global batch model error stops all remaining slots, retaining per-case/category/holdout error and unexecuted totals', async t => {
  const h = setup(t); h.state.failAt = 1; const r = await h.run();
  assert.equal(r.completed, false); assert.equal(h.state.executions, 1); assert.equal(r.totals.original.errors, 1); assert.equal(r.totals.original.notRun, 20); assert.equal(r.totals.candidate.notRun, 21);
  assert.equal(r.modelCallsKnown, 1); assert.equal(r.callsUnavailable, false);
  assert.equal(r.byCategory.reproduction.original.errors + r.byCategory.probe.original.errors + r.byCategory.control.original.errors, 1);
  assert.equal(r.cases.slice(1).every(c => c.status === 'not-run'), true);
});
