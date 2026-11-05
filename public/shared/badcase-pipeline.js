// @ts-check
(function registerBadcasePipeline() {
  const shared = window.CaffShared || (window.CaffShared = {});
  // Loading is read-only. Only an explicit user action freezes a decision;
  // this component never calls a model, starts a replay, grades or changes groups.
  shared.createBadcasePipeline = function ({ root, fetchJson, onConfirmDecision, confirm: confirmAction = message => window.confirm(message) }) {
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
    const names = { you: '等你处理', system: '系统可以继续', source: '旧题的来源', reference: '只作参考', invalid: '无效测试用例', other: '非 GPT 来源' };
    const splitName = { train: '训练', gate: '门槛', test: '测试' };
    const sceneWait = '待接入 · 待采集能力合入';
    const reasonLabels = {
      original_context_unavailable: '没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复',
      context_archive_missing: '没有新版上下文归档', system_prompt_missing: '未保存当时的系统提示词',
      system_prompt_display_redacted: '系统提示词为历史展示版，路径行已占位', provider_request_bytes_missing: '未保存供应商请求原始字节',
      context_truncated: '原上下文曾被截断', model_duration_missing: '未记录逐次模型耗时', model_usage_missing: '未记录模型用量',
      turn_end_inferred_from_usage: '旧轮次终点按调用次数推导', turn_bounds_recovered_from_unique_reply: '旧轮次按唯一回复及父链恢复',
      turn_bounds_missing: '缺少可确认的轮次边界', turn_bounds_invalid: '轮次边界与日志不符', session_missing: '没有对应会话日志',
      session_path_unavailable: '无法定位获准的会话日志', session_invalid: '会话日志格式无法核验', session_outside_instance: '会话日志不在本实例内',
      session_unreadable: '会话日志无法读取', session_too_large: '会话日志超过读取上限', turn_trigger_missing: '无法定位本轮触发消息',
      model_outputs_missing: '没有可确认的当轮模型输出', marked_step_unresolved: '无法定位发出被标记消息的步骤',
      tool_result_missing: '工具结果未保存齐全', orphan_tool_result: '存在无法关联到调用的工具结果',
      sealed_marked_turn_not_recorded: '封存材料未录制被标记的这一轮', sealed_prompt_may_have_controlled_replacements: '封存提示词可能含回放路径占位符',
      scene_metadata_pending_capture_integration: '现场元数据待采集能力合入',
      scene_head_not_recorded: '现场未记录历史提交', scene_branch_not_recorded: '现场未记录历史分支',
      checkpoint_missing: '未找到原现场清单', checkpoint_unreadable: '原现场清单无法读取', source_message_missing: '未找到原消息', marked_message_truncated: '原回复存档被截断',
    };
    let D = { cases: [], caseStates: [] }, q = '', stage = 'all', model = 'all', mode = 'group';
    const cache = new Map(), expanded = new Set(), queries = new Map(), runCache = new Map();
    let writable = typeof onConfirmDecision === 'function';
    const dehydration = c => (D.dehydrations || []).find(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash);
    const excludedRun = (c, r) => dehydration(c)?.decision?.level === 'reference' && dehydration(c)?.decision?.supersedesDecisionHash === r.decisionHash;
    const caseRuns = c => (D.runReplays || []).filter(r => r.caseId === c.id && r.traceHash === c.traceBundle?.hash && (r.decisionHash === dehydration(c)?.decision?.hash || excludedRun(c, r)));
    const activeRuns = c => dehydration(c)?.decision?.level === 'run' ? caseRuns(c).filter(r => !excludedRun(c, r)) : [];
    const baselineMissing = c => activeRuns(c).some(r => r.baselineStatus === 'no_valid_output');
    const kindLabel = k => ({ single: '单步型', throughout: '贯穿型', unclear: '说不清（按贯穿型）' }[k] || k);
    root.innerHTML = `<div class="groups badcase-pipeline"><section class="sec"><h2>从 badcase 到测试用例</h2><p class="hint">有现场默认走 trace 级；无现场须经 DeepSeek 推荐、你确认后脱水成 run 级。测试组只收 trace 级，门槛中 run 级不超过一半，训练组 run 级只作初筛。旧分组保留，重新分组尚待你确认。</p><div data-funnels></div></section>
      <div class="toolbar"><label class="search"><input data-bc-search type="search" aria-label="搜索 badcase" placeholder="搜索问题、期望、来源房间或编号" autocomplete="off"></label>
      <label class="field">卡在 <select data-bc-stage><option value="all">全部</option><option value="you">等你处理</option><option value="system">系统可以继续</option><option value="scene">现场待接入</option><option value="noscene">无现场（待脱水）</option><option value="dehydrate">脱水</option><option value="source">旧题的来源</option><option value="reference">只作参考</option><option value="invalid">无效测试用例</option><option value="other">非 GPT 来源</option></select></label>
      <label class="field">模型 <select data-bc-model><option value="all">全部</option><option value="gpt">GPT</option><option value="other">非 GPT</option></select></label>
      <div class="seg" role="radiogroup" aria-label="Badcase 显示方式"><button type="button" role="radio" data-bc-mode="group" aria-checked="true">按下一步分组</button><button type="button" role="radio" data-bc-mode="list" aria-checked="false">列表</button></div></div>
      <p class="summary" data-bc-summary></p><div class="groups" data-bc-body></div></div>`;
    const $ = s => root.querySelector(s);
    const isGpt = c => /gpt/i.test(c.source?.agentId || c.role || '');
    const hasScene = c => !!c.sealedCheckpointId;
    // Goal B8's three immutable historical sources, not their synthetic tests.
    const sourceOnly = c => [4, 10, 14].includes(c.n);
    const levelLabel = c => sourceOnly(c) ? '旧题来源' : dehydration(c)?.decision?.level === 'reference' ? '只作参考' : dehydration(c)?.decision?.level === 'run' ? baselineMissing(c) ? 'run 级 · 原版无有效输出' : 'run 级 · 决定已冻结' : hasScene(c) ? 'trace 级 · 现场待接入' : 'run 级 · 待脱水确认';
    function backfill(c) {
      const r = c.traceBundle;
      if (!r) return '未归档 · 尚无冻结轨迹包';
      if (r.origin === 'backfill') return r.complete ? '回填完成' : r.stepCount ? '回填部分完成 · 存在缺失' : '无法回填当轮输出 · 已记录原因';
      return r.complete ? '标记时已冻结' : '标记时已冻结 · 存在缺失';
    }
    function plan(c) {
      const has = hasScene(c), old = sourceOnly(c), other = !isGpt(c), cs = D.caseStates?.find(s => s.caseId === c.id), r = dehydration(c), d = r?.decision;
      const reference = d?.level === 'reference', invalidCase = baselineMissing(c), replayed = activeRuns(c).some(r => r.status === 'reached' || r.status === 'invalid');
      const steps = [
        ['done', c.kind === 'text-only' ? '用户批准的历史导入' : '页面标记'],
        [has ? 'pending' : 'alt', has ? sceneWait + '；已有封存清单不等于现场元数据齐全' : '没有现场；须先确认能否脱水'],
        [old || has || d ? 'done' : 'pending', old ? '不脱水、不改组，只作旧题来源' : d ? `用户已冻结：${kindLabel(d.kind)}${d.cutStep ? '，切点第 ' + d.cutStep + ' 步' : '；' + (reference ? '无现场，只作参考' : '仍走 trace 级')}` : has ? '默认 trace 级；可另选脱水' : r ? 'DeepSeek 推荐已生成，等待你确认能否脱水和切点' : 'DeepSeek 推荐尚未生成；用户确认后冻结判断与切点'],
        [cs?.memberships?.length ? 'done' : 'pending', cs?.memberships?.length ? '已有已确认模式标签' : '待归类；不自动改模式'],
        [old ? 'done' : 'pending', old ? '原测试分组保留' : '旧分组保留；分层重新分组待用户确认'],
        ['pending', '评分 v2 待接入：断言及逐条判定由独立 Goal 负责'],
        [replayed ? 'done' : 'pending', replayed ? '已用冻结切点前缀单次调用；未执行工具，不做前缀一致性检验' : '待检查冻结输入；旧回放登记不等于本流程检查通过'],
        [replayed ? 'alt' : 'pending', replayed ? '单次回放原文已保存；是否复现及判分由评分 v2 接入后判断' : '待原版复现；旧字面评分不作新版入库证据'],
        ['pending', '前置条件未齐，不宣称已成为合格测试用例'],
      ];
      if (old || other) for (let i = old ? 5 : 2; i < 9; i++) steps[i] = ['skip', old ? '只作旧题来源，不单独入库' : '只报告，不计入 GPT 结论'];
      if (reference) for (let i = 4; i < 9; i++) steps[i] = ['skip', '无现场且非单步型；只作参考和训练组文字材料，不成为测试用例'];
      if (invalidCase && !reference && !old && !other) for (const i of [4, 5, 7, 8]) steps[i] = ['skip', '原版无有效输出：无效测试用例，不进门槛和初筛；不算通过也不算不通过'];
      const actor = other ? 'other' : old ? 'source' : reference ? 'reference' : invalidCase ? 'invalid' : r && !d ? 'you' : 'system';
      return { steps, actor, next: other ? '非 GPT 来源，只报告' : old ? '保留旧题来源，不脱水、不改组' : reference ? '只作参考，不进入 run 级回放或选题' : invalidCase ? '原版无有效输出：无效测试用例，不进门槛和初筛；保留原文，不自动补跑' : d ? replayed ? '回放原文已保存，等待分组和评分 v2；本页不判分' : '脱水决定已冻结，等待原版单次回放；不会自动启动' : r ? '请确认能否脱水与切点；确认后不可修改' : has ? sceneWait : '等待 DeepSeek 推荐，再请你确认' };
    }
    function funnel() {
      const gpt = D.cases.filter(isGpt), tr = gpt.filter(hasScene), refs = gpt.filter(c => dehydration(c)?.decision?.level === 'reference'), rn = gpt.filter(c => !hasScene(c) && !sourceOnly(c) && !refs.includes(c));
      const lane = (key, title, note, cells) => `<div class="lane" data-lane="${key}"><div class="lane-head"><b>${title}</b><span>${note}</span></div><div class="funnel">${cells.map(([n, l]) => `<div class="f-step ${n ? '' : 'zero'}"><b>${n}</b><span>${l}</span></div>`).join('')}</div></div>`;
      $('[data-funnels]').innerHTML = lane('trace', 'trace 级', '有现场；完整采集能力待合入，不能把封存当作已通过回放检查', [[tr.length, 'GPT 且有封存现场'], [tr.filter(c => c.traceBundle).length, '已冻结轨迹包'], [0, '新版回放检查通过'], [0, '新版断言已冻结'], [0, '本流程合格测试用例']])
        + lane('run', 'run 级（脱水）', `无现场待脱水，不含 #4、#10、#14 的旧题来源；只作参考 ${refs.length} 条不计入；尚未确认的不是 run 级测试用例`, [[rn.length, 'GPT 无现场待脱水'], [rn.filter(c => c.traceBundle?.stepCount).length, '已恢复当轮轨迹'], [rn.filter(c => c.traceBundle?.complete).length, '完整轨迹包'], [rn.filter(c => dehydration(c)?.decision?.level === 'run').length, '用户确认可脱水'], [0, '门槛用例 / 初筛用例']]);
      const runs = gpt.flatMap(activeRuns), excluded = gpt.flatMap(c => caseRuns(c).filter(r => excludedRun(c, r)));
      if (runs.length || excluded.length) $('[data-funnels]').insertAdjacentHTML('beforeend', `<p data-run-totals>单次 run 回放共 ${runs.length} 次：有效输出 ${runs.filter(r => r.status === 'reached').length}；无效 ${runs.filter(r => r.status === 'invalid').length}（不算通过也不算不通过）；请求失败 ${runs.filter(r => r.status === 'error').length}；结果未知 ${runs.filter(r => r.status === 'reserved').length}。有效输出不代表判分通过。原版无有效输出 ${gpt.filter(baselineMissing).length} 题，不进门槛和初筛。${excluded.length ? `历史回放已被用户改判，不计入：${excluded.length} 次（原文保留）。` : ''}</p>`);
    }
    function replayPanel(c) {
      const rows = caseRuns(c), active = activeRuns(c), excluded = rows.filter(r => excludedRun(c, r)); if (!rows.length) return '';
      const labels = { reached: '有效输出（未判分）', invalid: '无效 · 不算通过也不算不通过', error: '请求失败（不冒充模型答案）', reserved: '已占用 · 结果未知，不自动重试' };
      return `<section class="dehydration-panel" data-run-panel="${esc(c.id)}"><h4>单次 run 级回放</h4>${baselineMissing(c) ? '<p class="pill warn">原版无有效输出：无效测试用例，不进门槛和初筛。</p>' : ''}<p>有效输出 ${active.filter(r => r.status === 'reached').length} · 无效 ${active.filter(r => r.status === 'invalid').length}（不算通过也不算不通过） · 请求失败 ${active.filter(r => r.status === 'error').length} · 结果未知 ${active.filter(r => r.status === 'reserved').length}。这里只报告原文和计数，尚未接入判分。${excluded.length ? `历史回放已被用户改判，不计入：${excluded.length} 次。` : ''}</p>${rows.map(r => `<details data-run-details="${esc(r.id)}" data-run-case="${esc(c.id)}"><summary>${r.variant.kind === 'original' ? '原版' : '候选 ' + esc(r.variant.id)} · ${excludedRun(c, r) ? '已被用户改判，不计入（历史回放）' : esc(labels[r.status] || r.status)} · 查看完整输出及实际请求</summary><p>${esc(r.model)} · thinking ${esc(r.thinking)} · 模型调用 ${r.modelCalls ?? '未知'} · 工具执行 ${r.toolExecutions ?? '未知'}</p><p class="trace-hash mono">请求 SHA-256：${esc(r.id)}<br>结果 SHA-256：${esc(r.resultHash || '未取得')}</p><p class="hint">当前分类以 accounting 为准；原始包中的历史分类只供审计，不参与当前计数。</p><p>${['json', 'md'].map(format => `<a class="btn small" data-run-export="${format}" href="/api/wikiskill/cases/${encodeURIComponent(c.id)}/run-replays/${encodeURIComponent(r.id)}/export.${format}" download>导出回放 ${format === 'json' ? 'JSON' : 'Markdown'}</a>`).join(' ')}</p><div data-run-body></div></details>`).join('')}</section>`;
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
    function dehydrationPanel(c) {
      const r = dehydration(c); if (!r || sourceOnly(c) || !isGpt(c)) return '';
      const rec = r.recommendation, d = r.decision;
      const fallbackLabel = { parse_failed: '两次输出仍无法解析', evidence_mismatch: '依据与该步卡片原文不匹配', no_cut: '未给出切点', unclear: '模型说不清', not_single: '模型判断为贯穿型' };
      const provider = rec.schemaVersion === 2 ? 'DeepSeek' : '历史 JEV';
      return `<section class="dehydration-panel" data-dehydration="${esc(c.id)}"><h4>能否脱水</h4>${d?.supersedesDecisionHash ? '<p class="pill warn">原推荐与历史确认已被用户改判，不计入；原文和 hash 保留。</p>' : ''}<p>${provider} 建议：${esc(kindLabel(rec.kindSuggestion))}；建议切点：第 ${rec.cutStepSuggestion} 步${rec.cutSource === 'marked_step_fallback' ? `（${esc(fallbackLabel[rec.fallbackReason] || '未达建议条件')}，回退到发消息步骤${d ? '；用户决定见下方' : '，请你挑选'}）` : ''}。</p>
        ${rec.schemaVersion === 2 ? `<p>理由：${esc(rec.answers?.reason || '未取得可解析答案，不代表模型给出了判断')}</p><p>原文依据：${esc(rec.answers?.evidence || '未提供')}（${rec.evidenceVerified ? '程序已核对为该步卡片原文的子串' : '未核验通过'}）</p>` : ''}
        <details><summary>查看实际推荐材料与完整输出</summary><pre class="tl-req">${esc(json({ request: r.request, answers: rec.answers, attempts: rec.attempts }))}</pre></details>
        ${(r.decisionHistory || []).map(old => `<details data-decision-history><summary>历史确认 · 已被用户改判，不计入</summary><pre class="tl-req">${esc(json(old))}</pre></details>`).join('')}
        ${d?.reason ? `<p>用户改判原因：${esc(d.reason)}</p>` : ''}
        ${d ? `<p class="pill ok">已冻结：${esc(kindLabel(d.kind))}${d.cutStep ? ' · 第 ' + d.cutStep + ' 步' : ''} · ${d.level === 'reference' ? '只作参考' : esc(d.level) + ' 级'}</p><p class="trace-hash mono">决定 SHA-256：${esc(d.hash)}</p><p>确认来源：${d.confirmation?.source === 'user-via-planner' ? '用户经规划者转达' : '用户在 Badcase 页确认'}${d.confirmation?.reference ? ` · ${esc(d.confirmation.reference)}` : ''}${d.kind !== rec.kindSuggestion || d.kind === 'single' && d.cutStep !== rec.cutStepSuggestion ? ' · 用户改判（原推荐保留在上方）' : ''}</p>` : `<label class="field">你的判断 <select data-dehydration-kind>${['single', 'throughout', 'unclear'].map(k => `<option value="${k}" ${rec.kindSuggestion === k ? 'selected' : ''}>${esc(kindLabel(k))}</option>`).join('')}</select></label>
        <label class="field">单步型切点 <select data-dehydration-cut>${r.request.state.steps.map(s => `<option value="${s.step}" ${rec.cutStepSuggestion === s.step ? 'selected' : ''}>第 ${s.step} 步 · ${esc((s.messageBody || s.body).slice(0, 120))}</option>`).join('')}</select></label>
        <p class="hint">贯穿型或说不清且无现场，只作参考，不成为测试用例。确认后判断与切点永久冻结；此处不启动模型。</p><button type="button" class="btn primary" data-dehydration-confirm="${esc(c.id)}" ${writable ? '' : 'disabled'}>确认并冻结判断与切点</button>`}</section>`;
    }
    function card(c, ts) {
      const p = plan(c), ref = c.traceBundle, tone = ref?.complete ? 'ok' : 'warn';
      return `<article class="bc" id="bc-${c.n}" data-case-id="${esc(c.id)}"><div class="bc-head"><span class="num">#${c.n}</span><h4>${hl(c.actual, ts)}</h4><div class="bc-meta"><span>${isGpt(c) ? 'GPT' : esc(c.role || c.source?.agentId || '其他模型')}</span><span>来自 ${hl(c.source?.conversationTitle || '未命名房间', ts)}</span><span>${splitName[c.split] || '未定组'}${c.split ? '组（旧记录）' : ''}</span><span class="pill ${hasScene(c) ? 'info' : 'warn'}">${levelLabel(c)}</span></div></div>
        <ol class="stepper" aria-label="从标记到入库的步骤">${p.steps.map(([status, text], i) => `<li class="${status}" title="${esc(labels[i] + '：' + text)}"><span class="bar"></span><span class="lab">${labels[i]}</span><span class="sr-only">${esc(text)}</span></li>`).join('')}</ol>
        <div class="next-line"><span class="who ${p.actor === 'system' ? 'sys' : 'none'}">${p.actor === 'system' ? '系统' : p.actor === 'you' ? '你' : '到此为止'}</span><span>${esc(p.next)}</span></div>
        <div class="chips"><span class="pill ${tone}">${backfill(c)}</span>${hasScene(c) ? `<span class="pill warn">现场：${sceneWait}</span>` : '<span class="pill">无现场</span>'}</div>
        ${ref?.missingReasons?.length ? `<p class="hint">缺失：${ref.missingReasons.map(r => `<span title="${esc(r)}">${esc(reasonLabels[r] || r)}</span>`).join('；')}</p>` : ''}
        ${dehydrationPanel(c)}${replayPanel(c)}
        <details class="more"><summary>详情与步骤说明</summary><p class="case-exp"><span class="lbl">期望</span>${hl(c.expected, ts)}</p><ul class="steps-detail">${p.steps.map(([status, text], i) => `<li><span class="k">${labels[i]}</span><span class="st-${status}">${esc(text)}</span></li>`).join('')}</ul><div class="muted-note" data-assertion-slot="${esc(c.id)}">评分断言与逐条判定：评分 v2 待接入，本页不生成或冻结评分断言。</div></details>
        <details class="more trace" data-trace-case="${esc(c.id)}" ${expanded.has(c.id) ? 'open' : ''}><summary>轨迹与上下文${ref ? `（${ref.stepCount} 次模型调用）` : ''}</summary><div data-trace-host="${esc(c.id)}"></div></details></article>`;
    }
    function renderCards() {
      const ts = words(q), visible = D.cases.filter(c => {
        const p = plan(c); return matches([c.actual, c.expected, c.source?.conversationTitle, '#' + c.n].join(' '), ts)
          && (model === 'all' || (model === 'gpt') === isGpt(c))
          && (stage === 'all' || stage === p.actor || (stage === 'scene' && hasScene(c)) || (stage === 'noscene' && !hasScene(c)) || (stage === 'dehydrate' && !hasScene(c) && !sourceOnly(c) && isGpt(c)));
      });
      $('[data-bc-summary]').textContent = `显示 ${visible.length} / ${D.cases.length} 条 · 回填状态来自冻结包，缺失不补造；不会自动调用模型或改分组。`;
      $('[data-bc-body]').innerHTML = mode === 'list' ? `<div class="bc-list">${visible.map(c => card(c, ts)).join('')}</div>` : Object.entries(names).map(([key, title]) => {
        const rows = visible.filter(c => plan(c).actor === key);
        return rows.length || key === 'reference' ? `<section class="group" data-actor="${key}"><div class="group-head"><h3>${title}</h3><span class="gcount">${rows.length} 条</span></div>${rows.length ? `<div class="bc-list">${rows.map(c => card(c, ts)).join('')}</div>` : '<p class="muted-note">尚无确认属于此类的用例。</p>'}</section>` : '';
      }).join('');
      if (!visible.length) $('[data-bc-body]').innerHTML = '<p class="muted-note">没有符合条件的 badcase。</p>';
      for (const c of visible) if (expanded.has(c.id)) { renderTrace(c); void loadTrace(c); }
      root.querySelectorAll('[data-bc-mode]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.bcMode === mode)));
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
        return `<details class="trace-section" data-trace-section="${s.key}" ${ts.length && blocks.length ? 'open' : ''}><summary>${s.label}${ts.length ? ` · ${blocks.length} 处匹配` : ''}</summary>${s.key === 'scene' ? `<p class="hint">${hasScene(c) ? sceneWait + '。下方仅展示已有冻结清单，不宣称历史元数据齐全或能回放。' : '没有现场；旧题的样例仓库不当作原现场。'}</p>` : ''}${blocks.map(b => `<details class="trace-value" ${b.text.length <= 800 || ts.length ? 'open' : ''}><summary>${esc(b.label)} · ${b.text.length.toLocaleString()} 字符${b.text.length > 800 ? '（长内容默认折叠）' : ''}</summary><pre class="tl-req">${hl(b.text, ts)}</pre></details>`).join('') || '<p class="hint">没有匹配内容。</p>'}</details>`;
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
      const el = e.target.closest('[data-bc-mode],[data-trace-retry],[data-dehydration-confirm]'); if (!el || el.disabled) return;
      if (el.dataset.dehydrationConfirm) {
        const c = D.cases.find(c => c.id === el.dataset.dehydrationConfirm), r = c && dehydration(c);
        if (!writable || !r || r.decision || typeof onConfirmDecision !== 'function') return;
        const host = el.closest('[data-dehydration]'), kind = host.querySelector('[data-dehydration-kind]').value;
        const cutStep = kind === 'single' ? Number(host.querySelector('[data-dehydration-cut]').value) : null;
        if (!confirmAction(`确认冻结 #${c.n}：${kindLabel(kind)}${cutStep ? '，切点第 ' + cutStep + ' 步' : '；' + (hasScene(c) ? '仍走 trace 级' : '无现场，只作参考')}？之后不能修改；不会启动模型。`)) return;
        onConfirmDecision({ caseId: c.id, traceHash: r.traceHash, recommendationHash: r.hash, kind, cutStep }); return;
      }
      if (el.dataset.bcMode) { mode = el.dataset.bcMode; renderCards(); }
      if (el.dataset.traceRetry) { const c = D.cases.find(c => c.id === el.dataset.traceRetry); if (c) void loadTrace(c, true); }
    });
    root.addEventListener('input', e => {
      const el = e.target;
      if (el.hasAttribute('data-bc-search')) { q = el.value; renderCards(); }
      if (el.hasAttribute('data-trace-search')) { const c = D.cases.find(c => c.id === el.dataset.traceSearch); if (c) { queries.set(c.id, el.value); renderTraceContent(c, el.closest('[data-trace-host]')); } }
    });
    root.addEventListener('change', e => { const el = e.target; if (el.hasAttribute('data-bc-stage')) { stage = el.value; renderCards(); } if (el.hasAttribute('data-bc-model')) { model = el.value; renderCards(); } });
    return { setWritable(value) { writable = value && typeof onConfirmDecision === 'function'; root.querySelectorAll('[data-dehydration-confirm]').forEach(b => { b.disabled = !writable; }); }, render(data) { D = data; for (const [id, row] of cache) if (!D.cases.some(c => c.id === id && c.traceBundle?.hash === row.hash)) cache.delete(id); funnel(); renderCards(); },
      focus(n) { q = ''; stage = 'all'; model = 'all'; $('[data-bc-search]').value = ''; $('[data-bc-stage]').value = 'all'; $('[data-bc-model]').value = 'all'; renderCards(); root.querySelector('#bc-' + Number(n))?.scrollIntoView({ block: 'center' }); } };
  };
})();
