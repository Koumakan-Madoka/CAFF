// @ts-check
(function registerBadcasePipeline() {
  const shared = window.CaffShared || (window.CaffShared = {});
  // Loading is read-only. Only explicit guarded actions request a recommendation
  // or freeze a decision; no automatic calls, retries, replay, grading or regrouping.
  shared.createBadcasePipeline = function ({ root, fetchJson, onConfirmDecision, onRequestRecommendation, onConfirmPatternLabel, onConfirmInitialSplit, onLinkPendingPattern, onPreclassify, onProposeCategories, onConfirmCategory, onRejectCategory, onInductCategory, onReviewCategory, onConfirmControl, confirm: confirmAction = message => window.confirm(message) }) {
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const words = q => String(q || '').slice(0, 512).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 30);
    const matches = (v, ts) => ts.every(t => String(v).toLowerCase().includes(t));
    function hl(v, ts) {
      const s = String(v ?? ''); if (!ts.length) return esc(s);
      const pattern = new RegExp(ts.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
      let out = '', from = 0, m; while ((m = pattern.exec(s))) { out += esc(s.slice(from, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; from = m.index + m[0].length; }
      return out + esc(s.slice(from));
    }
    const json = v => JSON.stringify(v, null, 2);
    const labels = ['标记', '现场', '脱水', '归类', '分组', '断言', '回放检查', '原版预检', '入库'];
    const names = { you: '等你处理', system: '系统可以继续', library: '已入库', stop: '到此为止' };
    const actorBucket = actor => ['you', 'system', 'library'].includes(actor) ? actor : 'stop';
    const splitName = { train: '训练', gate: '门槛', test: '测试' };
    const sceneLabel = scene => scene?.metadataStatus === 'recorded' ? '现场元数据已冻结' : scene?.metadataStatus === 'partial' ? '现场部分记录 · 缺口已披露' : '历史现场元数据缺失';
    const sceneNote = c => sceneLabel(c.traceBundle?.scene);
    const reasonLabels = {
      original_context_unavailable: '没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复',
      context_archive_missing: '没有新版上下文归档', system_prompt_missing: '未保存当时的系统提示词',
      system_prompt_unavailable: '系统提示词不可用：原文归档失败，占位文字不能用于脱水或回放',
      system_prompt_display_redacted: '系统提示词为历史展示版，路径行已占位', provider_request_bytes_missing: '未保存供应商请求原始字节',
      context_truncated: '原上下文曾被截断', model_duration_missing: '未记录逐次模型耗时', model_usage_missing: '未记录模型用量',
      turn_end_inferred_from_usage: '旧轮次终点按调用次数推导', turn_bounds_recovered_from_unique_reply: '旧轮次按唯一回复及父链恢复',
      turn_bounds_missing: '缺少可确认的轮次边界', turn_bounds_invalid: '轮次边界与日志不符', session_missing: '没有对应会话日志',
      session_path_unavailable: '无法定位获准的会话日志', session_invalid: '会话日志格式无法核验', session_outside_instance: '会话日志不在本实例内',
      session_unreadable: '会话日志无法读取', session_too_large: '会话日志超过读取上限', turn_trigger_missing: '无法定位本轮触发消息',
      model_outputs_missing: '没有可确认的当轮模型输出', marked_step_unresolved: '无法定位发出被标记消息的步骤',
      tool_result_missing: '工具结果未保存齐全', orphan_tool_result: '存在无法关联到调用的工具结果',
      sealed_marked_turn_not_recorded: '封存材料未录制被标记的这一轮', sealed_prompt_may_have_controlled_replacements: '封存提示词可能含回放路径占位符',
      scene_metadata_pending_capture_integration: '旧包当时等待采集接入；历史现场元数据未记录（旧包不改）',
      scene_git_snapshot_missing: '旧检查点没有 Git 快照元数据', scene_changes_not_recorded: '无法从冻结补丁取得改动清单',
      scene_files_skipped: '现场有跳过项，详见清单', scene_loaded_skills_missing: '实际加载 skill 清单未录齐',
      scene_head_not_recorded: '现场未记录历史提交', scene_branch_not_recorded: '现场未记录历史分支',
      checkpoint_missing: '未找到原现场清单', checkpoint_unreadable: '原现场清单无法读取', source_message_missing: '未找到原消息', marked_message_truncated: '原回复存档被截断',
    };
    let D = { cases: [], caseStates: [] }, q = '', stage = 'all', model = 'all', currentPattern = null, selected = null;
    const cache = new Map(), expanded = new Set(), queries = new Map(), runCache = new Map();
    let detailSignature = null, splitConsent = null, linkConsent = null, panelSerial = 0;
    const labelForms = new Map(), labelConsents = new Map(), labelErrors = new Map();
    const cutForms = new Map(), cutConsents = new Map(), controlConsents = new Map();
    const categoryForms = new Map(), categoryConsents = new Map(), categoryErrors = new Map(), draftForms = new Map(), draftConsents = new Map(), draftErrors = new Map();
    let writable = [onConfirmDecision, onRequestRecommendation, onConfirmPatternLabel, onConfirmInitialSplit, onLinkPendingPattern, onPreclassify, onProposeCategories, onConfirmCategory, onRejectCategory, onInductCategory, onReviewCategory, onConfirmControl].some(fn => typeof fn === 'function');
    const dehydration = c => (D.dehydrations || []).findLast(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash);
    const excludedRun = (c, r) => dehydration(c)?.decision?.level === 'reference' && dehydration(c)?.decision?.supersedesDecisionHash === r.decisionHash;
    const caseRuns = c => (D.runReplays || []).filter(r => !r.reportOnly && r.caseId === c.id && r.traceHash === c.traceBundle?.hash && (r.decisionHash === dehydration(c)?.decision?.hash || excludedRun(c, r)));
    const frozenRubric = c => (D.rubrics || []).filter(r => r.caseId === c.id && r.status === 'frozen').sort((a, b) => b.version - a.version)[0];
    const reportRows = c => (D.runReplays || []).filter(r => r.reportOnly && !r.excludedReason && r.variant?.kind === 'original' && r.caseId === c.id && r.traceHash === c.traceBundle?.hash && r.decisionHash === dehydration(c)?.decision?.hash && r.rubricHash === frozenRubric(c)?.hash && r.sceneCheckpointId === (c.sealedCheckpointId || null));
    const activeRuns = c => dehydration(c)?.decision?.level === 'run' ? caseRuns(c).filter(r => !excludedRun(c, r)) : [];
    // Match projectWikiRunAccounting: a code-decided pass/fail is also a valid output.
    const validRunOutput = r => ['reached', 'pass', 'fail'].includes(r.status);
    const baselineMissing = c => { const row = (D.pipelineStates || []).find(r => r.caseId === c.id); return row ? row.stopReason === 'invalid_baseline' : activeRuns(c).some(r => r.baselineStatus === 'no_valid_output'); };
    const kindLabel = k => ({ single: '单步型', throughout: '贯穿型', unclear: '说不清（按贯穿型）' }[k] || k);
    const activeGrouping = () => (D.regroupConfirmations || []).findLast(r => r.status === 'active');
    const confirmedGroup = c => {
      const initial = (D.initialSplitConfirmations || []).flatMap(r => r.proposal.rows.filter(row => row.patternKey === r.patternKey && row.proposedSplit)).find(r => r.caseId === c.id);
      return initial ? { ...initial, confirmedSplit: initial.proposedSplit } : activeGrouping()?.rows?.find(r => r.caseId === c.id && !r.reason && r.confirmedSplit);
    };
    const patternLabel = c => (D.casePatterns || []).find(r => r.caseId === c?.id);
    const splitProposal = c => D.initialSplitProposal?.rows.find(r => r.caseId === c.id && r.proposedSplit);
    root.innerHTML = `<div class="groups badcase-pipeline"><section class="sec bc-panel"><h2>从 badcase 到测试用例</h2>
      <div class="howline" aria-label="trace 级还是 run 级怎么定"><span class="how-step">系统自动：这一轮有现场吗</span><span>→ 有：<b>trace 级</b></span><span>｜没有：DeepSeek 推荐 → <b>你决定</b></span><span>→ 单步型：<b>run 级</b></span><span>贯穿型 / 说不清：只作参考</span></div>
      <details><summary class="hint">展开说明</summary><p class="hint">现场在这一轮开始前自动封存。有现场一律走 trace，从这一轮开头执行到自然结束；也可推荐并确认切点，做只调用一次模型的 run 级检查报告，身份和组别不变，不作采纳依据。不恢复现场、不执行工具。无现场经 DeepSeek 推荐、你确认后冻结判断和切点，run 在切点上只调一次模型，不执行工具。原版始终无有效输出的是无效测试用例，不算通过也不算不通过。测试只收 trace；门槛 run 不超过 trace。训练组初筛暂未启用。分组确认不启动回放或评测。</p></details><div class="lanes" data-funnels></div></section>
      <section class="sec bc-panel" data-categories hidden></section>
      <section class="sec bc-panel" data-grouping></section>
      <div class="bc-master-detail"><section class="bc-panel bc-index" aria-label="Badcase 列表"><label class="search"><input data-bc-search type="search" aria-label="搜索 badcase" placeholder="搜索问题、期望、来源房间或编号" autocomplete="off"></label>
      <div class="seg" role="radiogroup" aria-label="按下一步筛选">${[['all', '全部'], ['you', '等你'], ['system', '系统'], ['library', '已入库'], ['stop', '到此为止']].map(([key, name]) => `<button type="button" data-bc-filter="${key}" aria-checked="${key === 'all'}" role="radio">${name}</button>`).join('')}</div>
      <details><summary class="hint">更多筛选</summary><label class="field">模型 <select data-bc-model><option value="all">全部</option><option value="gpt">GPT</option><option value="other">非 GPT</option></select></label></details>
      <p class="hint" data-list-pattern></p><p class="summary" data-bc-summary></p><div class="bc-rows" data-bc-body></div></section><section class="bc-detail" data-bc-detail aria-label="选中用例详情" aria-live="polite"></section></div></div>`;
    const $ = s => root.querySelector(s);
    const isGpt = c => /gpt/i.test(c.source?.agentId || c.role || '');
    const hasScene = c => !!c.sealedCheckpointId;
    const reportCut = c => hasScene(c) && dehydration(c)?.decision?.kind === 'single' && dehydration(c)?.decision?.level === 'run';
    // Goal B8's three immutable historical sources, not their synthetic tests.
    const sourceOnly = c => [4, 10, 14].includes(c.n);
    const levelLabel = c => sourceOnly(c) ? '旧题来源' : hasScene(c) ? 'trace 级 · ' + sceneNote(c) : dehydration(c)?.decision?.level === 'reference' ? '只作参考' : dehydration(c)?.decision?.level === 'run' ? baselineMissing(c) ? 'run 级 · 原版无有效输出' : 'run 级 · 决定已冻结' : '待确认层级（无现场）';
    function backfill(c) {
      const r = c.traceBundle;
      if (!r) return '未归档 · 尚无冻结轨迹包';
      if (r.origin === 'backfill') return r.complete ? '回填完成' : r.stepCount ? '回填部分完成 · 存在缺失' : '无法回填当轮输出 · 已记录原因';
      return r.complete ? '标记时已冻结' : '标记时已冻结 · 存在缺失';
    }
    const pipeline = c => (D.pipelineStates || []).find(r => r.caseId === c.id) || { assertion: { status: 'missing', version: null, model: null, questions: [] }, replay: { status: 'pending' }, original: { valid: 0, unscored: 0, invalid: 0, errors: 0, reproduced: false }, inLibrary: false };
    function assertionText(c) {
      const a = pipeline(c).assertion;
      const tool = frozenRubric(c)?.toolCheck;
      const prefix = a.status !== 'missing' && a.version ? `已冻结 v${a.version} · AI 断言 ${a.questions.length} 条 · ${a.questions.length ? a.model || '打分模型未记录' : '无需 AI 裁判'}${tool ? ' · 工具调用检查已配置（代码判断）' : ''}` : '还没有冻结的断言；可去「用例」页起草并确认';
      return prefix + (a.status === 'incompatible' ? hasScene(c) ? '；trace 级至少需要一种检查（AI 断言或工具调用检查）；需另存一版，旧版保留' : '；run 级的问题只能以回复为依据，需另存一版；旧版保留' : a.status === 'stale' ? '；问题或期望已变，需另存一版' : '') + (a.draftVersion ? `；另有 v${a.draftVersion} 草稿待确认` : '');
    }
    function replayText(c) {
      const r = pipeline(c).replay;
      return r.status === 'supported' ? hasScene(c) ? '封存现场回放预检通过（supported）；不是一次新的执行或复现' : `冻结前缀可构造请求（切点第 ${r.cutStep} 步）；工具定义在正式执行前校验，不执行工具`
        : r.status === 'unsupported' ? `回放检查未通过：${r.reason || '冻结材料不可用'}；不会自动修复或重跑` : hasScene(c) ? '待回放预检：封存现场尚无预检记录；由受信操作方离线检查，本页不还原现场' : '待回放预检：冻结切点前缀尚无预检记录；由受信操作方离线检查，本页不构造请求';
    }
    function originalText(c) {
      const o = pipeline(c).original;
      return o.valid ? `原版 ${o.pass}/${o.valid} 通过 · ${o.fail} 不通过 · 无效 ${o.invalid} · 错误 ${o.errors}；${o.reproduced ? '已复现问题（不通过超过有效次数的一半）' : '未达到复现条件（不通过未超过有效次数的一半）'}；仅此批次，不拼接其他执行`
        : `${o.unscored ? `待判分：原版有效输出 ${o.unscored} 次` : '待复现：还没有与当前冻结断言匹配的有效原版判分'}；无效 ${o.invalid} · 请求/评分错误 ${o.errors}${o.unknown ? ' · 结果未知 ' + o.unknown : ''}；有效输出不等于通过`;
    }
    const precheck = c => pipeline(c).precheck || { status: 'missing', current: null, history: [], reproduced: false };
    const control = c => pipeline(c).control || { status: 'ineligible', confirmed: false, eligible: false };
    const percent = v => typeof v === 'number' && Number.isFinite(v) ? Number((v * 100).toFixed(2)) + '%' : '无有效分母';
    const precheckStatus = s => ({ completed: '已完成', reserved: '结果未知／等待完成', stopped: '已停止', failed: '执行失败' }[s] || s);
    function precheckText(c) {
      const p = precheck(c), r = p.current, s = r?.summary;
      if (!r) return '尚无与当前冻结断言、现场和切点匹配的原版预检；须由受信操作方确认额度后执行，本页不能启动。';
      return `${precheckStatus(r.status)}${r.reason ? ' · ' + ({ usage_unknown: '用量不明', request_limit: '请求次数上限', token_limit: 'token 停止线', operator_interrupted: '操作方停止' }[r.reason] || r.reason) : ''} · ${s ? `原版通过 ${s.pass} · 失败 ${s.fail} · 无效 ${s.invalid} · 错误 ${s.errors}；已尝试 ${s.attempted}/${s.planned}；失败比例 ${percent(s.failureRatio)}` : '尚无结果，不能作准入证据'}；${p.reproduced ? '已复现' : '未复现'}（失败比例须严格超过 ${percent(r.policy.failureThreshold)}，刚好等于不算；未完成不能复现）。`;
    }
    function goalNotes(rows) {
      return (rows || []).filter(r => ['approximate-minimal-v1', 'unseeded'].includes(r.goalState)).map(r => `<p class="hint" ${r.goalState === 'approximate-minimal-v1' ? 'data-goal-approximation' : 'data-goal-unseeded'}>${r.goalState === 'approximate-minimal-v1' ? 'Goal 状态近似：独立最小种子，不还原历史 Goal；与无标记的旧结果是不同回放条件，不直接比较。' : '本次记录为未播种 Goal；不推断历史状态。'} 第 ${esc(r.iteration)} 次 · 种子 hash <span class="mono">${esc(r.goalSeedHash)}</span> · 执行 ${esc(r.goalExecutionId)}</p>`).join('');
    }
    function precheckRecord(r) {
      const s = r.summary;
      return `<article data-precheck-record><p><b>v${esc(r.rubricVersion)} · ${esc(precheckStatus(r.status))}</b> · ${r.reportOnly ? '仅切点报告 · 不作准入' : r.current ? '条件匹配' : '历史条件 · 不作当前准入'}</p><p>${s ? `通过 ${esc(s.pass)} · 失败 ${esc(s.fail)} · 无效 ${esc(s.invalid)} · 错误 ${esc(s.errors)}；有效 ${esc(s.valid)}；失败比例 ${esc(percent(s.failureRatio))}；${s.reproduced ? '该批已复现' : '该批未复现'}` : '尚无结果'}</p>${goalNotes(r.goalExecutions)}<p class="hint">计划 ${esc(r.policy.repeats)} 次 · 复现须严格超过 ${esc(percent(r.policy.failureThreshold))} · 对照通过比例至少 ${esc(percent(r.policy.controlThreshold))}（全部样本须有效）</p><p class="hint">${esc(r.createdAt)}${r.finishedAt ? ' → ' + esc(r.finishedAt) : ''} · ${esc(r.execution.level)}${r.execution.cutStep ? ' · 切点第 ' + esc(r.execution.cutStep) + ' 步' : ''}</p><p class="trace-hash mono">记录 ${esc(r.id)}<br>断言 hash ${esc(r.rubricHash)}<br>计划 hash ${esc(r.planHash)}</p></article>`;
    }
    function precheckPanel(c) {
      const p = precheck(c);
      return `<section class="dehydration-panel" data-original-precheck="${esc(c.id)}"><h4>原版预检（独立证据）</h4><p>${esc(precheckText(c))}</p>${goalNotes(p.current?.goalExecutions)}<p class="hint">预检不进入正式门槛或测试统计；无效和错误不进分母。只跑原版，默认 trace 3 次／run 5 次，可配置。页面不提供启动按钮。</p>${p.history?.length ? `<details data-precheck-history><summary>各版本预检与切点报告（${p.history.length} 批）</summary><p class="hint">各批次独立，不拼接；旧版本、旧现场和报告不作当前准入。</p>${p.history.map(precheckRecord).join('')}</details>` : ''}</section>`;
    }
    const canConfirmControl = c => control(c).status === 'eligible' && control(c).eligible && !!control(c).proposalHash;
    const controlKey = c => json([D.revision, c, pipeline(c), patternLabel(c)]);
    function controlPanel(c) {
      const v = control(c), shown = controlConsents.get(c.id) === controlKey(c), disabled = writable && typeof onConfirmControl === 'function' ? '' : 'disabled';
      const reason = { control_gate_required: '只有门槛组能作对照', control_precheck_required: '当前原版预检尚未达到对照阈值', control_pattern_confirmation_required: '模式身份尚未确认', control_binding_changed: '断言、原版预检或模式身份等绑定已改变' }[v.reason] || '须为门槛组、原版预检达标且模式身份已确认';
      return `<section class="dehydration-panel" data-gate-control="${esc(c.id)}"><h4>门槛防误伤对照</h4><p>${v.status === 'confirmed' ? '已冻结为对照；用于其他模式候选的防误伤检查，不是该模式的目标复现题。' : v.status === 'stale' ? `对照确认已失效：${esc(reason)}；原确认保留，不能重新确认或覆盖。` : canConfirmControl(c) ? '可作对照：原版预检已达标；经你确认后才能进入其他模式候选的门槛。' : '暂不可作对照：' + esc(reason) + '。'}</p>${canConfirmControl(c) ? shown ? `<div class="bc-confirm-strip" data-control-consent><b>确认 #${esc(c.n)} 为门槛组对照？</b><span>只用于其他模式候选的防误伤检查；冻结当前断言、预检证据和模式身份，核心输入以后不能修改，不能覆盖本次确认。不启动模型或评测，不表示采纳候选。</span><p>${esc(precheckText(c))}</p><details><summary>本次冻结的检查全文</summary><pre class="tl-req">${esc(json({ questions: frozenRubric(c)?.questions || [], toolCheck: frozenRubric(c)?.toolCheck || null, scoringModel: frozenRubric(c)?.scoringModel || null }))}</pre></details><p class="trace-hash mono">确认绑定 hash ${esc(v.proposalHash)}<br>断言 hash ${esc(v.binding?.rubricHash)}<br>预检 ${esc(v.binding?.precheckId)}<br>模式 ${esc(v.binding?.pattern?.entryId || '不归入任何模式')}</p><div class="row-actions"><button type="button" class="btn primary" data-control-lock="${esc(c.id)}" ${disabled}>确认并冻结为对照</button><button type="button" class="btn" data-control-cancel="${esc(c.id)}">取消</button></div></div>` : `<button type="button" class="btn small" data-control-confirm="${esc(c.id)}" ${disabled}>确认为对照…</button>` : ''}${v.confirmation ? `<details><summary>冻结确认记录</summary><p>${esc(v.confirmation.confirmedAt)} · ${esc(v.confirmation.confirmationRecord)}</p><p class="trace-hash mono">${esc(v.confirmation.hash)}</p></details>` : ''}</section>`;
    }
    function refreshControlPanel(c) {
      const host = [...root.querySelectorAll('[data-gate-control]')].find(el => el.dataset.gateControl === c.id);
      if (host) host.outerHTML = controlPanel(c);
    }
    function assertionPanel(c) {
      const a = pipeline(c).assertion;
      return `<section class="dehydration-panel" data-assertion-slot="${esc(c.id)}"><h4>断言 · 评分 v2</h4><p>${esc(assertionText(c))}</p>${a.questions.map(q => `<div class="assertion-readonly"><b>${esc(q.id)}</b> · 依据：${esc({ reply: '回复', trace: '轨迹', files: '文件' }[q.evidence] || q.evidence)}<p>${esc(q.question)}</p></div>`).join('')}<a class="btn small" href="#case-${c.n}">去「用例」页${a.version ? '查看或另存断言' : '起草断言'}</a><p class="hint">这里只读展示冻结版本；跳转不调用模型或启动评测。工具调用检查同时用于 trace 评测和切点报告；只配工具检查也可用于 trace。trace 读取结构化调用记录，不解析 bash、不用 AI 判断参数。冻结断言不会自动启动判分；原版预检独立记录，不拿正式评测代替。</p></section>`;
    }
    function plan(c) {
      const has = hasScene(c), old = sourceOnly(c), other = !isGpt(c), cs = D.caseStates?.find(s => s.caseId === c.id), r = dehydration(c), d = r?.decision;
      const status = pipeline(c), reference = !has && d?.level === 'reference', invalidCase = !has && baselineMissing(c);
      const steps = [
        ['done', c.kind === 'text-only' ? '用户批准的历史导入' : '页面标记'],
        [has ? c.traceBundle?.scene?.metadataStatus === 'recorded' ? 'done' : 'pending' : 'alt', has ? sceneNote(c) + '；元数据不等于已通过回放检查' : '没有现场；须先确认能否脱水'],
        [old || has || d ? 'done' : 'pending', old ? '不脱水、不改组，只作旧题来源' : d ? `用户已冻结：${kindLabel(d.kind)}${d.cutStep ? '，切点第 ' + d.cutStep + ' 步' : '；' + (reference ? '无现场，只作参考' : '仍走 trace 级')}` : has ? '有现场，走 trace 级；可请求推荐并确认切点，仅用于单次 run 级检查报告，身份和组别不变' : r ? 'DeepSeek 推荐已生成，等待你确认能否脱水和切点' : 'DeepSeek 推荐尚未生成；用户确认后冻结判断与切点'],
        [patternLabel(c)?.confirmed || cs?.memberships?.length ? 'done' : 'pending', patternLabel(c)?.confirmed ? '已锁定：' + labelTitle(patternLabel(c)) : cs?.memberships?.length ? '已有已确认模式标签' : '待确认模式标签；不自动改模式或加入归纳'],
        [old || splitName[c.split] ? 'done' : 'pending', old ? '原测试分组保留' : confirmedGroup(c) ? `用户确认的${splitName[confirmedGroup(c).confirmedSplit]}组已生效；原提议和旧分组记录保留` : splitProposal(c) ? `提议：${splitName[splitProposal(c).proposedSplit]}组，等你确认后冻结` : !splitName[c.split] ? '待分配；模式标签及有效原版证据齐备后，按模式提议分组' : `已有${splitName[c.split]}组保留，不重新分配`],
        [status.assertion.status === 'frozen' ? 'done' : ['incompatible', 'stale'].includes(status.assertion.status) ? 'warn' : 'pending', assertionText(c)],
        [status.replay.status === 'supported' ? 'done' : status.replay.status === 'unsupported' ? 'warn' : 'pending', replayText(c)],
        [precheck(c).reproduced || control(c).confirmed ? 'done' : precheck(c).current ? 'alt' : 'pending', precheckText(c)],
        [status.inLibrary ? 'done' : 'pending', status.inLibrary ? `${splitName[c.split]}组 · ${has ? 'trace' : 'run'} 级 · 已分组、断言冻结、回放检查通过、${control(c).confirmed ? '已确认原版达标对照' : '独立原版预检已复现'}；不表示采纳候选` : '尚未入库；须已分组、断言已冻结、回放检查通过，且独立原版预检已复现或已确认为达标对照'],
      ];
      if (old || other) for (let i = old ? 5 : 2; i < 9; i++) steps[i] = ['skip', old ? '只作旧题来源，不单独入库' : '只报告，不计入 GPT 结论'];
      if (reference) for (let i = 4; i < 9; i++) steps[i] = ['skip', '无现场且非单步型；只作参考和训练组文字材料，不成为测试用例'];
      if (invalidCase && !reference && !old && !other) for (const i of [4, 5, 7, 8]) steps[i] = ['skip', '原版无有效输出：无效测试用例，不进门槛和初筛；不算通过也不算不通过'];
      const labelPending = patternLabel(c) && !patternLabel(c).confirmed;
      const needsAssertion = status.assertion.status !== 'frozen' && (has || d?.level === 'run');
      const categoryReview = patternLabel(c)?.pendingPatternId && !patternLabel(c)?.entryId && splitName[c.split];
      const actor = other ? 'other' : old ? 'source' : reference ? 'reference' : invalidCase ? 'invalid' : r && !d || labelPending || splitProposal(c) || canConfirmControl(c) ? 'you' : categoryReview ? c.split === 'train' ? 'you' : 'system' : needsAssertion ? 'you' : status.inLibrary ? 'library' : 'system';
      const next = other ? '非 GPT 来源，只报告' : old ? '保留旧题来源，不脱水、不改组' : reference ? '只作参考，不进入 run 级回放或选题'
        : invalidCase ? '原版无有效输出：无效测试用例，不进门槛和初筛；保留原文，不自动补跑'
        : r && !d ? has ? '请确认报告切点；仍是 trace 级，身份和组别不变，确认后不可修改' : '请确认能否脱水与切点；确认后不可修改'
        : labelPending ? '请确认模式标签：决定分组所属模式和评测目标用例，确认后不能改'
        : splitProposal(c) ? '请核对并确认此模式的新用例分组'
        : categoryReview ? c.split === 'train' ? '在分组区归纳本类别的模式内容并审核，只给模型训练成员。' : '等待本类别训练成员归纳并审核通过；门槛和测试不参与归纳。'
        : canConfirmControl(c) ? '可作对照：请核对原版预检，在下方面板内确认并冻结；不启动模型或评测'
        : needsAssertion ? (has ? sceneNote(c) + '；有现场，走 trace 级；' : '') + assertionText(c)
        : status.inLibrary ? `${splitName[c.split]}组${has ? ' trace' : ' run'} 级测试用例，等待候选；本页不启动评测`
        : has ? sceneNote(c) + '；有现场，走 trace 级；' + (status.replay.status !== 'supported' ? replayText(c) : status.assertion.status !== 'frozen' ? assertionText(c) : precheckText(c))
        : !d ? '等待 DeepSeek 推荐，再请你确认'
        : status.assertion.status !== 'frozen' ? assertionText(c) : precheckText(c);
      return { steps, actor, next, action: labelPending || splitProposal(c) || categoryReview && c.split === 'train' ? 'group' : !categoryReview && actor === 'you' && needsAssertion && !(r && !d) ? 'assertion' : null };
    }
    function funnel() {
      const gpt = D.cases.filter(isGpt), tr = gpt.filter(c => hasScene(c) && !sourceOnly(c)), refs = gpt.filter(c => !hasScene(c) && dehydration(c)?.decision?.level === 'reference'), rn = gpt.filter(c => !hasScene(c) && !sourceOnly(c) && dehydration(c)?.decision?.level === 'run');
      const lane = (key, title, note, cells) => `<div class="lane" data-lane="${key}"><div class="lane-head"><b>${title}</b><span>${note}</span></div><div class="funnel">${cells.map(([n, l]) => `<div class="f-step ${n ? '' : 'zero'}"><b>${n}</b><span>${l}</span></div>`).join('')}</div></div>`;
      $('[data-funnels]').innerHTML = lane('trace', 'trace 级', '有现场；从这一轮开头执行到自然结束；不能把封存当作已通过回放检查', [[tr.length, 'GPT 且有封存现场'], [tr.filter(c => c.traceBundle).length, '已冻结轨迹包'], [tr.filter(c => pipeline(c).replay.status === 'supported').length, '回放检查通过'], [tr.filter(c => pipeline(c).assertion.status === 'frozen').length, '断言已冻结'], [tr.filter(c => pipeline(c).inLibrary).length, '已入库']])
        + lane('run', 'run 级（脱水）', `无现场；冻结切点只调一次模型；只作参考 ${refs.length} 条不计入，未确认的也不计入`, [[rn.length, '用户确认可脱水'], [rn.filter(c => pipeline(c).replay.status === 'supported').length, '前缀可构造请求'], [rn.filter(c => pipeline(c).assertion.status === 'frozen').length, '检查已冻结（回复／工具调用）'], [rn.filter(c => precheck(c).reproduced || control(c).confirmed).length, '原版预检已复现／对照已确认'], [rn.filter(c => pipeline(c).inLibrary).length, '已入库']]);
      const runs = gpt.flatMap(activeRuns), excluded = gpt.flatMap(c => caseRuns(c).filter(r => excludedRun(c, r)));
      if (runs.length || excluded.length) $('[data-funnels]').insertAdjacentHTML('beforeend', `<p data-run-totals>单次 run 回放共 ${runs.length} 次：有效输出 ${runs.filter(validRunOutput).length}；无效 ${runs.filter(r => r.status === 'invalid').length}（不算通过也不算不通过）；请求失败 ${runs.filter(r => r.status === 'error').length}；结果未知 ${runs.filter(r => r.status === 'reserved').length}。有效输出含待判分与代码已判通过／失败；待判分不表示通过。原版无有效输出 ${gpt.filter(baselineMissing).length} 题，不进门槛和初筛。${excluded.length ? `历史回放已被用户改判，不计入：${excluded.length} 次（原文保留）。` : ''}</p>`);
    }
    const patternKey = c => { const p = patternLabel(c); return p?.confirmed ? p.patternKey || p.entryId || 'unclassified' : 'pending'; };
    function patterns() {
      const options = new Map([...(D.versions?.at(-1)?.entries || []).filter(e => e.status === 'approved').map(e => [e.id, e.title]), ...(D.casePatterns || []).flatMap(r => r.options || []).map(e => [e.entryId, e.title])]);
      for (const p of pendingOptions()) if (!p.entryId) options.set(p.id, p.name + ' · 待归纳');
      options.set('unclassified', '不归入任何模式'); options.set('pending', '模式标签待确认');
      return [...options].map(([key, title]) => ({ key, title, cases: D.cases.filter(c => patternKey(c) === key) }));
    }
    function boardRow(c) {
      const row = D.initialSplitProposal?.rows.find(r => r.caseId === c.id);
      const reason = !isGpt(c) ? 'non_gpt_report_only' : sourceOnly(c) ? 'legacy_test_source' : !hasScene(c) && dehydration(c)?.decision?.level === 'reference' ? 'reference_only' : baselineMissing(c) ? 'baseline_no_valid_output' : row?.reason;
      const out = reason && !['legacy_test_source', 'pattern_label_unconfirmed'].includes(reason);
      return { c, reason, level: sourceOnly(c) ? 'old' : hasScene(c) ? 'trace' : dehydration(c)?.decision?.level === 'run' ? 'run' : 'pending',
        group: out ? 'out' : splitName[c.split] ? c.split : row?.proposedSplit || 'out', prop: !out && !c.split && !!row?.proposedSplit };
    }
    function readiness(cases) {
      if (cases.some(c => patternLabel(c)?.pendingPatternId && !patternLabel(c)?.entryId)) return '待归纳新模式内容尚未审核通过或关联已有模式；暂不算任何模式的目标用例。';
      if (cases.some(c => patternKey(c) === 'pending')) return '尚不能评测候选：先确认模式标签；旧的分组和结果不等于归类已确认';
      const ready = cases.filter(c => pipeline(c).inLibrary && precheck(c).reproduced && isGpt(c) && !sourceOnly(c));
      const gate = ready.filter(c => c.split === 'gate'), test = ready.filter(c => c.split === 'test' && hasScene(c));
      const hasControl = D.cases.some(c => !cases.includes(c) && c.split === 'gate' && pipeline(c).inLibrary && control(c).status === 'confirmed' && control(c).confirmed && isGpt(c) && !sourceOnly(c) && patternKey(c) !== 'pending');
      const missing = [!gate.length && '可用门槛题', !test.length && '可用 trace 测试题', !hasControl && '其他模式的已确认防误伤对照'].filter(Boolean);
      return missing.length ? '尚不能评测候选：缺' + missing.join('、') : '有可用门槛、测试和其他模式的已确认防误伤对照；正式计划仍须逐题校验预检及冻结绑定';
    }
    function groupingPanel() {
      const all = patterns(), host = $('[data-grouping]'), p = D.initialSplitProposal;
      if (currentPattern === null || !all.some(x => x.key === currentPattern) && currentPattern !== 'all') currentPattern = all.find(x => x.cases.length)?.key || 'unclassified';
      const tab = (key, title, count) => `<button type="button" role="radio" data-bc-pattern="${esc(key)}" aria-checked="${currentPattern === key}">${esc(title)}${count == null ? '' : ` <small>${count}</small>`}</button>`;
      let body;
      if (currentPattern === 'all') {
        body = `<div class="bc-matrix-wrap"><table class="bc-matrix" data-pattern-overview><thead><tr><th>模式</th><th>训练</th><th>门槛</th><th>测试</th><th>不参与 / 待分配</th><th>能评测候选吗</th></tr></thead><tbody>${all.map(x => {
          const rows = x.cases.map(boardRow);
          return `<tr><th><button type="button" class="btn small" data-bc-pattern="${esc(x.key)}">${esc(x.title)}</button></th>${['train', 'gate', 'test', 'out'].map(g => `<td>${rows.filter(r => r.group === g && !r.prop).length}${rows.some(r => r.group === g && r.prop) ? ` + ${rows.filter(r => r.group === g && r.prop).length} 提议` : ''}</td>`).join('')}<td>${esc(readiness(x.cases))}</td></tr>`;
        }).join('')}</tbody></table></div><p class="hint">总览只给数量；点击模式看分组，不混摆不同模式的用例。提议尚未生效；分组不等于可回放或已复现。</p>`;
      } else {
        const x = all.find(x => x.key === currentPattern), rows = x.cases.map(boardRow), pattern = p?.patterns.find(v => v.patternKey === currentPattern);
        const counts = pattern?.existingCounts || ['trace', 'run'].reduce((acc, level) => ({ ...acc, [level]: Object.fromEntries(['train', 'gate', 'test'].map(g => [g, rows.filter(r => r.level === level && r.group === g && !r.prop && !r.reason).length])) }), {});
        const reasons = { non_gpt_report_only: '非 GPT 来源：只报告，不占配额', reference_only: '只作参考', baseline_no_valid_output: '无效测试用例：原版无有效输出', baseline_pending: '暂不参与：原版还没有有效回复', dehydration_not_confirmed: '脱水尚未确认', pattern_label_unconfirmed: '模式标签待确认，不占模式配额' };
        const chip = r => `<button type="button" class="cc ${r.level}${r.prop ? ' prop' : ''}${patternKey(r.c) === 'pending' ? ' unl' : ''}" data-bc-pick="${esc(r.c.id)}" title="${esc(r.c.actual)}"><b>#${r.c.n}</b><span>${esc(r.c.actual)}</span>${r.prop ? '<small>提议</small>' : ''}</button>`;
        const category = pendingOptions().find(v => v.id === currentPattern && !v.entryId);
        body = `<h3>${esc(x.title)}</h3>${category ? `<p class="hint" data-category-range>${esc(category.scope || '旧类别尚无范围说明')} · 只用于分组和判断新用例归属，不用于模式内容归纳或候选生成。</p>` : ''}<p class="hint" data-board-quotas>配额按已确认模式计算：trace 训练:门槛:测试 2:1:1；run 训练:门槛 2:1；本模式门槛 run 不超过 trace。${['trace', 'run'].map(level => `${level}：${['train', 'gate', 'test'].map(g => `${splitName[g]} ${counts[level][g]}${pattern?.counts && pattern.counts[level][g] !== counts[level][g] ? ' → ' + pattern.counts[level][g] : ''}`).join(' / ')}`).join('；')}。旧题来源不占配额，已有组别不变。</p>
          <div class="bc-board">${['train', 'gate', 'test', 'out'].map(g => `<section class="bc-column ${g === 'out' ? 'out' : ''}" data-board-column="${g}"><h4>${splitName[g] || '不参与 / 待分配'}</h4>${g === 'out' ? rows.filter(r => r.group === g).map(r => `<div class="bc-out-row">${chip(r)}<span class="hint">${esc(reasons[r.reason] || '待分配：尚无满足条件的提议')}</span></div>`).join('') || '<span class="hint">—</span>' : ['trace', 'run', 'old', 'pending'].map(level => { const members = rows.filter(r => r.group === g && r.level === level); return members.length ? `<div class="bc-level-row"><span class="hint">${{ old: '旧题来源（不改）', pending: '层级待确认' }[level] || level}</span><div class="chips">${members.map(chip).join('')}</div></div>` : ''; }).join('') || '<span class="hint">—</span>'}</section>`).join('')}</div>
          <p class="hint" data-board-readiness>${esc(readiness(x.cases))}</p>
          ${pendingOptions().some(v => v.id === currentPattern && !v.entryId) && pendingPreclassificationLabels().length ? `<p class="bc-notice" data-pending-label-hint>还有 ${pendingPreclassificationLabels().map(c => '#' + c.n).join('、')} 预分类建议新模式、标签没确认。建议同类用例的标签都确认后再分组；只提示，不阻止确认。</p>` : ''}
          <div data-initial-split>${!p?.blockers?.length && pattern?.rows.some(r => r.proposedSplit) ? `<p>虚线是新用例的提议，尚未生效；你确认后才冻结。</p>${splitConsent?.key === currentPattern && splitConsent.hash === p.hash ? `<div class="bc-confirm-strip" data-split-consent><b>确认「${esc(x.title)}」的首次分组后，组别立即锁定：</b><span>${pattern.rows.filter(r => r.proposedSplit).map(r => '#' + D.cases.find(c => c.id === r.caseId)?.n + ' → ' + splitName[r.proposedSplit] + '组').join('；')}。已有组别不变，不启动回放或评测。</span><div class="row-actions"><button type="button" class="btn primary" data-initial-split-lock="${esc(currentPattern)}">确认并锁定</button><button type="button" class="btn" data-split-cancel>取消</button></div></div>` : `<button type="button" class="btn primary" data-initial-split-confirm="${esc(currentPattern)}" ${writable && typeof onConfirmInitialSplit === 'function' ? '' : 'disabled'}>确认此模式的新用例分组…</button>`}` : '<p class="hint">目前没有满足条件的待确认分组提议；系统不自动改组。</p>'}</div>
          ${categoryInductionPanel(x)}${pendingLinkPanel(x) ? `<details data-manual-link><summary>其他操作：这一类其实是已有模式</summary>${pendingLinkPanel(x)}</details>` : ''}${targetPanel(x)}
          ${x.cases.some(c => patternLabel(c) && !patternLabel(c).confirmed) ? `<p class="hint">点击用例，在右侧详情确认模式标签：</p><div class="chips">${x.cases.filter(c => patternLabel(c) && !patternLabel(c).confirmed).map(c => `<button type="button" class="btn small" data-bc-pick="${esc(c.id)}">#${c.n} 确认标签</button>`).join('')}</div>` : ''}`;
      }
      host.innerHTML = `<h2>分组</h2><p class="hint">先选模式，再看本模式的分组。实线是已生效的组别；紫色虚线是首次分组提议。测试只收 trace；训练组初筛暂未启用。</p><div class="seg pat-seg" role="radiogroup" aria-label="模式">${all.map(x => tab(x.key, x.title, x.cases.length)).join('')}${tab('all', '全部模式（总览）')}</div>
        ${p?.blockers?.length ? `<div data-initial-split-blocked role="alert"><p>${esc(p.blockingMessage)}</p><p class="hint">已有组别的活动 GPT 用例标签尚未确认，整体暂停首次分组提议和确认；请选「模式标签待确认」补齐，不改变已有组别。</p></div>` : ''}${body}
        <details data-group-audit><summary>变化记录与审计信息（默认折叠）</summary><p class="hint">旧分组、提议、确认及其原文保留。旧提议不在此重新确认；这里没有自动应用或启动评测的入口。</p><pre class="tl-req">${esc(json({ initialProposal: p, initialConfirmations: D.initialSplitConfirmations || [], proposals: D.regroupProposals || [], confirmations: D.regroupConfirmations || [] }))}</pre></details>`;
    }
    const approvedOptions = () => (D.versions?.at(-1)?.entries || []).filter(e => e.status === 'approved');
    const pendingOptions = () => [...new Map([...(D.casePatterns || []).flatMap(l => l.pendingOptions || []), ...(D.pendingPatterns || []).map(p => ({ ...p, entryId: D.pendingPatternLinks?.find(l => l.pendingPatternId === p.id)?.entryId || null }))].map(p => [p.id, p])).values()];
    const entryTitle = id => approvedOptions().find(e => e.id === id)?.title || (D.casePatterns || []).flatMap(l => l.options || []).find(e => e.entryId === id)?.title || id;
    const labelTitle = label => label.pendingPatternId ? label.entryId ? `「${entryTitle(label.entryId)}」（由待归纳新模式「${label.pendingPatternName}」关联）` : `待归纳新模式「${label.pendingPatternName}」` : label.entryId ? `已有模式「${entryTitle(label.entryId)}」` : '不归入任何模式';
    const pendingPreclassificationLabels = () => D.cases.filter(c => c.preclassification?.kind === 'new' && !patternLabel(c)?.confirmed);
    const preclassificationBatch = () => D.cases.filter(c => c.kind === 'marked-badcase' && c.split === null && !c.preclassification && !patternLabel(c)?.confirmed && isGpt(c));
    function pendingLinkPanel(x) {
      const p = pendingOptions().find(p => p.id === x.key && !p.entryId);
      if (!p || !x.cases.length || !x.cases.every(c => splitName[c.split])) return '';
      const trainCases = x.cases.filter(c => c.split === 'train'), fromTrain = e => e.caseIds?.some(id => trainCases.some(c => c.id === id));
      const derived = approvedOptions().filter(fromTrain), approved = [...derived, ...approvedOptions().filter(e => !fromTrain(e))], defaultId = '';
      const next = `<p class="hint" data-pending-next>通常在上方用本类别训练组归纳模式内容，审核通过后自动成为正式模式；知识库同步显示。这里只用于关联已有模式，门槛和测试不参与归纳。</p>`;
      if (!approved.length) return `<div class="bc-notice">${next}<p>还没有可关联的已通过模式。</p></div>`;
      const target = linkConsent?.id === p.id ? approved.find(e => e.id === linkConsent.entryId) : null;
      return `<section class="bc-notice" data-pending-link-panel="${esc(p.id)}">${next}<b>关联到已通过的模式</b><p>只能关联一次。关联前，这一组不算任何模式的目标用例。</p>${target ? `<div class="bc-confirm-strip" data-link-consent><b>关联后不能改：</b><span>「${esc(p.name)}」的 ${x.cases.length} 条用例都算「${esc(target.title)}」的用例；门槛和测试组成为它候选的目标复现题，已分好的组别不变。</span><div class="row-actions"><button type="button" class="btn primary" data-pending-link-lock="${esc(p.id)}">确认并锁定</button><button type="button" class="btn" data-link-cancel>取消</button></div></div>` : `<label class="field">关联到的模式<select data-pending-link-entry><option value="">选择已通过的模式…</option>${approved.map(e => `<option value="${esc(e.id)}" ${e.id === defaultId ? 'selected' : ''}>${esc(e.title)}${fromTrain(e) ? '（用本组训练用例归纳出）' : ''}</option>`).join('')}</select></label>${derived.length ? `<p class="hint" data-pending-link-derived>${derived.map(e => `「${esc(e.title)}」（用本组训练用例归纳出）`).join('；')}</p>` : ''}<div class="row-actions"><button type="button" class="btn primary" data-pending-link="${esc(p.id)}" ${writable && typeof onLinkPendingPattern === 'function' && defaultId ? '' : 'disabled'}>关联…</button></div>`}</section>`;
    }
    function targetPanel(x) {
      if (!(D.pendingPatternLinks || []).some(l => l.entryId === x.key)) return '';
      const ids = split => x.cases.filter(c => c.kind === 'marked-badcase' && c.split === split && isGpt(c) && patternLabel(c)?.confirmed && patternLabel(c)?.entryId === x.key && !control(c).confirmation).map(c => '#' + c.n).join('、') || '无';
      return `<section class="bc-notice" data-pattern-targets><b>「${esc(x.title)}」的模式目标</b><p>门槛目标复现题：${ids('gate')}；测试目标复现题：${ids('test')}</p><p class="hint">目标题已确定 ≠ 可评测。目标复现题已经确定；要用于评测，还需要冻结断言、通过回放检查并满足原版复现等条件，具体看上面列出的缺项。这里只确认模式归属，不代表已经可以评测；已分组别不变。</p></section>`;
    }
    function formFor(c) {
      if (labelForms.has(c.id)) return labelForms.get(c.id);
      const label = patternLabel(c), pending = label?.pendingOptions || pendingOptions(), entryId = c.preclassification?.entryId || label?.options?.[0]?.entryId || '';
      return { kind: c.preclassification?.kind === 'new' ? 'pending' : c.preclassification?.kind === 'assign' ? 'entry' : c.preclassification?.kind === 'none' ? 'none' : '', entryId,
        mode: pending.length ? 'join' : 'create', pendingId: pending[0]?.id || '', name: '', scope: '' };
    }
    function readLabelForm(host, c) {
      const f = { ...formFor(c) };
      f.kind = host.querySelector('[data-pattern-kind]:checked')?.value || f.kind;
      f.entryId = host.querySelector('[data-pattern-entry]')?.value || f.entryId;
      f.mode = host.querySelector('[data-pattern-pending-mode]:checked')?.value || f.mode;
      f.pendingId = host.querySelector('[data-pattern-pending-id]')?.value || f.pendingId;
      f.name = host.querySelector('[data-pattern-name]')?.value ?? f.name;
      f.scope = host.querySelector('[data-pattern-scope]')?.value ?? f.scope;
      return f;
    }
    function labelSelection(c, f) {
      if (f.kind === 'entry') return { entryId: f.entryId };
      if (f.kind === 'none') return { entryId: null };
      if (f.kind === 'pending') return { pendingPattern: f.mode === 'join' ? { id: f.pendingId } : { name: f.name.trim(), scope: f.scope.trim() } };
      return null;
    }
    function refreshLabelPanels(c) {
      for (const host of [...root.querySelectorAll('[data-pattern-label]')].filter(el => el.dataset.patternLabel === c.id)) host.outerHTML = patternPanel(c);
    }
    function patternPanel(c) {
      const label = patternLabel(c); if (!label) return '';
      const pre = c.preclassification, batch = preclassificationBatch();
      const preBox = pre ? `<div class="bc-preclassification" data-preclassification><b>预分类建议：${esc(pre.kind === 'assign' ? entryTitle(pre.entryId) : pre.kind === 'new' ? '新模式' : '不归入任何模式')}（把握：${esc(pre.confidence || '未记录')}）</b><p>理由：${esc(pre.reason || '未记录')}</p><p class="hint">只提议标签；未经你确认不生效。</p></div>` : !label.confirmed && batch.some(v => v.id === c.id) ? `<div class="bc-preclassification"><b>还没有预分类</b><p>会一起处理全部 ${batch.length} 条待预分类用例（${batch.map(c => '#' + c.n).join('、')}），只提议，不改标签。建议新模式的用例会和已有新模式建议的 ${esc(numbers(categoryProposalBatch()))} 一起提议新类别；也可以直接选择。</p><button type="button" class="btn small" data-preclassify ${writable && typeof onPreclassify === 'function' ? '' : 'disabled'}>预分类并提议类别</button></div>` : '';
      const what = '<p class="bc-label-what">这一步决定这条用例在哪个模式下分组，以及评测时算哪个模式的目标用例。确认后不能改。</p>';
      const shell = body => `<section class="dehydration-panel bc-label-panel" data-pattern-label="${esc(c.id)}"><h4>${label.confirmed ? '模式标签' : '确认模式标签'}</h4>${what}${body}</section>`;
      if (label.confirmed) {
        const role = control(c).confirmation ? control(c).confirmed ? '已冻结为其他模式候选的防误伤对照，不作本模式目标复现题；原模式身份和组别保留。' : '对照确认已失效，暂不可用于评测；原确认与模式身份保留，不改作本模式目标复现题。'
          : !label.entryId ? label.pendingPatternId ? '还没关联到已通过的模式，评测时暂不算任何模式的目标用例。' : '评测时不算任何模式的目标用例。'
          : c.split === 'train' ? '训练组用例：参与归纳，不当复现题。' : splitName[c.split] ? `${splitName[c.split]}组用例：评测「${entryTitle(label.entryId)}」的候选时算目标复现题。` : '分组确认后才知道它在评测里的角色。';
        const status = label.source && label.source !== 'badcase-page' ? '沿用已有确认归类：' : '已锁定：';
        return shell(`<p class="pill ok">${status}${esc(labelTitle(label))}</p><p data-pattern-role>${esc(role)}</p>${preBox}`);
      }
      const proposal = pendingCategoryProposals().find(p => categoryForm(p).members.includes(c.id));
      if (proposal) return shell(`${preBox}<div class="bc-notice"><b>已在上方的新类别提议「${esc(categoryForm(proposal).name)}」里</b><p>${esc(proposal.members.find(m => m.caseId === c.id)?.reason)}</p><p class="hint">在上方核对后整组确认；如果不属于这一类，取消勾选后回这里单独选标签。</p><div class="row-actions"><button type="button" class="btn small" data-go-categories>去看类别提议</button></div></div>`);
      const f = formFor(c), entries = label.options || [], pending = label.pendingOptions || pendingOptions(), serial = ++panelSerial, disabled = writable && typeof onConfirmPatternLabel === 'function' ? '' : 'disabled';
      const radio = (kind, title) => `<label><input type="radio" data-pattern-kind name="label-${esc(c.id)}-${serial}" value="${kind}" ${f.kind === kind ? 'checked' : ''} ${disabled}>${title}</label>`;
      const selection = labelSelection(c, f), consent = labelConsents.get(c.id), shown = consent && consent.hash === label.labelHash && consent.selection === json(selection);
      const joined = f.kind === 'pending' && f.mode === 'join' ? pending.find(p => p.id === f.pendingId) : null;
      const chosen = f.kind === 'entry' ? `已有模式「${entryTitle(f.entryId)}」` : f.kind === 'none' ? '不归入任何模式' : f.mode === 'join' ? `待归纳新模式「${joined?.name || ''}」${joined?.entryId ? `（已关联到「${entryTitle(joined.entryId)}」）` : ''}` : `新建待归纳新模式「${f.name.trim()}」`;
      const consequence = f.kind === 'entry' ? `它会在「${entryTitle(f.entryId)}」里按配额分组；门槛和测试用例评测这个模式的候选时算目标复现题。` : f.kind === 'none' ? '这类用例共用一组，评测时不算任何模式的目标用例。' : joined?.entryId ? `它会直接在「${entryTitle(joined.entryId)}」里按配额分组；门槛和测试用例评测「${entryTitle(joined.entryId)}」的候选时算目标复现题。` : '它会在这个新模式自己的组里分组；之后只用训练组归纳模式内容，你审核通过后自动成为正式模式，门槛和测试成为它的目标复现题。';
      return shell(`${preBox}${c.preclassification?.kind === 'new' && categoryProposalBatch().some(v => v.id === c.id) && hasUncoveredCategoryCases() ? proposeCategoriesEntry() : ''}<div class="bc-label-options" role="radiogroup" aria-label="模式标签">
        <div class="bc-label-option ${f.kind === 'entry' ? 'on' : ''}">${radio('entry', '已有模式')}${f.kind === 'entry' ? `<label class="field">已通过的模式<select data-pattern-entry ${disabled}>${entries.map(e => `<option value="${esc(e.entryId)}" ${f.entryId === e.entryId ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></label>` : ''}</div>
        <div class="bc-label-option ${f.kind === 'pending' ? 'on' : ''}">${radio('pending', '待归纳新模式')}${f.kind === 'pending' ? `<div class="bc-label-sub"><label><input type="radio" data-pattern-pending-mode name="pending-${esc(c.id)}-${serial}" value="join" ${f.mode === 'join' ? 'checked' : ''} ${!pending.length ? 'disabled' : disabled}>加入${!pending.length ? '（还没有待归纳新模式）' : ''}</label>${pending.length ? `<select data-pattern-pending-id aria-label="已有的待归纳新模式" ${disabled}>${pending.map(p => `<option value="${esc(p.id)}" ${p.id === f.pendingId ? 'selected' : ''}>${esc(p.name)}${p.entryId ? '（已关联）' : ''}</option>`).join('')}</select>` : ''}${joined ? `<p class="hint" data-pending-description>范围：${esc(joined.scope || '旧类别尚无范围说明')}<br>成员：${esc(pendingMembers(joined.id).map(v => '#' + v.n).join('、') || '暂无')}。</p>` : ''}<label><input type="radio" data-pattern-pending-mode name="pending-${esc(c.id)}-${serial}" value="create" ${f.mode === 'create' ? 'checked' : ''} ${disabled}>新建</label>${f.mode === 'create' ? `<input type="text" data-pattern-name aria-label="新模式名称" placeholder="名字（1–40字）" value="${esc(f.name)}" ${disabled}><textarea data-pattern-scope aria-label="新类别范围" placeholder="一句话范围（1–120字）" ${disabled}>${esc(f.scope)}</textarea><p class="hint">名字和范围不要写某条用例的具体细节（例如具体字数）；名字将成为正式模式标题，范围不进入归纳和候选生成。</p>` : ''}</div>` : ''}</div>
        <div class="bc-label-option ${f.kind === 'none' ? 'on' : ''}">${radio('none', '不归入任何模式')}<p class="hint">共用一组，评测时不算任何模式的目标用例。</p></div></div>
        ${labelErrors.has(c.id) ? `<p class="bc-label-error" data-label-error role="alert">${esc(labelErrors.get(c.id))}</p>` : ''}
        ${shown ? `<div class="bc-confirm-strip" data-label-consent><b>确认后不能改：#${c.n} → ${esc(chosen)}</b><span>${esc(consequence)}</span><div class="row-actions"><button type="button" class="btn primary" data-pattern-lock="${esc(c.id)}" ${disabled}>确认并锁定</button><button type="button" class="btn" data-label-cancel="${esc(c.id)}">取消</button></div></div>` : `<button type="button" class="btn primary" data-pattern-confirm="${esc(c.id)}" ${!f.kind ? 'disabled' : disabled}>确认模式标签…</button>`}
        <details><summary class="hint">这一步不做什么</summary><p class="hint">不分组（在上方另外确认）；不调用模型；不改知识库内容和归纳成员。</p></details>`);
    }
    // Category identity can use all proposed cases; content induction is a separate,
    // explicit training-only action. GET projection remains the authority for locks.
    const pendingCategoryProposals = () => (D.categoryProposalViews || []).filter(p => p.status === 'pending');
    const categoryProposalBatch = () => pendingPreclassificationLabels().filter(c => c.kind === 'marked-badcase' && c.split === null && c.source?.agentId === 'role-family-gpt');
    const hasUncoveredCategoryCases = () => categoryProposalBatch().some(c => !pendingCategoryProposals().some(p => p.members.some(m => m.caseId === c.id)));
    const pendingMembers = id => D.cases.filter(c => patternLabel(c)?.pendingPatternId === id);
    const numbers = cases => cases.map(c => '#' + c.n).join('、') || '无';
    function categoryForm(p) {
      if (!categoryForms.has(p.hash)) categoryForms.set(p.hash, { name: p.name, scope: p.scope, members: p.members.filter(m => m.canConfirm === true).map(m => m.caseId) });
      return categoryForms.get(p.hash);
    }
    function categorySelection(p) {
      const f = categoryForm(p);
      return { proposalHash: p.hash, name: f.name.trim(), scope: f.scope.trim(), members: p.members.filter(m => f.members.includes(m.caseId) && m.canConfirm === true).map(m => ({ caseId: m.caseId, labelHash: patternLabel(D.cases.find(c => c.id === m.caseId))?.labelHash })) };
    }
    function proposeCategoriesEntry() {
      return `<div class="bc-notice"><b>已预分类，尚未提议类别</b><p>会一起处理 ${numbers(categoryProposalBatch())}，只提议类别，不改任何标签。若已有未处理提议，新提议会取代它。</p><div class="row-actions"><button type="button" class="btn" data-propose-categories ${writable && typeof onProposeCategories === 'function' ? '' : 'disabled'}>提议新类别</button></div></div>`;
    }
    function categoryActions(p) {
      const f = categoryForm(p), selection = categorySelection(p), enabled = writable && typeof onConfirmCategory === 'function', disabled = enabled ? '' : 'disabled';
      const linked = pendingOptions().find(v => v.id === p.pendingPatternId)?.entryId;
      const consequence = linked ? `它们会直接在「${entryTitle(linked)}」里按配额分组；门槛和测试用例评测这个正式模式的候选时算目标复现题，已有组别不变。` : '它们会在这个类别自己的组里分组。之后只用训练组的用例归纳模式内容；你审核通过后，这个类别自动成为正式模式，门槛和测试成为它的目标复现题。';
      return `${categoryErrors.has(p.hash) ? `<p class="bc-label-error" data-category-error role="alert">${esc(categoryErrors.get(p.hash))}</p>` : ''}${categoryConsents.get(p.hash) === json(selection) ? `<div class="bc-confirm-strip" data-category-consent><b>确认后不能改：${esc(numbers(D.cases.filter(c => f.members.includes(c.id))))} 归入${p.pendingPatternId ? '已有类别' : '新类别'}「${esc(f.name.trim())}」</b><span>${esc(consequence)}</span><div class="row-actions"><button type="button" class="btn primary" data-category-lock ${disabled}>确认并锁定</button><button type="button" class="btn" data-category-cancel>取消</button></div></div>` : `<div class="row-actions"><button type="button" class="btn primary" data-category-ask ${enabled && selection.members.length ? '' : 'disabled'}>确认这个类别（${selection.members.length} 条）…</button><button type="button" class="btn" data-category-reject ${writable && typeof onRejectCategory === 'function' ? '' : 'disabled'}>不采纳，逐条单独处理</button></div>`}`;
    }
    function categoryPanels() {
      const host = $('[data-categories]'), proposals = pendingCategoryProposals();
      const locked = (D.pendingPatterns || []).filter(p => p.sourceProposalHash);
      host.hidden = !proposals.length && !locked.length && !hasUncoveredCategoryCases();
      host.innerHTML = `${locked.map(p => { const linked = pendingOptions().find(v => v.id === p.id)?.entryId; return `<article class="bc-category-card" data-category-locked="${esc(p.id)}"><h2>新类别 · 已确认，不能修改${linked ? ' · 已成为正式模式' : ' · 模式内容待归纳'}</h2><b>${esc(p.name)}</b><p>${esc(p.scope || '')}</p><p class="hint">成员：${numbers(pendingMembers(p.id))}。范围只用于分组、判断新用例归属和生成类别提议；归纳和候选生成不读这段说明。</p>${linked ? `<p>正式模式：「${esc(entryTitle(linked))}」</p>` : ''}</article>`; }).join('')}${proposals.map(p => { const f = categoryForm(p); return `<article class="bc-category-card" data-category-card="${esc(p.hash)}"><h2>新类别提议${p.pendingPatternId ? ' · 建议加入已有类别' : ''}</h2><p class="bc-label-what">这一步只定“这是哪一类问题”：名字、范围、包含哪些用例。确认后标签锁定，不分组、不修改模式内容。</p><div class="bc-category-grid"><div class="bc-category-fields"><label>名字（1–40字）<input data-category-name value="${esc(f.name)}" ${p.pendingPatternId ? 'readonly' : ''}></label><label>范围：一句话说明这类问题（1–120字）<textarea data-category-scope ${p.pendingPatternId ? 'readonly' : ''}>${esc(f.scope)}</textarea></label>${p.pendingPatternId ? '<p class="hint">已有类别身份已冻结，这里不改名或范围；如不采纳，可逐条处理。</p>' : ''}<p class="hint">名字将成为正式模式标题；名字和范围不要写某条用例的具体细节（例如具体字数）。</p><div class="bc-notice"><b>这段说明会被谁用到</b><span>用于分组、判断新用例归属和生成类别提议，可以参考全部用例。</span><span>生成候选时不读；模式内容归纳也不读范围，只读类别名字和训练成员。</span></div></div><div class="bc-category-members"><b>包含的用例</b>${p.members.map(m => { const c = D.cases.find(c => c.id === m.caseId); return `<label class="bc-category-member"><input type="checkbox" data-category-member="${esc(m.caseId)}" ${f.members.includes(m.caseId) && m.canConfirm === true ? 'checked' : ''} ${m.canConfirm === true ? '' : 'disabled'}><b>#${c?.n || '?'}</b><span>${esc(c?.actual || '用例已不可用')}</span><span class="hint">${esc(m.reason)}${m.canConfirm === true ? '' : '；当前不能确认：' + (m.unavailableReason || '不可用')}</span></label>`; }).join('')}<p class="hint">取消勾选的用例回到下方逐条单独选标签。</p></div></div><div data-category-actions>${categoryActions(p)}</div></article>`; }).join('')}${hasUncoveredCategoryCases() ? proposeCategoriesEntry() : ''}`;
      syncWritable();
    }
    const contentFields = ['failureMode', 'symptoms', 'rootCauseHypothesis', 'guideline'];
    function draftForm(entry) {
      if (!draftForms.has(entry.id)) draftForms.set(entry.id, Object.fromEntries(contentFields.map(k => [k, entry[k]])));
      return draftForms.get(entry.id);
    }
    const sameCategoryTraining = (entry, x) => entry.caseIds.length === x.cases.filter(c => c.split === 'train').length && entry.caseIds.every(id => x.cases.some(c => c.id === id && c.split === 'train'));
    function categoryReviewActions(p, entry, x) {
      const disabled = writable && typeof onReviewCategory === 'function' ? '' : 'disabled';
      return `${!sameCategoryTraining(entry, x) ? '<p class="bc-label-error">训练成员已经改变，这份草稿不能通过；请驳回并重新归纳。</p>' : ''}${draftErrors.has(entry.id) ? `<p class="bc-label-error" data-draft-error role="alert">${esc(draftErrors.get(entry.id))}</p>` : ''}${draftConsents.get(entry.id) === json(draftForm(entry)) ? `<div class="bc-confirm-strip" data-category-review-consent><b>通过后模式内容冻结，「${esc(p.name)}」自动成为正式模式</b><span>门槛 ${numbers(x.cases.filter(c => c.split === 'gate'))}、测试 ${numbers(x.cases.filter(c => c.split === 'test'))} 成为它的目标复现题；已分好的组别不变，不启动评测。以后修改需另出修订版本再审核。</span><div class="row-actions"><button type="button" class="btn primary" data-category-review-lock ${disabled}>确认通过</button><button type="button" class="btn" data-category-review-cancel>取消</button></div></div>` : `<div class="row-actions"><button type="button" class="btn primary" data-category-approve ${sameCategoryTraining(entry, x) ? disabled : 'data-category-stale disabled'}>通过审核…</button><button type="button" class="btn" data-category-reinduct ${disabled}>驳回并重新归纳</button><span class="hint">修改的四项随审核一起保存。</span></div>`}`;
    }
    function categoryInductionPanel(x) {
      const p = pendingOptions().find(p => p.id === x.key && !p.entryId);
      if (!p || !x.cases.length || !x.cases.every(c => splitName[c.split]) || !x.cases.some(c => c.split === 'train')) return '';
      const entry = D.versions?.at(-1)?.entries.find(e => e.sourcePendingPatternId === p.id && e.categoryReviewRequired === true && e.status === 'draft');
      const train = entry ? D.cases.filter(c => entry.caseIds.includes(c.id)) : x.cases.filter(c => c.split === 'train');
      const source = `<p class="bc-category-sources">给模型：训练组 ${numbers(train)} 的问题、期望、消息和轨迹；不给：门槛 ${numbers(x.cases.filter(c => c.split === 'gate'))}、测试 ${numbers(x.cases.filter(c => c.split === 'test'))}；不含范围说明。</p>`;
      if (!entry) return `<section class="bc-notice" data-category-induction="${esc(p.id)}"><b>下一步：归纳这个类别的模式内容</b><p>模型只读训练成员；输出失败模式、表现、原因推测和准则，等你审核。审核通过后自动成为正式模式，知识库同步显示。</p>${source}<div class="row-actions"><button type="button" class="btn primary" data-category-induct="${esc(p.id)}" ${writable && typeof onInductCategory === 'function' ? '' : 'disabled'}>归纳模式内容（只提议）</button></div></section>`;
      const f = draftForm(entry), titles = ['失败模式', '表现', '原因推测', '准则（不超过300字）'];
      return `<section class="bc-category-draft" data-category-draft="${esc(entry.id)}" data-category-id="${esc(p.id)}"><b>模式内容草稿 · 待你审核</b>${source}<div class="bc-draft-grid">${contentFields.map((k, i) => `<label>${titles[i]}<textarea data-category-field="${k}">${esc(f[k])}</textarea>${k === 'guideline' ? `<span class="hint" data-guideline-count>${[...f[k]].length} / 300字</span>` : ''}</label>`).join('')}</div><div data-category-review-actions>${categoryReviewActions(p, entry, x)}</div></section>`;
    }
    function replayPanel(c) {
      const rows = caseRuns(c), active = activeRuns(c), excluded = rows.filter(r => excludedRun(c, r)); if (!rows.length) return '';
      const labels = { reached: '有效输出（待判分）', pass: '已判通过（代码判断）', fail: '已判失败（代码判断）', invalid: '无效 · 不算通过也不算不通过', error: '请求失败（不冒充模型答案）', reserved: '已占用 · 结果未知，不自动重试' };
      return `<section class="dehydration-panel" data-run-panel="${esc(c.id)}"><h4>单次 run 级回放</h4>${baselineMissing(c) ? '<p class="pill warn">原版无有效输出：无效测试用例，不进门槛和初筛。</p>' : ''}<p>有效输出 ${active.filter(validRunOutput).length} · 无效 ${active.filter(r => r.status === 'invalid').length}（不算通过也不算不通过） · 请求失败 ${active.filter(r => r.status === 'error').length} · 结果未知 ${active.filter(r => r.status === 'reserved').length}。有效输出含待判分与代码已判通过／失败；待判分不表示通过。这些历史单次回放不作预检准入；独立原版预检见上方，不在本页重新判分。${excluded.length ? `历史回放已被用户改判，不计入：${excluded.length} 次。` : ''}</p>${rows.map(r => `<details data-run-details="${esc(r.id)}" data-run-case="${esc(c.id)}"><summary>${r.variant.kind === 'original' ? '原版' : '候选 ' + esc(r.variant.id)} · ${excludedRun(c, r) ? '已被用户改判，不计入（历史回放）' : esc(labels[r.status] || r.status)} · 查看完整输出及实际请求</summary><p>${esc(r.model)} · thinking ${esc(r.thinking)} · 模型调用 ${r.modelCalls ?? '未知'} · 工具执行 ${r.toolExecutions ?? '未知'}</p><p class="trace-hash mono">请求 SHA-256：${esc(r.id)}<br>结果 SHA-256：${esc(r.resultHash || '未取得')}</p><p class="hint">当前分类以 accounting 为准；原始包中的历史分类只供审计，不参与当前计数。</p><p>${['json', 'md'].map(format => `<a class="btn small" data-run-export="${format}" href="/api/wikiskill/cases/${encodeURIComponent(c.id)}/run-replays/${encodeURIComponent(r.id)}/export.${format}" download>导出回放 ${format === 'json' ? 'JSON' : 'Markdown'}</a>`).join(' ')}</p><div data-run-body></div></details>`).join('')}</section>`;
    }
    const checkLabel = s => ({ pass: '通过', fail: '失败', invalid: '无效', error: '技术错误', unreached: '未判到（不计通过或失败）', unconfigured: '未配置' }[s] || s || '未记录');
    const runReason = s => ({ arguments_unparseable: '参数无法解析', no_check_reached: '没有判到任何检查', tool_rule_failed: '工具参数不符合规则', reply_check_failed: '回复检查失败', empty_output: '空输出', model_failed: '模型未产生有效输出' }[s] || s);
    function reportScope(r) {
      const skipped = r.questions.filter(q => q.evidence !== 'reply');
      return `<p class="hint">${r.questions.length && !r.questions.some(q => q.evidence === 'reply') ? '本版本没有回复依据的问题' : !r.questions.length ? '未配置回复检查' : '回复检查只判断依据为回复的问题'}；工具调用检查${r.toolCheck ? '已配置（代码判断）' : '未配置'}。</p>${skipped.length ? `<ul data-report-skipped>${skipped.map(q => `<li>${esc(q.id)} · ${esc(q.question)} · 依据 ${esc(q.evidence)}：未判到，不送裁判，不计通过或失败。</li>`).join('')}</ul>` : ''}`;
    }
    function reportPanel(c) {
      if (!reportCut(c)) return '';
      const r = frozenRubric(c), counts = c.runChecks, rows = reportRows(c);
      const current = r && counts?.rubricHash === r.hash && counts.decisionHash === dehydration(c)?.decision?.hash;
      return `<section class="dehydration-panel" data-run-report="${esc(c.id)}"><h4>切点上的 run 级检查报告</h4><p class="hint">只出报告，不作采纳依据，不进门槛统计；仍是 trace 级，组别不变。工具调用检查同时用于 trace 评测和切点报告；只配工具检查也可用于 trace。只统计原版的当前切点 + 最新冻结版本；旧版结果不拼接。</p>${r ? `<p>统计的是 v${esc(r.version)} · 切在第 ${esc(dehydration(c).decision.cutStep)} 步之前</p>${reportScope(r)}<p class="trace-hash mono">断言 hash ${esc(r.hash)}</p>` : '<p>尚无冻结版本；没有可用的检查结果。</p>'}${current ? `<p data-report-counts>通过 ${counts.passed} · 失败 ${counts.failed} · 无效 ${counts.invalid} · 技术错误 ${counts.errors} · 结果未知 ${counts.pending}。无效和技术错误不进有效分母，未知不算通过。</p>${Object.entries(counts.invalidReasons || {}).length ? `<ul>${Object.entries(counts.invalidReasons).map(([reason, n]) => `<li>${esc(runReason(reason))}：${esc(n)}</li>`).join('')}</ul>` : ''}` : '<p>等待读取与当前切点和冻结版本一致的报告统计；不沿用旧版次数。</p>'}${rows.map(r => `<details data-run-details="${esc(r.id)}" data-run-case="${esc(c.id)}"><summary>原版 · ${esc(r.status === 'reserved' ? '结果未知' : checkLabel(r.status))} · 查看检查结果、完整输出及实际请求</summary><p>模型调用 ${esc(r.modelCalls ?? '未知')} · 工具执行 ${esc(r.toolExecutions ?? '未知')} · 不作采纳依据</p><p>${['json', 'md'].map(format => `<a class="btn small" href="/api/wikiskill/cases/${encodeURIComponent(c.id)}/run-replays/${encodeURIComponent(r.id)}/export.${format}" download>导出 ${format}</a>`).join(' ')}</p><div data-run-body></div></details>`).join('')}</section>`;
    }
    function reportCheckStatus(packet) {
      const report = packet.result?.report, checks = report?.checks;
      if (!checks) return '';
      const r = (D.rubrics || []).find(r => r.hash === report.rubricHash);
      const reply = checks.reply === 'unconfigured' && r?.questions.length && !r.questions.some(q => q.evidence === 'reply') ? '本版本没有回复依据的问题' : checks.reply === 'unconfigured' ? '未配置回复检查' : '回复检查：' + checkLabel(checks.reply);
      return `<p data-run-check-status>${esc(reply)}；工具调用检查：${esc(checkLabel(checks.tool?.status))}${checks.reason ? `；${esc(runReason(checks.reason))}` : ''}。不作采纳依据。</p>`;
    }
    async function loadRun(details) {
      if (!details.isConnected) return;
      const id = details.dataset.runDetails, caseId = details.dataset.runCase, host = details.querySelector('[data-run-body]');
      const render = row => { host.innerHTML = row.state === 'ready' ? reportCheckStatus(row.packet) : ''; const pre = document.createElement('pre'); pre.className = 'tl-req'; pre.textContent = row.state === 'ready' ? json(row.packet) : row.state === 'error' ? '回放记录读取失败；未使用其他结果兜底。' : '正在读取完整回放记录…'; host.appendChild(pre); };
      if (runCache.has(id)) { render(runCache.get(id)); return; }
      const row = { state: 'loading', packet: null }; runCache.set(id, row); render(row);
      try { const packet = await fetchJson('/api/wikiskill/cases/' + encodeURIComponent(caseId) + '/run-replays/' + encodeURIComponent(id)); if (!packet?.reservation) throw Error(); row.packet = packet; row.state = 'ready'; }
      catch { row.state = 'error'; runCache.delete(id); }
      if (details.isConnected) render(row);
    }
    const canRecommend = (c, r) => !!c.traceBundle && c.source?.agentId === 'role-family-gpt' && !sourceOnly(c) && !r?.decision && c.dehydrationRecommendation?.eligible;
    const cutKey = (c, r) => json([c.id, c.traceBundle?.hash, c.sealedCheckpointId || null, r?.hash, r?.decision || null]);
    const cutForm = (c, r) => cutForms.get(c.id) || { kind: r.recommendation.kindSuggestion, cutStep: r.recommendation.cutStepSuggestion };
    const cutBody = (c, r, f) => ({ caseId: c.id, traceHash: r.traceHash, recommendationHash: r.hash, kind: f.kind, cutStep: f.kind === 'single' ? Number(f.cutStep) : null });
    const reportNote = c => hasScene(c) ? '单步型切点只用于切点上的单次检查报告；仍是 trace 级，身份和组别不变，不作采纳依据。' : '单步型成为 run 级；贯穿型或说不清且无现场只作参考，不成为测试用例。';
    function refreshCutPanel(c) { const host = [...root.querySelectorAll('[data-dehydration]')].find(el => el.dataset.dehydration === c.id); if (host) host.outerHTML = dehydrationPanel(c); syncWritable(); }
    function cutActions(c, r) {
      const consent = cutConsents.get(c.id), body = cutBody(c, r, cutForm(c, r)), disabled = writable && typeof onConfirmDecision === 'function' ? '' : 'disabled';
      return consent?.operation === 'freeze' && consent.key === cutKey(c, r) && consent.body === json(body)
        ? `<div class="bc-confirm-strip" data-dehydration-consent><b>确认冻结 #${c.n}：${esc(kindLabel(body.kind))}${body.cutStep ? '，切在第 ' + body.cutStep + ' 步之前' : ''}</b><span>${reportNote(c)}确认后不能修改；不启动模型、不执行工具、不改分组。</span><div class="row-actions"><button type="button" class="btn primary" data-dehydration-lock="${esc(c.id)}" ${disabled}>确认并冻结</button><button type="button" class="btn" data-dehydration-cancel="${esc(c.id)}">取消</button></div></div>`
        : `<button type="button" class="btn primary" data-dehydration-confirm="${esc(c.id)}" ${disabled}>确认并冻结判断与切点…</button>`;
    }
    function requestButton(c, r) {
      if (!canRecommend(c, r)) return '';
      const consent = cutConsents.get(c.id), disabled = writable && typeof onRequestRecommendation === 'function' ? '' : 'disabled';
      return consent?.operation === 'recommend' && consent.key === cutKey(c, r)
        ? `<div class="bc-confirm-strip" data-dehydration-consent><b>为 #${c.n} 请求一次 DeepSeek 推荐？</b><span>将发送冻结的起因、步骤卡片、回复和问题／期望，不自动重试或确认。${reportNote(c)}</span><div class="row-actions"><button type="button" class="btn primary" data-dehydration-request-lock="${esc(c.id)}" ${disabled}>确认请求推荐</button><button type="button" class="btn" data-dehydration-cancel="${esc(c.id)}">取消</button></div></div>`
        : `<p class="hint">每次确认请求只调用一次 DeepSeek；不会执行工具或自动确认。</p><button type="button" class="btn" data-dehydration-recommend="${esc(c.id)}" ${disabled}>${r ? '再次请求推荐' : '请求推荐'}</button>`;
    }
    function dehydrationPanel(c) {
      const r = dehydration(c); if (sourceOnly(c) || !isGpt(c)) return '';
      if (!r) { const button = requestButton(c, r); return button ? `<section class="dehydration-panel" data-dehydration="${esc(c.id)}"><h4>${hasScene(c) ? '切点推荐 · 只出报告' : '脱水 · 能否脱水'}</h4><p class="hint">${reportNote(c)}</p>${button}</section>` : ''; }
      const rec = r.recommendation, d = r.decision, f = cutForm(c, r);
      const fallbackLabel = { parse_failed: '两次输出仍无法解析', evidence_mismatch: '依据与该步卡片原文不匹配', no_cut: '未给出切点', unclear: '模型说不清', not_single: '模型判断为贯穿型' };
      const provider = rec.schemaVersion === 2 ? 'DeepSeek' : '历史 JEV';
      if (rec.retryPolicy === 'manual') fallbackLabel.parse_failed = '本次输出无法解析';
      const history = (D.dehydrations || []).filter(old => old.caseId === c.id && old.traceHash === r.traceHash && old.hash !== r.hash);
      return `<section class="dehydration-panel" data-dehydration="${esc(c.id)}"><h4>${hasScene(c) ? '切点确认 · 只出报告' : '能否脱水'}</h4><p class="hint">${reportNote(c)}</p>${d?.supersedesDecisionHash ? '<p class="pill warn">原推荐与历史确认已被用户改判，不计入；原文和 hash 保留。</p>' : ''}<p>${rec.schemaVersion === 2 && !rec.answers ? '未取得可解析的 DeepSeek 判断；回退切点：第 ' : provider + ' 建议：' + esc(kindLabel(rec.kindSuggestion)) + '；建议切点：第 '}${rec.cutStepSuggestion} 步${rec.cutSource === 'marked_step_fallback' ? `（${esc(fallbackLabel[rec.fallbackReason] || '未达建议条件')}，回退到发消息步骤${d ? '；用户决定见下方' : '，请你挑选'}）` : ''}。</p>
        ${rec.schemaVersion === 2 ? `<p>理由：${esc(rec.answers?.reason || '未取得可解析答案，不代表模型给出了判断')}</p><p>原文依据：${esc(rec.answers?.evidence || '未提供')}（${rec.evidenceVerified ? '程序已核对为该步卡片原文的子串' : '未核验通过'}）</p>` : ''}
        <details><summary>查看实际推荐材料与完整输出</summary><pre class="tl-req">${esc(json({ request: r.request, answers: rec.answers, attempts: rec.attempts }))}</pre></details>
        ${history.map(old => `<details data-recommendation-history><summary>此前推荐 · 原文与 hash 保留</summary><pre class="tl-req">${esc(json(old))}</pre></details>`).join('')}
        ${!d && rec.retryPolicy === 'manual' && rec.fallbackReason === 'parse_failed' ? '<p class="hint">没有取得模型判断；回退方案默认切在发消息那一步。请自行选择判断与切点后确认，或手动再次请求推荐（最多一次）；不会自动重试。</p>' : ''}
        ${requestButton(c, r)}
        ${(r.decisionHistory || []).map(old => `<details data-decision-history><summary>历史确认 · 已被用户改判，不计入</summary><pre class="tl-req">${esc(json(old))}</pre></details>`).join('')}
        ${d?.reason ? `<p>用户改判原因：${esc(d.reason)}</p>` : ''}
        ${d ? `<p class="pill ok">已冻结：${esc(kindLabel(d.kind))}${d.cutStep ? ' · 第 ' + d.cutStep + ' 步' : ''} · ${reportCut(c) ? '切点检查报告 · trace 级身份和组别不变' : d.level === 'reference' ? '只作参考' : esc(d.level) + ' 级'}</p><p class="trace-hash mono">决定 SHA-256：${esc(d.hash)}</p><p>确认来源：${d.confirmation?.source === 'user-via-planner' ? '用户经规划者转达' : '用户在 Badcase 页确认'}${d.confirmation?.reference ? ` · ${esc(d.confirmation.reference)}` : ''}${d.kind !== rec.kindSuggestion || d.kind === 'single' && d.cutStep !== rec.cutStepSuggestion ? ' · 用户改判（原推荐保留在上方）' : ''}</p>` : `<label class="field">你的判断 <select data-dehydration-kind>${['single', 'throughout', 'unclear'].map(k => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}</select></label>
        <label class="field">单步型切点 <select data-dehydration-cut>${r.request.state.steps.map(s => `<option value="${s.step}" ${Number(f.cutStep) === s.step ? 'selected' : ''}>重新生成第 ${s.step} 步 · 原输出：${esc((s.messageBody || s.body).slice(0, 120))}</option>`).join('')}</select></label>
        <p class="hint">${reportNote(c)}确认后判断与切点永久冻结；切点可以早于被标记回复，此处不启动模型。</p><div data-cut-actions>${cutActions(c, r)}</div>`}</section>`;
    }
    function card(c, ts) {
      const p = plan(c), ref = c.traceBundle, tone = ref?.complete ? 'ok' : 'warn';
      return `<article class="bc" id="bc-${c.n}" data-case-id="${esc(c.id)}" data-actor="${p.actor}"><div class="bc-head"><span class="num">#${c.n}</span><h4>${hl(c.actual, ts)}</h4><div class="bc-meta"><span>${isGpt(c) ? 'GPT' : esc(c.role || c.source?.agentId || '其他模型')}</span><span>来自 ${hl(c.source?.conversationTitle || '未命名房间', ts)}</span><span>${confirmedGroup(c) ? '用户确认：' + splitName[confirmedGroup(c).confirmedSplit] + '组' : (splitName[c.split] || '待分配') + (c.split ? '组（旧记录）' : '')}</span><span class="pill ${hasScene(c) ? 'info' : 'warn'}">${levelLabel(c)}</span></div></div>
        <ol class="stepper" aria-label="从标记到入库的步骤">${p.steps.map(([status, text], i) => `<li class="${status}" title="${esc(labels[i] + '：' + text)}"><span class="bar"></span><span class="lab">${labels[i]}</span><span class="sr-only">${esc(text)}</span></li>`).join('')}</ol>
        <div class="next-line"><span class="who ${p.actor === 'system' ? 'sys' : p.actor === 'you' ? 'you' : 'none'}">${p.actor === 'system' ? '系统' : p.actor === 'you' ? '你' : p.actor === 'library' ? '已入库' : '到此为止'}</span><span>${esc(p.next)}</span>${p.action === 'assertion' ? `<a class="btn small" href="#case-${c.n}">去「用例」页${pipeline(c).assertion.version ? '查看或另存断言' : '起草断言'}</a>` : p.action === 'group' ? '<button type="button" class="btn small" data-bc-go-group>去分组区确认标签或分组</button>' : ''}</div>
        <div class="chips"><span class="pill ${tone}">${backfill(c)}</span>${hasScene(c) ? `<span class="pill warn">现场：${esc(sceneNote(c))}</span>` : '<span class="pill">无现场</span>'}</div>
        ${ref?.missingReasons?.length ? `<p class="hint">缺失：${ref.missingReasons.map(r => `<span title="${esc(r)}">${esc(reasonLabels[r] || r)}</span>`).join('；')}</p>` : ''}
        ${confirmedGroup(c) ? `<p class="pill ok">用户确认：${esc(splitName[confirmedGroup(c).confirmedSplit])}组 · 已生效；旧记录保留</p>` : ''}
        ${dehydration(c)?.decision ? `<details class="more"><summary>脱水决定与推荐记录（已冻结）</summary>${dehydrationPanel(c)}</details>` : dehydrationPanel(c)}
        <div class="bc-detail-grid">${patternPanel(c) || `<section class="bc-card"><h4>九步说明</h4><ul class="steps-detail">${p.steps.map(([status, text], i) => `<li><span class="k">${labels[i]}</span><span class="st-${status}">${esc(text)}</span></li>`).join('')}</ul></section>`}
        <div class="bc-detail-stack"><section class="bc-card"><h4>问题与期望</h4><p>${hl(c.actual, ts)}</p><p class="case-exp"><span class="lbl">期望</span> ${hl(c.expected, ts)}</p></section>${assertionPanel(c)}<section class="bc-card"><h4>复现与回放</h4><p>${esc(replayText(c))}</p>${precheckPanel(c)}${controlPanel(c)}<details><summary>历史正式评测／单次回放（不作预检准入）</summary><p>${esc(originalText(c))}</p></details><p>${esc(backfill(c))}</p>${reportPanel(c)}${replayPanel(c)}</section></div></div>
        ${patternLabel(c) ? `<details class="more"><summary>九步说明</summary><ul class="steps-detail">${p.steps.map(([status, text], i) => `<li><span class="k">${labels[i]}</span><span class="st-${status}">${esc(text)}</span></li>`).join('')}</ul></details>` : ''}
        <details class="more trace" data-trace-case="${esc(c.id)}" ${expanded.has(c.id) ? 'open' : ''}><summary>轨迹与上下文${ref ? `（${ref.stepCount} 次模型调用）` : ''}</summary><div data-trace-host="${esc(c.id)}"></div></details></article>`;
    }
    function renderCards() {
      const ts = words(q), visible = D.cases.filter(c => matches([c.actual, c.expected, c.source?.conversationTitle, '#' + c.n].join(' '), ts)
        && (currentPattern === 'all' || patternKey(c) === currentPattern) && (model === 'all' || (model === 'gpt') === isGpt(c))
        && (stage === 'all' || stage === actorBucket(plan(c).actor)));
      if (!visible.some(c => c.id === selected)) selected = visible[0]?.id || null;
      $('[data-list-pattern]').textContent = currentPattern === 'all' ? '显示全部模式（在上方切换）' : '只显示：' + patterns().find(x => x.key === currentPattern)?.title;
      $('[data-bc-summary]').textContent = `显示 ${visible.length} / ${D.cases.length} 条 · 按下一步分组；不自动调用模型或改分组。`;
      $('[data-bc-body]').innerHTML = Object.entries(names).map(([key, title]) => {
        const rows = visible.filter(c => actorBucket(plan(c).actor) === key);
        return rows.length ? `<div class="bc-row-group"><b>${title}</b><span>${rows.length}</span></div>${rows.map(c => {
          const p = plan(c);
          return `<button type="button" class="bc-row" data-bc-row="${esc(c.id)}" aria-current="${selected === c.id}" title="${esc(p.next)}"><span class="n">#${c.n}</span><span class="t">${hl(c.actual, ts)}</span><span class="who ${p.actor === 'system' ? 'sys' : p.actor === 'you' ? 'you' : 'none'}">${p.actor === 'you' ? '你' : p.actor === 'system' ? '系统' : p.actor === 'library' ? '已入库' : '到此为止'}</span><span class="m">${esc(levelLabel(c))} · ${esc(splitName[c.split] || '待分配')}</span><span class="mini" aria-label="九步进度">${p.steps.map(([status, text], i) => `<i class="${status}" title="${esc(labels[i] + '：' + text)}"></i>`).join('')}</span></button>`;
        }).join('')}` : '';
      }).join('') || '<p class="muted-note">没有符合条件的 badcase。</p>';
      const c = visible.find(c => c.id === selected), detail = $('[data-bc-detail]');
      // Keep the selected viewer DOM (search, disclosures, scroll) during list-only changes.
      const signature = c && json([c, pipeline(c), dehydration(c), caseRuns(c), frozenRubric(c), reportRows(c), patternLabel(c), confirmedGroup(c), splitProposal(c), ts]);
      if (detailSignature !== signature) {
        detail.innerHTML = c ? card(c, ts) : '<p class="muted-note">请选择符合筛选条件的用例。</p>'; detailSignature = signature; detail.scrollTop = 0;
        if (c && expanded.has(c.id)) { renderTrace(c); void loadTrace(c); }
      }
      root.querySelectorAll('[data-bc-filter]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.bcFilter === stage)));
    }
    function pickCase(id) {
      const c = D.cases.find(c => c.id === id); if (!c) return;
      selected = id; currentPattern = patternKey(c); q = ''; stage = 'all'; model = 'all';
      $('[data-bc-search]').value = ''; $('[data-bc-model]').value = 'all'; groupingPanel(); renderCards();
      $('[data-bc-detail]').scrollIntoView({ block: 'start' });
    }
    function chunks(packet) {
      const { context, steps, metrics, scene, ...meta } = packet;
      return [
        { key: 'context', label: '上下文', blocks: [{ label: '包信息（标记内容、hash 来源与缺失原因）', value: meta }, ...Object.entries(context || {}).map(([k, value]) => ({ label: k, value }))] },
        { key: 'steps', label: '轨迹', blocks: [...(steps || []).flatMap(s => {
          const { output, toolResults, ...info } = s;
          return [{ label: `模型调用 #${s.step}${s.step === packet.markedStep ? ' · 发出被标记消息' : ''} · 耗时与步骤信息`, value: info },
            { label: `模型调用 #${s.step} · 完整输出与工具调用参数`, value: output },
            ...(toolResults || []).map((v, i) => ({ label: `模型调用 #${s.step} · 工具完整结果 ${i + 1}`, value: v }))];
        }), { label: '耗时与 token', value: metrics }] },
        { key: 'scene', label: '现场', blocks: [{ label: '冻结的现场清单（无文件内容）', value: scene }] },
      ];
    }
    function renderTrace(c) {
      const host = [...root.querySelectorAll('[data-trace-host]')].find(el => el.dataset.traceHost === c.id); if (!host) return;
      const row = cache.get(c.id);
      if (!row || row.hash !== c.traceBundle?.hash || row.state === 'loading') { host.innerHTML = '<p class="hint" role="status">正在读取冻结轨迹包…</p>'; return; }
      if (row.state === 'error') { host.innerHTML = `<p class="muted-note" role="alert">冻结包读取失败；未回退到摘录。</p><button type="button" class="btn small" data-trace-retry="${esc(c.id)}">重试读取</button>`; return; }
      if (!row.packet) { host.innerHTML = '<p class="muted-note">没有冻结轨迹包；不使用旧摘录冒充完整轨迹。</p>'; return; }
      const query = queries.get(c.id) || '', packet = row.packet, route = '/api/wikiskill/cases/' + encodeURIComponent(c.id) + '/trace';
      host.innerHTML = `<div class="trace-head"><span class="pill ${packet.complete ? 'ok' : 'warn'}">${packet.complete ? '完整冻结包' : '冻结包不完整 · 缺失已记录'}</span><span class="row-actions"><a class="btn small" data-export="json" href="${route}/export.json" download>导出 JSON</a><a class="btn small" data-export="md" href="${route}/export.md" download>导出 Markdown</a></span></div>
        <p class="trace-hash mono">SHA-256：${esc(c.traceBundle?.hash || '未记录')}</p><p class="hint">导出只读取同一冻结包；不重读源房间，不按搜索结果截断。</p>
        <label class="search"><input type="search" data-trace-search="${esc(c.id)}" aria-label="搜索本条完整轨迹" placeholder="搜索上下文、模型输出、工具参数及完整结果" value="${esc(query)}"></label><p class="hint" data-trace-matches aria-live="polite"></p><div data-trace-content></div>`;
      renderTraceContent(c, host);
    }
    function renderTraceContent(c, host) {
      const packet = cache.get(c.id)?.packet; if (!packet) return;
      const ts = words(queries.get(c.id)), sections = chunks(packet); let hits = 0;
      const html = sections.map(s => {
        const blocks = s.blocks.map(b => ({ ...b, text: json(b.value ?? null) })).filter(b => !ts.length || matches(b.label + ' ' + b.text, ts)); hits += blocks.length;
        return `<details class="trace-section" data-trace-section="${s.key}" ${ts.length && blocks.length ? 'open' : ''}><summary>${s.label}${ts.length ? ` · ${blocks.length} 处匹配` : ''}</summary>${s.key === 'scene' ? `<p class="hint">${hasScene(c) ? sceneLabel(packet.scene) + '。下方仅展示冻结清单；旧包不改，不从当前 Git 推断历史，也不宣称已能回放。' : '没有现场；旧题的样例仓库不当作原现场。'}</p>` : ''}${blocks.map(b => `<details class="trace-value" ${b.text.length <= 800 || ts.length ? 'open' : ''}><summary>${esc(b.label)} · ${b.text.length.toLocaleString()} 字符${b.text.length > 800 ? '（长内容默认折叠）' : ''}</summary><pre class="tl-req">${hl(b.text, ts)}</pre></details>`).join('') || '<p class="hint">没有匹配内容。</p>'}</details>`;
      }).join('');
      host.querySelector('[data-trace-content]').innerHTML = html; host.querySelector('[data-trace-matches]').textContent = ts.length ? `${hits} 处匹配（按内容块）；显示命中块的完整原文` : '搜索仅在本条冻结包内进行；长内容默认折叠，可展开查看全文。';
    }
    async function loadTrace(c, retry = false) {
      if (!c.traceBundle) { cache.set(c.id, { hash: undefined, state: 'ready', packet: null }); renderTrace(c); return; }
      const existing = cache.get(c.id), hash = c.traceBundle.hash;
      if (!retry && existing?.hash === hash) return;
      const row = { hash, state: 'loading', packet: null }; cache.set(c.id, row); renderTrace(c);
      try {
        const result = await fetchJson('/api/wikiskill/cases/' + encodeURIComponent(c.id) + '/trace');
        if (cache.get(c.id) !== row || !D.cases.some(v => v.id === c.id && v.traceBundle?.hash === hash)) return;
        if (!result?.traceBundle || result.traceBundle.kind !== 'wikiskill-trace-bundle') throw Error();
        row.packet = result.traceBundle; row.state = 'ready';
      } catch { if (cache.get(c.id) !== row) return; row.state = 'error'; }
      if (expanded.has(c.id)) renderTrace(c);
    }
    root.addEventListener('toggle', e => {
      const el = e.target;
      if (el.matches('[data-run-details]')) { if (el.open) void loadRun(el); return; }
      if (!el.matches('[data-trace-case]')) return;
      const id = el.dataset.traceCase, c = D.cases.find(c => c.id === id); if (!c) return;
      if (el.open) { expanded.add(id); renderTrace(c); void loadTrace(c); } else expanded.delete(id);
    }, true);
    root.addEventListener('click', e => {
      const el = e.target.closest('[data-control-confirm],[data-control-lock],[data-control-cancel],[data-bc-pattern],[data-bc-row],[data-bc-pick],[data-bc-filter],[data-bc-go-group],[data-trace-retry],[data-dehydration-confirm],[data-dehydration-lock],[data-dehydration-recommend],[data-dehydration-request-lock],[data-dehydration-cancel],[data-pattern-confirm],[data-pattern-lock],[data-label-cancel],[data-initial-split-confirm],[data-initial-split-lock],[data-split-cancel],[data-pending-link],[data-pending-link-lock],[data-link-cancel],[data-preclassify]'); if (!el || el.disabled) return;
      if (el.dataset.controlConfirm || el.dataset.controlLock || el.dataset.controlCancel) {
        const c = D.cases.find(c => c.id === (el.dataset.controlConfirm || el.dataset.controlLock || el.dataset.controlCancel));
        if (!c) return;
        if (el.dataset.controlCancel) { controlConsents.delete(c.id); refreshControlPanel(c); return; }
        if (!writable || !canConfirmControl(c) || typeof onConfirmControl !== 'function') return;
        if (el.dataset.controlConfirm) { controlConsents.set(c.id, controlKey(c)); refreshControlPanel(c); return; }
        if (controlConsents.get(c.id) !== controlKey(c)) { controlConsents.delete(c.id); refreshControlPanel(c); return; }
        controlConsents.delete(c.id); refreshControlPanel(c); onConfirmControl({ caseId: c.id, proposalHash: control(c).proposalHash }); return;
      }
      if (el.dataset.bcPattern) { const focused = el === document.activeElement; currentPattern = el.dataset.bcPattern; splitConsent = linkConsent = null; draftConsents.clear(); groupingPanel(); renderCards(); if (focused) [...root.querySelectorAll('.pat-seg [data-bc-pattern]')].find(b => b.dataset.bcPattern === currentPattern)?.focus({ preventScroll: true }); return; }
      if (el.dataset.bcRow) { const focused = el === document.activeElement; selected = el.dataset.bcRow; renderCards(); if (focused) [...root.querySelectorAll('[data-bc-row]')].find(b => b.dataset.bcRow === selected)?.focus({ preventScroll: true }); return; }
      if (el.dataset.bcPick) { pickCase(el.dataset.bcPick); return; }
      if (el.dataset.bcFilter) { stage = el.dataset.bcFilter; renderCards(); return; }
      if (el.hasAttribute('data-bc-go-group')) { currentPattern = patternKey(D.cases.find(c => c.id === selected)); groupingPanel(); $('[data-grouping]').scrollIntoView({ block: 'start' }); return; }
      if (el.dataset.labelCancel) { labelConsents.delete(el.dataset.labelCancel); refreshLabelPanels(D.cases.find(c => c.id === el.dataset.labelCancel)); return; }
      if (el.dataset.patternConfirm || el.dataset.patternLock) {
        const c = D.cases.find(c => c.id === (el.dataset.patternConfirm || el.dataset.patternLock)), label = c && patternLabel(c);
        if (!writable || !label || label.confirmed || typeof onConfirmPatternLabel !== 'function') return;
        const f = readLabelForm(el.closest('[data-pattern-label]'), c), selection = labelSelection(c, f);
        labelForms.set(c.id, f); labelErrors.delete(c.id);
        const pending = label.pendingOptions || pendingOptions();
        const error = !selection ? '请选择一类模式标签。' : f.kind === 'entry' && !label.options?.some(e => e.entryId === f.entryId) ? '请选择已通过的模式。'
          : f.kind === 'pending' && f.mode === 'join' && !pending.some(p => p.id === f.pendingId) ? '请选择待归纳新模式。'
          : f.kind === 'pending' && f.mode === 'create' ? !f.name.trim() || [...f.name.trim()].length > 40 ? '给新模式起个名字（1–40 字）。' : [...(label.options || []).map(e => e.title), ...pending.map(p => p.name)].includes(f.name.trim()) ? '已经有同名模式，请改名或选择加入。' : !f.scope.trim() || [...f.scope.trim()].length > 120 ? '请填一句话范围（1–120字）。' : '' : '';
        if (error) { labelErrors.set(c.id, error); labelConsents.delete(c.id); refreshLabelPanels(c); return; }
        if (el.dataset.patternConfirm) { labelConsents.set(c.id, { hash: label.labelHash, selection: json(selection) }); refreshLabelPanels(c); return; }
        const consent = labelConsents.get(c.id);
        if (consent?.hash !== label.labelHash || consent.selection !== json(selection)) { labelConsents.delete(c.id); refreshLabelPanels(c); return; }
        onConfirmPatternLabel({ caseId: c.id, ...selection, labelHash: label.labelHash }); return;
      }
      if (el.hasAttribute('data-split-cancel')) { splitConsent = null; groupingPanel(); return; }
      if (el.dataset.initialSplitConfirm || el.dataset.initialSplitLock) {
        const p = D.initialSplitProposal, patternKey = el.dataset.initialSplitConfirm || el.dataset.initialSplitLock, pattern = p?.patterns.find(r => r.patternKey === patternKey);
        if (!writable || !pattern || p.blockers?.length || !pattern.rows.some(r => r.proposedSplit) || typeof onConfirmInitialSplit !== 'function') return;
        if (el.dataset.initialSplitConfirm) { splitConsent = { key: patternKey, hash: p.hash }; groupingPanel(); return; }
        if (splitConsent?.key !== patternKey || splitConsent.hash !== p.hash) return;
        onConfirmInitialSplit({ proposalHash: p.hash, patternKey }); return;
      }
      if (el.hasAttribute('data-link-cancel')) { linkConsent = null; groupingPanel(); return; }
      if (el.dataset.pendingLink || el.dataset.pendingLinkLock) {
        const id = el.dataset.pendingLink || el.dataset.pendingLinkLock, x = patterns().find(x => x.key === id);
        if (!writable || typeof onLinkPendingPattern !== 'function' || !x?.cases.length || !x.cases.every(c => splitName[c.split]) || !pendingOptions().some(p => p.id === id && !p.entryId)) return;
        if (el.dataset.pendingLink) { const entryId = el.closest('[data-pending-link-panel]').querySelector('[data-pending-link-entry]').value; if (!approvedOptions().some(e => e.id === entryId)) return; linkConsent = { id, entryId }; groupingPanel(); return; }
        if (linkConsent?.id !== id || !approvedOptions().some(e => e.id === linkConsent.entryId)) return;
        onLinkPendingPattern({ pendingPatternId: id, entryId: linkConsent.entryId }); return;
      }
      if (el.hasAttribute('data-preclassify')) { if (writable && typeof onPreclassify === 'function' && preclassificationBatch().length) onPreclassify(); return; }
      if (el.dataset.dehydrationCancel) { cutConsents.delete(el.dataset.dehydrationCancel); const c = D.cases.find(c => c.id === el.dataset.dehydrationCancel); if (c) refreshCutPanel(c); return; }
      if (el.dataset.dehydrationRecommend || el.dataset.dehydrationRequestLock) {
        const c = D.cases.find(c => c.id === (el.dataset.dehydrationRecommend || el.dataset.dehydrationRequestLock)), r = c && dehydration(c);
        if (!writable || !c || !canRecommend(c, r) || typeof onRequestRecommendation !== 'function') return;
        if (el.dataset.dehydrationRecommend) { cutConsents.set(c.id, { operation: 'recommend', key: cutKey(c, r) }); refreshCutPanel(c); return; }
        const consent = cutConsents.get(c.id); if (consent?.operation !== 'recommend' || consent.key !== cutKey(c, r)) return;
        onRequestRecommendation({ caseId: c.id, traceHash: c.traceBundle.hash, ...(r ? { retryOf: r.hash } : {}) }); return;
      }
      if (el.dataset.dehydrationConfirm || el.dataset.dehydrationLock) {
        const c = D.cases.find(c => c.id === (el.dataset.dehydrationConfirm || el.dataset.dehydrationLock)), r = c && dehydration(c);
        if (!writable || !r || r.decision || typeof onConfirmDecision !== 'function') return;
        const host = el.closest('[data-dehydration]'), f = { kind: host.querySelector('[data-dehydration-kind]').value, cutStep: Number(host.querySelector('[data-dehydration-cut]').value) };
        if (!['single', 'throughout', 'unclear'].includes(f.kind) || f.kind === 'single' && !r.request.state.steps.some(s => s.step === f.cutStep)) return;
        cutForms.set(c.id, f); const body = cutBody(c, r, f);
        if (el.dataset.dehydrationConfirm) { cutConsents.set(c.id, { operation: 'freeze', key: cutKey(c, r), body: json(body) }); refreshCutPanel(c); return; }
        const consent = cutConsents.get(c.id); if (consent?.operation !== 'freeze' || consent.key !== cutKey(c, r) || consent.body !== json(body)) { cutConsents.delete(c.id); refreshCutPanel(c); return; }
        onConfirmDecision(body); return;
      }
      if (el.dataset.traceRetry) { const c = D.cases.find(c => c.id === el.dataset.traceRetry); if (c) void loadTrace(c, true); }
    });
    root.addEventListener('click', e => {
      const el = e.target.closest('[data-category-ask],[data-category-lock],[data-category-reject],[data-category-cancel],[data-propose-categories],[data-go-categories],[data-category-induct],[data-category-approve],[data-category-review-lock],[data-category-review-cancel],[data-category-reinduct]');
      if (!el || el.disabled) return;
      if (el.hasAttribute('data-go-categories')) { $('[data-categories]').scrollIntoView({ block: 'start' }); return; }
      if (!writable) return;
      if (el.hasAttribute('data-propose-categories')) { if (hasUncoveredCategoryCases() && typeof onProposeCategories === 'function') onProposeCategories(); return; }
      if (el.dataset.categoryInduct) { if (typeof onInductCategory === 'function' && patterns().some(x => x.key === el.dataset.categoryInduct && x.cases.length && x.cases.every(c => splitName[c.split]) && x.cases.some(c => c.split === 'train'))) onInductCategory({ pendingPatternId: el.dataset.categoryInduct }); return; }
      const card = el.closest('[data-category-card]');
      if (card) {
        const p = pendingCategoryProposals().find(p => p.hash === card.dataset.categoryCard); if (!p) return;
        if (el.hasAttribute('data-category-reject')) { if (typeof onRejectCategory === 'function') onRejectCategory({ proposalHash: p.hash }); return; }
        if (el.hasAttribute('data-category-cancel')) { categoryConsents.delete(p.hash); card.querySelector('[data-category-actions]').innerHTML = categoryActions(p); return; }
        if (typeof onConfirmCategory !== 'function') return;
        const f = categoryForm(p); f.name = card.querySelector('[data-category-name]').value; f.scope = card.querySelector('[data-category-scope]').value;
        f.members = [...card.querySelectorAll('[data-category-member]:checked')].filter(el => p.members.some(m => m.caseId === el.dataset.categoryMember && m.canConfirm === true)).map(el => el.dataset.categoryMember);
        const selection = categorySelection(p), conflict = !p.pendingPatternId && [...approvedOptions().map(e => e.title), ...pendingOptions().map(v => v.name)].includes(selection.name);
        const error = !selection.name || [...selection.name].length > 40 ? '名字须为1–40字。' : !selection.scope || [...selection.scope].length > 120 ? '范围须为1–120字。' : conflict ? '已经有同名模式或类别，请改名或逐条加入。' : !selection.members.length ? '至少勾选一条仍可确认的用例。' : '';
        categoryErrors.delete(p.hash);
        if (error) { categoryErrors.set(p.hash, error); categoryConsents.delete(p.hash); }
        else if (el.hasAttribute('data-category-ask')) categoryConsents.set(p.hash, json(selection));
        else if (categoryConsents.get(p.hash) === json(selection)) { onConfirmCategory(selection); return; }
        else categoryConsents.delete(p.hash);
        card.querySelector('[data-category-actions]').innerHTML = categoryActions(p); return;
      }
      const host = el.closest('[data-category-draft]'), p = pendingOptions().find(p => p.id === host?.dataset.categoryId && !p.entryId), x = p && patterns().find(x => x.key === p.id);
      const version = D.versions?.at(-1), entry = version?.entries.find(e => e.id === host?.dataset.categoryDraft && e.status === 'draft');
      if (!p || !x || !entry || typeof onReviewCategory !== 'function') return;
      const f = Object.fromEntries(contentFields.map(k => [k, host.querySelector(`[data-category-field="${k}"]`).value])); draftForms.set(entry.id, f); draftErrors.delete(entry.id);
      if (el.hasAttribute('data-category-review-cancel')) draftConsents.delete(entry.id);
      else if (el.hasAttribute('data-category-reinduct')) { onReviewCategory({ pendingPatternId: p.id, versionId: version.id, entryId: entry.id, decision: 'rejected' }); return; }
      else if (!sameCategoryTraining(entry, x)) { draftErrors.set(entry.id, '训练成员已改变，请驳回并重新归纳。'); draftConsents.delete(entry.id); }
      else if (contentFields.some(k => !f[k].trim()) || [...f.guideline].length > 300) { draftErrors.set(entry.id, '四项须非空，准则不超过300字。'); draftConsents.delete(entry.id); }
      else if (el.hasAttribute('data-category-approve')) draftConsents.set(entry.id, json(f));
      else if (draftConsents.get(entry.id) === json(f)) { onReviewCategory({ pendingPatternId: p.id, versionId: version.id, entryId: entry.id, decision: 'approved', patch: f }); return; }
      else draftConsents.delete(entry.id);
      host.querySelector('[data-category-review-actions]').innerHTML = categoryReviewActions(p, entry, x);
    });
    root.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || !e.target.matches('button[role="radio"]')) return;
      const group = e.target.closest('[role="radiogroup"]'); if (!group) return;
      const buttons = [...group.querySelectorAll('button[role="radio"]')].filter(b => !b.disabled), at = buttons.indexOf(e.target);
      if (at < 0) return; e.preventDefault();
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) + buttons.length) % buttons.length;
      buttons[index].focus(); buttons[index].click();
    });
    root.addEventListener('input', e => {
      const el = e.target;
      if (el.matches('[data-category-name],[data-category-scope]')) {
        const card = el.closest('[data-category-card]'), p = pendingCategoryProposals().find(p => p.hash === card.dataset.categoryCard); if (!p || !writable) return;
        const f = categoryForm(p); f.name = card.querySelector('[data-category-name]').value; f.scope = card.querySelector('[data-category-scope]').value;
        categoryConsents.delete(p.hash); categoryErrors.delete(p.hash); card.querySelector('[data-category-actions]').innerHTML = categoryActions(p);
        const c = D.cases.find(c => c.id === selected); if (c) refreshLabelPanels(c);
      }
      if (el.hasAttribute('data-category-field')) {
        const host = el.closest('[data-category-draft]'), entry = D.versions?.at(-1)?.entries.find(e => e.id === host.dataset.categoryDraft); if (!entry || !writable) return;
        draftForm(entry)[el.dataset.categoryField] = el.value; draftConsents.delete(entry.id); draftErrors.delete(entry.id);
        host.querySelector('[data-guideline-count]').textContent = [...draftForm(entry).guideline].length + ' / 300字';
        const p = pendingOptions().find(p => p.id === host.dataset.categoryId), x = patterns().find(x => x.key === p.id);
        host.querySelector('[data-category-review-actions]').innerHTML = categoryReviewActions(p, entry, x);
      }
      if (el.matches('[data-pattern-name],[data-pattern-scope]')) { const c = D.cases.find(c => c.id === el.closest('[data-pattern-label]').dataset.patternLabel); labelForms.set(c.id, readLabelForm(el.closest('[data-pattern-label]'), c)); labelErrors.delete(c.id); const hadConsent = labelConsents.delete(c.id); if (hadConsent) refreshLabelPanels(c); }
      if (el.hasAttribute('data-bc-search')) { q = el.value; renderCards(); }
      if (el.hasAttribute('data-trace-search')) { const c = D.cases.find(c => c.id === el.dataset.traceSearch); if (c) { queries.set(c.id, el.value); renderTraceContent(c, el.closest('[data-trace-host]')); } }
    });
    root.addEventListener('change', e => {
      const el = e.target;
      if (el.matches('[data-dehydration-kind],[data-dehydration-cut]')) {
        const host = el.closest('[data-dehydration]'), c = D.cases.find(c => c.id === host.dataset.dehydration); if (!writable || !c) return;
        cutForms.set(c.id, { kind: host.querySelector('[data-dehydration-kind]').value, cutStep: Number(host.querySelector('[data-dehydration-cut]').value) });
        cutConsents.delete(c.id); refreshCutPanel(c);
      }
      if (el.matches('[data-pattern-kind],[data-pattern-entry],[data-pattern-pending-mode],[data-pattern-pending-id]')) {
        const host = el.closest('[data-pattern-label]'), c = D.cases.find(c => c.id === host.dataset.patternLabel);
        labelForms.set(c.id, readLabelForm(host, c)); labelConsents.delete(c.id); labelErrors.delete(c.id); refreshLabelPanels(c);
      }
      if (el.hasAttribute('data-category-member')) {
        const card = el.closest('[data-category-card]'), p = pendingCategoryProposals().find(p => p.hash === card.dataset.categoryCard); if (!p || !writable || !p.members.some(m => m.caseId === el.dataset.categoryMember && m.canConfirm === true)) return;
        const f = categoryForm(p); f.members = [...card.querySelectorAll('[data-category-member]:checked')].map(v => v.dataset.categoryMember);
        categoryConsents.delete(p.hash); categoryErrors.delete(p.hash); categoryPanels();
        const c = D.cases.find(c => c.id === selected); if (c) refreshLabelPanels(c);
      }
      if (el.hasAttribute('data-pending-link-entry')) { linkConsent = null; syncWritable(); }
      if (el.hasAttribute('data-bc-model')) { model = el.value; renderCards(); }
    });
    function syncWritable() {
      for (const [selector, fn] of [['[data-control-confirm],[data-control-lock]', onConfirmControl], ['[data-dehydration-confirm],[data-dehydration-lock]', onConfirmDecision], ['[data-dehydration-recommend],[data-dehydration-request-lock]', onRequestRecommendation], ['[data-pattern-confirm],[data-pattern-lock]', onConfirmPatternLabel], ['[data-initial-split-confirm],[data-initial-split-lock]', onConfirmInitialSplit], ['[data-pending-link],[data-pending-link-lock]', onLinkPendingPattern], ['[data-preclassify]', onPreclassify], ['[data-propose-categories]', onProposeCategories], ['[data-category-induct]', onInductCategory], ['[data-category-ask],[data-category-lock]', onConfirmCategory], ['[data-category-reject]', onRejectCategory], ['[data-category-approve],[data-category-review-lock],[data-category-reinduct]', onReviewCategory]]) root.querySelectorAll(selector).forEach(b => { b.disabled = !writable || typeof fn !== 'function' || b.hasAttribute('data-category-stale') || b.hasAttribute('data-category-ask') && !categorySelection(pendingCategoryProposals().find(p => p.hash === b.closest('[data-category-card]').dataset.categoryCard)).members.length || b.hasAttribute('data-pattern-confirm') && !formFor(D.cases.find(c => c.id === b.dataset.patternConfirm)).kind || b.hasAttribute('data-pending-link') && !approvedOptions().some(e => e.id === b.closest('[data-pending-link-panel]').querySelector('[data-pending-link-entry]').value); });
      root.querySelectorAll('[data-pattern-kind],[data-pattern-entry],[data-pattern-pending-mode],[data-pattern-pending-id],[data-pattern-name],[data-pattern-scope]').forEach(el => { el.disabled = !writable || typeof onConfirmPatternLabel !== 'function' || el.matches('[data-pattern-pending-mode][value="join"]') && !pendingOptions().length; });
      root.querySelectorAll('[data-dehydration-kind],[data-dehydration-cut]').forEach(el => { el.disabled = !writable || typeof onConfirmDecision !== 'function' || el.hasAttribute('data-dehydration-cut') && el.closest('[data-dehydration]').querySelector('[data-dehydration-kind]').value !== 'single'; });
      root.querySelectorAll('[data-dehydration-cancel]').forEach(el => { el.disabled = !writable; });
      root.querySelectorAll('[data-pending-link-entry]').forEach(el => { el.disabled = !writable || typeof onLinkPendingPattern !== 'function'; });
      root.querySelectorAll('[data-category-name],[data-category-scope],[data-category-member]').forEach(el => { const p = pendingCategoryProposals().find(p => p.hash === el.closest('[data-category-card]').dataset.categoryCard); el.disabled = !writable || typeof onConfirmCategory !== 'function' || el.hasAttribute('data-category-member') && !p?.members.some(m => m.caseId === el.dataset.categoryMember && m.canConfirm === true); });
      root.querySelectorAll('[data-category-field]').forEach(el => { el.disabled = !writable || typeof onReviewCategory !== 'function'; });
      root.querySelectorAll('[data-category-cancel],[data-category-review-cancel]').forEach(el => { el.disabled = !writable; });
    }
    return { setWritable(value) { writable = !!value; if (!writable && controlConsents.size) { controlConsents.clear(); const c = D.cases.find(c => c.id === selected); if (c) refreshControlPanel(c); } syncWritable(); }, render(data) {
      D = data; splitConsent = linkConsent = null; controlConsents.clear(); cutForms.clear(); cutConsents.clear(); labelForms.clear(); labelConsents.clear(); labelErrors.clear(); categoryForms.clear(); categoryConsents.clear(); categoryErrors.clear(); draftForms.clear(); draftConsents.clear(); draftErrors.clear(); detailSignature = null;
      const selectedCase = D.cases.find(c => c.id === selected);
      if (currentPattern === 'pending' && !D.cases.some(c => patternKey(c) === 'pending') && selectedCase && patternLabel(selectedCase)?.confirmed) currentPattern = patternKey(selectedCase);
      const linked = D.pendingPatternLinks?.find(l => l.pendingPatternId === currentPattern); if (linked) currentPattern = linked.entryId;
      for (const [id, row] of cache) if (!D.cases.some(c => c.id === id && c.traceBundle?.hash === row.hash)) cache.delete(id); funnel(); categoryPanels(); groupingPanel(); renderCards(); syncWritable(); },
      focus(n) { const c = D.cases.find(c => c.n === Number(n)); if (c) pickCase(c.id); } };
  };
})();
