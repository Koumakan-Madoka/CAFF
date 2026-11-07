// @ts-check
(function registerBadcasePipeline() {
  const shared = window.CaffShared || (window.CaffShared = {});
  // Loading is read-only. Only explicit guarded actions request a recommendation
  // or freeze a decision; no automatic calls, retries, replay, grading or regrouping.
  shared.createBadcasePipeline = function ({ root, fetchJson, onConfirmDecision, onRequestRecommendation, onConfirmPatternLabel, onConfirmInitialSplit, confirm: confirmAction = message => window.confirm(message) }) {
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
    const labels = ['标记', '现场', '脱水', '归类', '分组', '断言', '回放检查', '原版复现', '入库'];
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
    let detailSignature = null;
    let writable = [onConfirmDecision, onRequestRecommendation, onConfirmPatternLabel, onConfirmInitialSplit].some(fn => typeof fn === 'function');
    const dehydration = c => (D.dehydrations || []).findLast(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash);
    const excludedRun = (c, r) => dehydration(c)?.decision?.level === 'reference' && dehydration(c)?.decision?.supersedesDecisionHash === r.decisionHash;
    const caseRuns = c => (D.runReplays || []).filter(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash && (r.decisionHash === dehydration(c)?.decision?.hash || excludedRun(c, r)));
    const activeRuns = c => dehydration(c)?.decision?.level === 'run' ? caseRuns(c).filter(r => !excludedRun(c, r)) : [];
    const baselineMissing = c => { const row = (D.pipelineStates || []).find(r => r.caseId === c.id); return row ? row.stopReason === 'invalid_baseline' : activeRuns(c).some(r => r.baselineStatus === 'no_valid_output'); };
    const kindLabel = k => ({ single: '单步型', throughout: '贯穿型', unclear: '说不清（按贯穿型）' }[k] || k);
    const activeGrouping = () => (D.regroupConfirmations || []).findLast(r => r.status === 'active');
    const confirmedGroup = c => {
      const initial = (D.initialSplitConfirmations || []).flatMap(r => r.proposal.rows.filter(row => row.patternKey === r.patternKey && row.proposedSplit)).find(r => r.caseId === c.id);
      return initial ? { ...initial, confirmedSplit: initial.proposedSplit } : activeGrouping()?.rows?.find(r => r.caseId === c.id && !r.reason && r.confirmedSplit);
    };
    const patternLabel = c => (D.casePatterns || []).find(r => r.caseId === c.id);
    const splitProposal = c => D.initialSplitProposal?.rows.find(r => r.caseId === c.id && r.proposedSplit);
    root.innerHTML = `<div class="groups badcase-pipeline"><section class="sec bc-panel"><h2>从 badcase 到测试用例</h2>
      <div class="howline" aria-label="trace 级还是 run 级怎么定"><span class="how-step">系统自动：这一轮有现场吗</span><span>→ 有：<b>trace 级</b></span><span>｜没有：DeepSeek 推荐 → <b>你决定</b></span><span>→ 单步型：<b>run 级</b></span><span>贯穿型 / 说不清：只作参考</span></div>
      <details><summary class="hint">展开说明</summary><p class="hint">现场在这一轮开始前自动封存。有现场一律走 trace，从这一轮开头执行到自然结束；有现场的 run 执行器尚未实现。无现场经 DeepSeek 推荐、你确认后冻结判断和切点，run 在切点上只调一次模型，不执行工具。原版始终无有效回复的是无效测试用例，不算通过也不算不通过。测试只收 trace；门槛 run 不超过 trace。训练组初筛暂未启用。分组确认不启动回放或评测。</p></details><div class="lanes" data-funnels></div></section>
      <section class="sec bc-panel" data-grouping></section>
      <div class="bc-master-detail"><section class="bc-panel bc-index" aria-label="Badcase 列表"><label class="search"><input data-bc-search type="search" aria-label="搜索 badcase" placeholder="搜索问题、期望、来源房间或编号" autocomplete="off"></label>
      <div class="seg" role="radiogroup" aria-label="按下一步筛选">${[['all', '全部'], ['you', '等你'], ['system', '系统'], ['library', '已入库'], ['stop', '到此为止']].map(([key, name]) => `<button type="button" data-bc-filter="${key}" aria-checked="${key === 'all'}" role="radio">${name}</button>`).join('')}</div>
      <details><summary class="hint">更多筛选</summary><label class="field">模型 <select data-bc-model><option value="all">全部</option><option value="gpt">GPT</option><option value="other">非 GPT</option></select></label></details>
      <p class="hint" data-list-pattern></p><p class="summary" data-bc-summary></p><div class="bc-rows" data-bc-body></div></section><section class="bc-detail" data-bc-detail aria-label="选中用例详情" aria-live="polite"></section></div></div>`;
    const $ = s => root.querySelector(s);
    const isGpt = c => /gpt/i.test(c.source?.agentId || c.role || '');
    const hasScene = c => !!c.sealedCheckpointId;
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
      const prefix = a.version ? `已冻结 v${a.version} · ${a.questions.length} 条 · ${a.model || '打分模型未记录'}` : '还没有冻结的断言；可去「用例」页起草并确认';
      return prefix + (a.status === 'incompatible' ? '；run 级只能以回复为依据，需另存一版；旧版保留' : a.status === 'stale' ? '；问题或期望已变，需另存一版' : '') + (a.draftVersion ? `；另有 v${a.draftVersion} 草稿待确认` : '');
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
    function assertionPanel(c) {
      const a = pipeline(c).assertion;
      return `<section class="dehydration-panel" data-assertion-slot="${esc(c.id)}"><h4>断言 · 评分 v2</h4><p>${esc(assertionText(c))}</p>${a.questions.map(q => `<div class="assertion-readonly"><b>${esc(q.id)}</b> · 依据：${esc({ reply: '回复', trace: '轨迹', files: '文件' }[q.evidence] || q.evidence)}<p>${esc(q.question)}</p></div>`).join('')}<a class="btn small" href="#case-${c.n}">去「用例」页${a.version ? '查看或另存断言' : '起草断言'}</a><p class="hint">这里只读展示冻结版本；跳转不调用模型或启动评测。冻结断言不会自动启动判分；「原版复现」只反映已有评测结果。</p></section>`;
    }
    function plan(c) {
      const has = hasScene(c), old = sourceOnly(c), other = !isGpt(c), cs = D.caseStates?.find(s => s.caseId === c.id), r = dehydration(c), d = r?.decision;
      const status = pipeline(c), reference = !has && d?.level === 'reference', invalidCase = !has && baselineMissing(c);
      const steps = [
        ['done', c.kind === 'text-only' ? '用户批准的历史导入' : '页面标记'],
        [has ? c.traceBundle?.scene?.metadataStatus === 'recorded' ? 'done' : 'pending' : 'alt', has ? sceneNote(c) + '；元数据不等于已通过回放检查' : '没有现场；须先确认能否脱水'],
        [old || has || d ? 'done' : 'pending', old ? '不脱水、不改组，只作旧题来源' : d ? `用户已冻结：${kindLabel(d.kind)}${d.cutStep ? '，切点第 ' + d.cutStep + ' 步' : '；' + (reference ? '无现场，只作参考' : '仍走 trace 级')}` : has ? '有现场，走 trace 级；现场 run 级回放尚未实现，暂不开放脱水' : r ? 'DeepSeek 推荐已生成，等待你确认能否脱水和切点' : 'DeepSeek 推荐尚未生成；用户确认后冻结判断与切点'],
        [patternLabel(c)?.confirmed || cs?.memberships?.length ? 'done' : 'pending', patternLabel(c)?.confirmed ? patternLabel(c).entryId ? '已有已确认模式标签' : '已确认：未归入现有模式' : cs?.memberships?.length ? '已有已确认模式标签' : '待确认模式标签；不自动改模式或加入归纳'],
        [old || splitName[c.split] ? 'done' : 'pending', old ? '原测试分组保留' : confirmedGroup(c) ? `用户确认的${splitName[confirmedGroup(c).confirmedSplit]}组已生效；原提议和旧分组记录保留` : splitProposal(c) ? `提议：${splitName[splitProposal(c).proposedSplit]}组，等你确认后冻结` : !splitName[c.split] ? '待分配；模式标签及有效原版证据齐备后，按模式提议分组' : `已有${splitName[c.split]}组保留，不重新分配`],
        [status.assertion.status === 'frozen' ? 'done' : ['incompatible', 'stale'].includes(status.assertion.status) ? 'warn' : 'pending', assertionText(c)],
        [status.replay.status === 'supported' ? 'done' : status.replay.status === 'unsupported' ? 'warn' : 'pending', replayText(c)],
        [status.original.reproduced ? 'done' : status.original.unscored || status.original.valid ? 'alt' : 'pending', originalText(c)],
        [status.inLibrary ? 'done' : 'pending', status.inLibrary ? `${splitName[c.split]}组 · ${has ? 'trace' : 'run'} 级 · 已分组、断言冻结、回放检查通过、原版问题已复现；不表示采纳候选` : '尚未入库；须已分组、断言已冻结、回放检查通过且原版问题已复现'],
      ];
      if (old || other) for (let i = old ? 5 : 2; i < 9; i++) steps[i] = ['skip', old ? '只作旧题来源，不单独入库' : '只报告，不计入 GPT 结论'];
      if (reference) for (let i = 4; i < 9; i++) steps[i] = ['skip', '无现场且非单步型；只作参考和训练组文字材料，不成为测试用例'];
      if (invalidCase && !reference && !old && !other) for (const i of [4, 5, 7, 8]) steps[i] = ['skip', '原版无有效输出：无效测试用例，不进门槛和初筛；不算通过也不算不通过'];
      const labelPending = patternLabel(c) && !patternLabel(c).confirmed;
      const baselinePending = !has && d?.level === 'run' && !status.original.outputs && !status.original.valid && !status.original.unscored && !invalidCase;
      const needsAssertion = status.assertion.status !== 'frozen' && (has || d?.level === 'run' && !baselinePending);
      const actor = other ? 'other' : old ? 'source' : reference ? 'reference' : invalidCase ? 'invalid' : r && !d || labelPending || splitProposal(c) ? 'you' : needsAssertion ? 'you' : status.inLibrary ? 'library' : 'system';
      const next = other ? '非 GPT 来源，只报告' : old ? '保留旧题来源，不脱水、不改组' : reference ? '只作参考，不进入 run 级回放或选题'
        : invalidCase ? '原版无有效输出：无效测试用例，不进门槛和初筛；保留原文，不自动补跑'
        : r && !d ? '请确认能否脱水与切点；确认后不可修改'
        : labelPending ? '请确认模式标签；仅记录标签，不改组别和归纳成员'
        : splitProposal(c) ? '请核对并确认此模式的新用例分组'
        : baselinePending ? '等待受信操作方取得原版有效输出；每批调用前须经规划者向用户确认，本页不启动回放'
        : needsAssertion ? (has ? sceneNote(c) + '；有现场，走 trace 级；' : '') + assertionText(c)
        : status.inLibrary ? `${splitName[c.split]}组${has ? ' trace' : ' run'} 级测试用例，等待候选；本页不启动评测`
        : has ? sceneNote(c) + '；有现场，走 trace 级；' + (status.replay.status !== 'supported' ? replayText(c) : status.assertion.status !== 'frozen' ? assertionText(c) : originalText(c))
        : !d ? '等待 DeepSeek 推荐，再请你确认'
        : status.assertion.status !== 'frozen' ? assertionText(c) : originalText(c);
      return { steps, actor, next, action: labelPending || splitProposal(c) ? 'group' : actor === 'you' && needsAssertion && !(r && !d) ? 'assertion' : null };
    }
    function funnel() {
      const gpt = D.cases.filter(isGpt), tr = gpt.filter(c => hasScene(c) && !sourceOnly(c)), refs = gpt.filter(c => !hasScene(c) && dehydration(c)?.decision?.level === 'reference'), rn = gpt.filter(c => !hasScene(c) && !sourceOnly(c) && dehydration(c)?.decision?.level === 'run');
      const lane = (key, title, note, cells) => `<div class="lane" data-lane="${key}"><div class="lane-head"><b>${title}</b><span>${note}</span></div><div class="funnel">${cells.map(([n, l]) => `<div class="f-step ${n ? '' : 'zero'}"><b>${n}</b><span>${l}</span></div>`).join('')}</div></div>`;
      $('[data-funnels]').innerHTML = lane('trace', 'trace 级', '有现场；从这一轮开头执行到自然结束；不能把封存当作已通过回放检查', [[tr.length, 'GPT 且有封存现场'], [tr.filter(c => c.traceBundle).length, '已冻结轨迹包'], [tr.filter(c => pipeline(c).replay.status === 'supported').length, '回放检查通过'], [tr.filter(c => pipeline(c).assertion.status === 'frozen').length, '断言已冻结'], [tr.filter(c => pipeline(c).inLibrary).length, '已入库']])
        + lane('run', 'run 级（脱水）', `无现场；冻结切点只调一次模型；只作参考 ${refs.length} 条不计入，未确认的也不计入`, [[rn.length, '用户确认可脱水'], [rn.filter(c => pipeline(c).replay.status === 'supported').length, '前缀可构造请求'], [rn.filter(c => pipeline(c).original.outputs || pipeline(c).original.valid || pipeline(c).original.unscored).length, '原版有有效输出'], [rn.filter(c => pipeline(c).assertion.status === 'frozen').length, '断言已冻结（依据回复）'], [rn.filter(c => pipeline(c).inLibrary).length, '已入库']]);
      const runs = gpt.flatMap(activeRuns), excluded = gpt.flatMap(c => caseRuns(c).filter(r => excludedRun(c, r)));
      if (runs.length || excluded.length) $('[data-funnels]').insertAdjacentHTML('beforeend', `<p data-run-totals>单次 run 回放共 ${runs.length} 次：有效输出 ${runs.filter(r => r.status === 'reached').length}；无效 ${runs.filter(r => r.status === 'invalid').length}（不算通过也不算不通过）；请求失败 ${runs.filter(r => r.status === 'error').length}；结果未知 ${runs.filter(r => r.status === 'reserved').length}。有效输出不代表判分通过。原版无有效输出 ${gpt.filter(baselineMissing).length} 题，不进门槛和初筛。${excluded.length ? `历史回放已被用户改判，不计入：${excluded.length} 次（原文保留）。` : ''}</p>`);
    }
    const patternKey = c => { const p = patternLabel(c); return p?.confirmed ? p.patternKey || p.entryId || 'unclassified' : 'pending'; };
    function patterns() {
      const options = new Map([...(D.versions?.at(-1)?.entries || []).filter(e => e.status === 'approved').map(e => [e.id, e.title]), ...(D.casePatterns || []).flatMap(r => r.options || []).map(e => [e.entryId, e.title])]);
      options.set('unclassified', '未归入现有模式'); options.set('pending', '模式标签待确认');
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
      if (cases.some(c => patternKey(c) === 'pending')) return '尚不能评测候选：先确认模式标签；旧的分组和结果不等于归类已确认';
      const ready = cases.filter(c => pipeline(c).inLibrary && isGpt(c) && !sourceOnly(c));
      const gate = ready.filter(c => c.split === 'gate'), test = ready.filter(c => c.split === 'test' && hasScene(c));
      const control = D.cases.some(c => !cases.includes(c) && c.split === 'gate' && pipeline(c).inLibrary && isGpt(c) && !sourceOnly(c) && patternKey(c) !== 'pending');
      const missing = [!gate.length && '可用门槛题', !test.length && '可用 trace 测试题', !control && '其他模式的可用防误伤题'].filter(Boolean);
      return missing.length ? '尚不能评测候选：缺' + missing.join('、') : '有可用门槛、测试和其他模式的防误伤题；正式计划仍须预检';
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
        body = `<h3>${esc(x.title)}</h3><p class="hint" data-board-quotas>配额按已确认模式计算：trace 训练:门槛:测试 2:1:1；run 训练:门槛 2:1；本模式门槛 run 不超过 trace。${['trace', 'run'].map(level => `${level}：${['train', 'gate', 'test'].map(g => `${splitName[g]} ${counts[level][g]}${pattern?.counts && pattern.counts[level][g] !== counts[level][g] ? ' → ' + pattern.counts[level][g] : ''}`).join(' / ')}`).join('；')}。旧题来源不占配额，已有组别不变。</p>
          <div class="bc-board">${['train', 'gate', 'test', 'out'].map(g => `<section class="bc-column ${g === 'out' ? 'out' : ''}" data-board-column="${g}"><h4>${splitName[g] || '不参与 / 待分配'}</h4>${g === 'out' ? rows.filter(r => r.group === g).map(r => `<div class="bc-out-row">${chip(r)}<span class="hint">${esc(reasons[r.reason] || '待分配：尚无满足条件的提议')}</span></div>`).join('') || '<span class="hint">—</span>' : ['trace', 'run', 'old', 'pending'].map(level => { const members = rows.filter(r => r.group === g && r.level === level); return members.length ? `<div class="bc-level-row"><span class="hint">${{ old: '旧题来源（不改）', pending: '层级待确认' }[level] || level}</span><div class="chips">${members.map(chip).join('')}</div></div>` : ''; }).join('') || '<span class="hint">—</span>'}</section>`).join('')}</div>
          <p class="hint" data-board-readiness>${esc(readiness(x.cases))}</p>
          <div data-initial-split>${!p?.blockers?.length && pattern?.rows.some(r => r.proposedSplit) ? `<p>虚线是新用例的提议，尚未生效；你确认后才冻结。</p><button type="button" class="btn primary" data-initial-split-confirm="${esc(currentPattern)}" ${writable && typeof onConfirmInitialSplit === 'function' ? '' : 'disabled'}>确认此模式的新用例分组</button>` : '<p class="hint">目前没有满足条件的待确认分组提议；系统不自动改组。</p>'}</div>
          ${x.cases.filter(c => patternLabel(c) && !patternLabel(c).confirmed).map(c => `<div class="bc-label-confirm"><b>#${c.n} ${esc(c.actual)}</b>${patternPanel(c)}</div>`).join('')}`;
      }
      host.innerHTML = `<h2>分组</h2><p class="hint">先选模式，再看本模式的分组。实线是已生效的组别；紫色虚线是首次分组提议。测试只收 trace；训练组初筛暂未启用。</p><div class="seg pat-seg" role="radiogroup" aria-label="模式">${all.map(x => tab(x.key, x.title, x.cases.length)).join('')}${tab('all', '全部模式（总览）')}</div>
        ${p?.blockers?.length ? `<div data-initial-split-blocked role="alert"><p>${esc(p.blockingMessage)}</p><p class="hint">已有组别的活动 GPT 用例标签尚未确认，整体暂停首次分组提议和确认；请选「模式标签待确认」补齐，不改变已有组别。</p></div>` : ''}${body}
        <details data-group-audit><summary>变化记录与审计信息（默认折叠）</summary><p class="hint">旧分组、提议、确认及其原文保留。旧提议不在此重新确认；这里没有自动应用或启动评测的入口。</p><pre class="tl-req">${esc(json({ initialProposal: p, initialConfirmations: D.initialSplitConfirmations || [], proposals: D.regroupProposals || [], confirmations: D.regroupConfirmations || [] }))}</pre></details>`;
    }
    function patternPanel(c) {
      const label = patternLabel(c); if (!label) return '';
      const title = label.options.find(e => e.entryId === label.entryId)?.title || '未归入现有模式';
      if (label.confirmed) return `<p class="pill ok" data-pattern-label="${esc(c.id)}">模式标签已确认：${esc(title)} · 不改变组别和归纳成员</p>`;
      return `<section class="dehydration-panel" data-pattern-label="${esc(c.id)}"><h4>确认模式标签</h4><p>仅记录标签，不改组别、不加入归纳成员；门槛和测试旧题也可补确认。</p><label class="field">模式 <select data-pattern-entry><option value="">未归入现有模式</option>${label.options.map(e => `<option value="${esc(e.entryId)}" ${c.preclassification?.entryId === e.entryId ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></label>${c.preclassification ? '<p class="hint">默认选择来自预分类建议；尚未经你确认。</p>' : ''}<button type="button" class="btn primary" data-pattern-confirm="${esc(c.id)}" ${writable && typeof onConfirmPatternLabel === 'function' ? '' : 'disabled'}>确认模式标签</button></section>`;
    }
    function replayPanel(c) {
      const rows = caseRuns(c), active = activeRuns(c), excluded = rows.filter(r => excludedRun(c, r)); if (!rows.length) return '';
      const labels = { reached: '有效输出（待判分）', invalid: '无效 · 不算通过也不算不通过', error: '请求失败（不冒充模型答案）', reserved: '已占用 · 结果未知，不自动重试' };
      return `<section class="dehydration-panel" data-run-panel="${esc(c.id)}"><h4>单次 run 级回放</h4>${baselineMissing(c) ? '<p class="pill warn">原版无有效输出：无效测试用例，不进门槛和初筛。</p>' : ''}<p>有效输出 ${active.filter(r => r.status === 'reached').length} · 无效 ${active.filter(r => r.status === 'invalid').length}（不算通过也不算不通过） · 请求失败 ${active.filter(r => r.status === 'error').length} · 结果未知 ${active.filter(r => r.status === 'reserved').length}。单次原始回放不表示判分通过；正式判分见「原版复现」，不在本页重新判分。${excluded.length ? `历史回放已被用户改判，不计入：${excluded.length} 次。` : ''}</p>${rows.map(r => `<details data-run-details="${esc(r.id)}" data-run-case="${esc(c.id)}"><summary>${r.variant.kind === 'original' ? '原版' : '候选 ' + esc(r.variant.id)} · ${excludedRun(c, r) ? '已被用户改判，不计入（历史回放）' : esc(labels[r.status] || r.status)} · 查看完整输出及实际请求</summary><p>${esc(r.model)} · thinking ${esc(r.thinking)} · 模型调用 ${r.modelCalls ?? '未知'} · 工具执行 ${r.toolExecutions ?? '未知'}</p><p class="trace-hash mono">请求 SHA-256：${esc(r.id)}<br>结果 SHA-256：${esc(r.resultHash || '未取得')}</p><p class="hint">当前分类以 accounting 为准；原始包中的历史分类只供审计，不参与当前计数。</p><p>${['json', 'md'].map(format => `<a class="btn small" data-run-export="${format}" href="/api/wikiskill/cases/${encodeURIComponent(c.id)}/run-replays/${encodeURIComponent(r.id)}/export.${format}" download>导出回放 ${format === 'json' ? 'JSON' : 'Markdown'}</a>`).join(' ')}</p><div data-run-body></div></details>`).join('')}</section>`;
    }
    async function loadRun(details) {
      if (!details.isConnected) return;
      const id = details.dataset.runDetails, caseId = details.dataset.runCase, host = details.querySelector('[data-run-body]');
      const render = row => { host.textContent = ''; const pre = document.createElement('pre'); pre.className = 'tl-req'; pre.textContent = row.state === 'ready' ? json(row.packet) : row.state === 'error' ? '回放记录读取失败；未使用其他结果兜底。' : '正在读取完整回放记录…'; host.appendChild(pre); };
      if (runCache.has(id)) { render(runCache.get(id)); return; }
      const row = { state: 'loading', packet: null }; runCache.set(id, row); render(row);
      try { const packet = await fetchJson('/api/wikiskill/cases/' + encodeURIComponent(caseId) + '/run-replays/' + encodeURIComponent(id)); if (!packet?.reservation) throw Error(); row.packet = packet; row.state = 'ready'; }
      catch { row.state = 'error'; runCache.delete(id); }
      if (details.isConnected) render(row);
    }
    function requestButton(c, r) {
      if (hasScene(c) || !c.traceBundle || c.source?.agentId !== 'role-family-gpt' || sourceOnly(c) || r?.decision || !c.dehydrationRecommendation?.eligible) return '';
      return `<p class="hint">每次点击只请求一次 DeepSeek；不会执行工具或自动确认。</p><button type="button" class="btn" data-dehydration-recommend="${esc(c.id)}" ${writable && typeof onRequestRecommendation === 'function' ? '' : 'disabled'}>${r ? '再次请求推荐' : '请求推荐'}</button>`;
    }
    function dehydrationPanel(c) {
      const r = dehydration(c); if (sourceOnly(c) || !isGpt(c)) return '';
      if (!r) { const button = requestButton(c, r); return button ? `<section class="dehydration-panel" data-dehydration="${esc(c.id)}"><h4>脱水 · 能否脱水</h4>${button}</section>` : ''; }
      const rec = r.recommendation, d = r.decision;
      const fallbackLabel = { parse_failed: '两次输出仍无法解析', evidence_mismatch: '依据与该步卡片原文不匹配', no_cut: '未给出切点', unclear: '模型说不清', not_single: '模型判断为贯穿型' };
      const provider = rec.schemaVersion === 2 ? 'DeepSeek' : '历史 JEV';
      if (rec.retryPolicy === 'manual') fallbackLabel.parse_failed = '本次输出无法解析';
      const history = (D.dehydrations || []).filter(old => old.caseId === c.id && old.traceHash === r.traceHash && old.hash !== r.hash);
      return `<section class="dehydration-panel" data-dehydration="${esc(c.id)}"><h4>能否脱水</h4>${d?.supersedesDecisionHash ? '<p class="pill warn">原推荐与历史确认已被用户改判，不计入；原文和 hash 保留。</p>' : ''}<p>${rec.schemaVersion === 2 && !rec.answers ? '未取得可解析的 DeepSeek 判断；回退切点：第 ' : provider + ' 建议：' + esc(kindLabel(rec.kindSuggestion)) + '；建议切点：第 '}${rec.cutStepSuggestion} 步${rec.cutSource === 'marked_step_fallback' ? `（${esc(fallbackLabel[rec.fallbackReason] || '未达建议条件')}，回退到发消息步骤${d ? '；用户决定见下方' : '，请你挑选'}）` : ''}。</p>
        ${rec.schemaVersion === 2 ? `<p>理由：${esc(rec.answers?.reason || '未取得可解析答案，不代表模型给出了判断')}</p><p>原文依据：${esc(rec.answers?.evidence || '未提供')}（${rec.evidenceVerified ? '程序已核对为该步卡片原文的子串' : '未核验通过'}）</p>` : ''}
        <details><summary>查看实际推荐材料与完整输出</summary><pre class="tl-req">${esc(json({ request: r.request, answers: rec.answers, attempts: rec.attempts }))}</pre></details>
        ${history.map(old => `<details data-recommendation-history><summary>此前推荐 · 原文与 hash 保留</summary><pre class="tl-req">${esc(json(old))}</pre></details>`).join('')}
        ${!d && rec.retryPolicy === 'manual' && rec.fallbackReason === 'parse_failed' ? '<p class="hint">没有取得模型判断；回退方案默认切在发消息那一步。请自行选择判断与切点后确认，或手动再次请求推荐（最多一次）；不会自动重试。</p>' : ''}
        ${requestButton(c, r)}
        ${(r.decisionHistory || []).map(old => `<details data-decision-history><summary>历史确认 · 已被用户改判，不计入</summary><pre class="tl-req">${esc(json(old))}</pre></details>`).join('')}
        ${d?.reason ? `<p>用户改判原因：${esc(d.reason)}</p>` : ''}
        ${d ? `<p class="pill ok">已冻结：${esc(kindLabel(d.kind))}${d.cutStep ? ' · 第 ' + d.cutStep + ' 步' : ''} · ${d.level === 'reference' ? '只作参考' : esc(d.level) + ' 级'}</p><p class="trace-hash mono">决定 SHA-256：${esc(d.hash)}</p><p>确认来源：${d.confirmation?.source === 'user-via-planner' ? '用户经规划者转达' : '用户在 Badcase 页确认'}${d.confirmation?.reference ? ` · ${esc(d.confirmation.reference)}` : ''}${d.kind !== rec.kindSuggestion || d.kind === 'single' && d.cutStep !== rec.cutStepSuggestion ? ' · 用户改判（原推荐保留在上方）' : ''}</p>` : `<label class="field">你的判断 <select data-dehydration-kind>${['single', 'throughout', 'unclear'].map(k => `<option value="${k}" ${rec.kindSuggestion === k ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}</select></label>
        <label class="field">单步型切点 <select data-dehydration-cut>${r.request.state.steps.map(s => `<option value="${s.step}" ${rec.cutStepSuggestion === s.step ? 'selected' : ''}>第 ${s.step} 步 · ${esc((s.messageBody || s.body).slice(0, 120))}</option>`).join('')}</select></label>
        <p class="hint">贯穿型或说不清且无现场，只作参考，不成为测试用例。确认后判断与切点永久冻结；此处不启动模型。</p><button type="button" class="btn primary" data-dehydration-confirm="${esc(c.id)}" ${writable && typeof onConfirmDecision === 'function' ? '' : 'disabled'}>确认并冻结判断与切点</button>`}</section>`;
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
        <div class="bc-detail-grid"><section class="bc-card"><h4>九步说明</h4><ul class="steps-detail">${p.steps.map(([status, text], i) => `<li><span class="k">${labels[i]}</span><span class="st-${status}">${esc(text)}</span></li>`).join('')}</ul></section>
        <div class="bc-detail-stack"><section class="bc-card"><h4>问题与期望</h4><p>${hl(c.actual, ts)}</p><p class="case-exp"><span class="lbl">期望</span> ${hl(c.expected, ts)}</p></section>${assertionPanel(c)}<section class="bc-card"><h4>复现与回放</h4><p>${esc(replayText(c))}</p><p>${esc(originalText(c))}</p><p>${esc(backfill(c))}</p>${replayPanel(c)}</section></div></div>
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
      const signature = c && json([c, pipeline(c), dehydration(c), caseRuns(c), patternLabel(c), confirmedGroup(c), splitProposal(c), ts]);
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
      const el = e.target.closest('[data-bc-pattern],[data-bc-row],[data-bc-pick],[data-bc-filter],[data-bc-go-group],[data-trace-retry],[data-dehydration-confirm],[data-dehydration-recommend],[data-pattern-confirm],[data-initial-split-confirm]'); if (!el || el.disabled) return;
      if (el.dataset.bcPattern) { const focused = el === document.activeElement; currentPattern = el.dataset.bcPattern; groupingPanel(); renderCards(); if (focused) [...root.querySelectorAll('.pat-seg [data-bc-pattern]')].find(b => b.dataset.bcPattern === currentPattern)?.focus({ preventScroll: true }); return; }
      if (el.dataset.bcRow) { const focused = el === document.activeElement; selected = el.dataset.bcRow; renderCards(); if (focused) [...root.querySelectorAll('[data-bc-row]')].find(b => b.dataset.bcRow === selected)?.focus({ preventScroll: true }); return; }
      if (el.dataset.bcPick) { pickCase(el.dataset.bcPick); return; }
      if (el.dataset.bcFilter) { stage = el.dataset.bcFilter; renderCards(); return; }
      if (el.hasAttribute('data-bc-go-group')) { currentPattern = patternKey(D.cases.find(c => c.id === selected)); groupingPanel(); $('[data-grouping]').scrollIntoView({ block: 'start' }); return; }
      if (el.dataset.patternConfirm) {
        const c = D.cases.find(c => c.id === el.dataset.patternConfirm), label = c && patternLabel(c);
        if (!writable || !label || label.confirmed || typeof onConfirmPatternLabel !== 'function') return;
        const entryId = el.closest('[data-pattern-label]').querySelector('[data-pattern-entry]').value || null;
        const title = label.options.find(e => e.entryId === entryId)?.title || '未归入现有模式';
        if (!confirmAction(`确认 #${c.n} 的模式标签：${title}？只记录标签，不改组别、不加入归纳成员，不调用模型。`)) return;
        onConfirmPatternLabel({ caseId: c.id, entryId, labelHash: label.labelHash }); return;
      }
      if (el.dataset.initialSplitConfirm) {
        const p = D.initialSplitProposal, patternKey = el.dataset.initialSplitConfirm, pattern = p?.patterns.find(r => r.patternKey === patternKey);
        if (!writable || !pattern || p.blockers?.length || typeof onConfirmInitialSplit !== 'function') return;
        const rows = pattern.rows.filter(r => r.proposedSplit);
        if (!rows.length || !confirmAction(`确认冻结以下新用例的首次分组？已有组别不变，不启动回放或评测。\n${rows.map(r => '#' + (D.cases.find(c => c.id === r.caseId)?.n || r.caseNumber) + ' · ' + r.level + ' → ' + splitName[r.proposedSplit]).join('\n')}\n提议 hash：${p.hash}`)) return;
        onConfirmInitialSplit({ proposalHash: p.hash, patternKey }); return;
      }
      if (el.dataset.dehydrationRecommend) {
        const c = D.cases.find(c => c.id === el.dataset.dehydrationRecommend), r = c && dehydration(c);
        if (!writable || !c || hasScene(c) || !c.dehydrationRecommendation?.eligible || r?.decision || typeof onRequestRecommendation !== 'function') return;
        if (!confirmAction(`为 #${c.n} 请求一次 DeepSeek 推荐？将发送冻结的起因、步骤卡片、回复和问题/期望；不自动重试或确认。`)) return;
        onRequestRecommendation({ caseId: c.id, traceHash: c.traceBundle.hash, ...(r ? { retryOf: r.hash } : {}) }); return;
      }
      if (el.dataset.dehydrationConfirm) {
        const c = D.cases.find(c => c.id === el.dataset.dehydrationConfirm), r = c && dehydration(c);
        if (!writable || !r || r.decision || typeof onConfirmDecision !== 'function') return;
        const host = el.closest('[data-dehydration]'), kind = host.querySelector('[data-dehydration-kind]').value;
        const cutStep = kind === 'single' ? Number(host.querySelector('[data-dehydration-cut]').value) : null;
        if (!confirmAction(`确认冻结 #${c.n}：${kindLabel(kind)}${cutStep ? '，切点第 ' + cutStep + ' 步' : '；' + (hasScene(c) ? '仍走 trace 级' : '无现场，只作参考')}？之后不能修改；不会启动模型。`)) return;
        onConfirmDecision({ caseId: c.id, traceHash: r.traceHash, recommendationHash: r.hash, kind, cutStep }); return;
      }
      if (el.dataset.traceRetry) { const c = D.cases.find(c => c.id === el.dataset.traceRetry); if (c) void loadTrace(c, true); }
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
      if (el.hasAttribute('data-bc-search')) { q = el.value; renderCards(); }
      if (el.hasAttribute('data-trace-search')) { const c = D.cases.find(c => c.id === el.dataset.traceSearch); if (c) { queries.set(c.id, el.value); renderTraceContent(c, el.closest('[data-trace-host]')); } }
    });
    root.addEventListener('change', e => { const el = e.target; if (el.hasAttribute('data-bc-model')) { model = el.value; renderCards(); } });
    return { setWritable(value) { writable = !!value; root.querySelectorAll('[data-dehydration-confirm]').forEach(b => { b.disabled = !writable || typeof onConfirmDecision !== 'function'; }); root.querySelectorAll('[data-dehydration-recommend]').forEach(b => { b.disabled = !writable || typeof onRequestRecommendation !== 'function'; }); root.querySelectorAll('[data-pattern-confirm]').forEach(b => { b.disabled = !writable || typeof onConfirmPatternLabel !== 'function'; }); root.querySelectorAll('[data-initial-split-confirm]').forEach(b => { b.disabled = !writable || typeof onConfirmInitialSplit !== 'function'; }); }, render(data) { D = data; for (const [id, row] of cache) if (!D.cases.some(c => c.id === id && c.traceBundle?.hash === row.hash)) cache.delete(id); funnel(); groupingPanel(); renderCards(); },
      focus(n) { const c = D.cases.find(c => c.n === Number(n)); if (c) pickCase(c.id); } };
  };
})();
