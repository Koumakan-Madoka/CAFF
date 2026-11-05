// @ts-check
(function registerBadcasePipeline() {
  const shared = window.CaffShared || (window.CaffShared = {});
  // Read-only projection. No JEV, grading, grouping mutations or replay launch.
  shared.createBadcasePipeline = function ({ root, fetchJson }) {
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
    const names = { you: '等你处理', system: '系统可以继续', source: '旧题的来源', reference: '只作参考', other: '非 GPT 来源' };
    const splitName = { train: '训练', gate: '门槛', test: '测试' };
    const sceneWait = '待接入 · 待采集能力合入';
    const reasonLabels = {
      original_context_unavailable: '未保存当时的原始上下文', system_prompt_missing: '未保存当时的系统提示词',
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
    const cache = new Map(), expanded = new Set(), queries = new Map();
    root.innerHTML = `<div class="groups badcase-pipeline"><section class="sec"><h2>从 badcase 到测试用例</h2><p class="hint">有现场默认走 trace 级；无现场须经 JEV 推荐、你确认后脱水成 run 级。测试组只收 trace 级，门槛中 run 级不超过一半，训练组 run 级只作初筛。旧分组保留，重新分组尚待你确认。</p><div data-funnels></div></section>
      <div class="toolbar"><label class="search"><input data-bc-search type="search" aria-label="搜索 badcase" placeholder="搜索问题、期望、来源房间或编号" autocomplete="off"></label>
      <label class="field">卡在 <select data-bc-stage><option value="all">全部</option><option value="you">等你处理</option><option value="system">系统可以继续</option><option value="scene">现场待接入</option><option value="noscene">无现场（待脱水）</option><option value="dehydrate">脱水</option><option value="source">旧题的来源</option><option value="other">非 GPT 来源</option></select></label>
      <label class="field">模型 <select data-bc-model><option value="all">全部</option><option value="gpt">GPT</option><option value="other">非 GPT</option></select></label>
      <div class="seg" role="radiogroup" aria-label="Badcase 显示方式"><button type="button" role="radio" data-bc-mode="group" aria-checked="true">按下一步分组</button><button type="button" role="radio" data-bc-mode="list" aria-checked="false">列表</button></div></div>
      <p class="summary" data-bc-summary></p><div class="groups" data-bc-body></div></div>`;
    const $ = s => root.querySelector(s);
    const isGpt = c => /gpt/i.test(c.source?.agentId || c.role || '');
    const hasScene = c => !!c.sealedCheckpointId;
    // Goal B8's three immutable historical sources, not their synthetic tests.
    const sourceOnly = c => c.kind === 'text-only' && c.split === 'test' && [4, 10, 14].includes(c.n);
    function backfill(c) {
      const r = c.traceBundle;
      if (!r) return '未归档 · 尚无冻结轨迹包';
      if (r.origin === 'backfill') return r.complete ? '回填完成' : r.stepCount ? '回填部分完成 · 存在缺失' : '无法回填当轮输出 · 已记录原因';
      return r.complete ? '标记时已冻结' : '标记时已冻结 · 存在缺失';
    }
    function plan(c) {
      const has = hasScene(c), old = sourceOnly(c), other = !isGpt(c), cs = D.caseStates?.find(s => s.caseId === c.id);
      const steps = [
        ['done', c.kind === 'text-only' ? '用户批准的历史导入' : '页面标记'],
        [has ? 'pending' : 'alt', has ? sceneWait + '；已有封存清单不等于现场元数据齐全' : '没有现场；须先确认能否脱水'],
        [old || has ? 'done' : 'pending', old ? '不脱水、不改组，只作旧题来源' : has ? '默认 trace 级；可另选脱水' : 'JEV 推荐待接入；用户确认后冻结判断与切点'],
        [cs?.memberships?.length ? 'done' : 'pending', cs?.memberships?.length ? '已有已确认模式标签' : '待归类；不自动改模式'],
        [old ? 'done' : 'pending', old ? '原测试分组保留' : '旧分组保留；分层重新分组待用户确认'],
        ['pending', '评分 v2 待接入：断言及逐条判定由独立 Goal 负责'],
        ['pending', '待检查冻结输入；旧回放登记不等于本流程检查通过'],
        ['pending', '待原版复现；旧字面评分不作新版入库证据'],
        ['pending', '前置条件未齐，不宣称已成为合格测试用例'],
      ];
      if (old || other) for (let i = old ? 5 : 2; i < 9; i++) steps[i] = ['skip', old ? '只作旧题来源，不单独入库' : '只报告，不计入 GPT 结论'];
      const actor = other ? 'other' : old ? 'source' : 'system';
      return { steps, actor, next: other ? '非 GPT 来源，只报告' : old ? '保留旧题来源，不脱水、不改组' : has ? sceneWait : '等待脱水推荐接入，再请你确认' };
    }
    function funnel() {
      const gpt = D.cases.filter(isGpt), tr = gpt.filter(hasScene), rn = gpt.filter(c => !hasScene(c) && !sourceOnly(c));
      const lane = (key, title, note, cells) => `<div class="lane" data-lane="${key}"><div class="lane-head"><b>${title}</b><span>${note}</span></div><div class="funnel">${cells.map(([n, l]) => `<div class="f-step ${n ? '' : 'zero'}"><b>${n}</b><span>${l}</span></div>`).join('')}</div></div>`;
      $('[data-funnels]').innerHTML = lane('trace', 'trace 级', '有现场；完整采集能力待合入，不能把封存当作已通过回放检查', [[tr.length, 'GPT 且有封存现场'], [tr.filter(c => c.traceBundle).length, '已冻结轨迹包'], [0, '新版回放检查通过'], [0, '新版断言已冻结'], [0, '本流程合格测试用例']])
        + lane('run', 'run 级（脱水）', '无现场待脱水，不含 #4、#10、#14 的旧题来源；尚未确认的不是 run 级测试用例', [[rn.length, 'GPT 无现场待脱水'], [rn.filter(c => c.traceBundle?.stepCount).length, '已恢复当轮轨迹'], [rn.filter(c => c.traceBundle?.complete).length, '完整轨迹包'], [0, '用户确认可脱水'], [0, '门槛用例 / 初筛用例']]);
    }
    function card(c, ts) {
      const p = plan(c), ref = c.traceBundle, tone = ref?.complete ? 'ok' : 'warn';
      return `<article class="bc" id="bc-${c.n}" data-case-id="${esc(c.id)}"><div class="bc-head"><span class="num">#${c.n}</span><h4>${hl(c.actual, ts)}</h4><div class="bc-meta"><span>${isGpt(c) ? 'GPT' : esc(c.role || c.source?.agentId || '其他模型')}</span><span>来自 ${hl(c.source?.conversationTitle || '未命名房间', ts)}</span><span>${splitName[c.split] || '未定组'}${c.split ? '组（旧记录）' : ''}</span><span class="pill ${hasScene(c) ? 'info' : 'warn'}">${sourceOnly(c) ? '旧题来源' : hasScene(c) ? 'trace 级 · 现场待接入' : 'run 级 · 待脱水确认'}</span></div></div>
        <ol class="stepper" aria-label="从标记到入库的步骤">${p.steps.map(([status, text], i) => `<li class="${status}" title="${esc(labels[i] + '：' + text)}"><span class="bar"></span><span class="lab">${labels[i]}</span><span class="sr-only">${esc(text)}</span></li>`).join('')}</ol>
        <div class="next-line"><span class="who ${p.actor === 'system' ? 'sys' : 'none'}">${p.actor === 'system' ? '系统' : '到此为止'}</span><span>${esc(p.next)}</span></div>
        <div class="chips"><span class="pill ${tone}">${backfill(c)}</span>${hasScene(c) ? `<span class="pill warn">现场：${sceneWait}</span>` : '<span class="pill">无现场</span>'}</div>
        ${ref?.missingReasons?.length ? `<p class="hint">缺失：${ref.missingReasons.map(r => `<span title="${esc(r)}">${esc(reasonLabels[r] || r)}</span>`).join('；')}</p>` : ''}
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
      const el = e.target; if (!el.matches('[data-trace-case]')) return;
      const id = el.dataset.traceCase, c = D.cases.find(c => c.id === id); if (!c) return;
      if (el.open) { expanded.add(id); renderTrace(c); void loadTrace(c); } else expanded.delete(id);
    }, true);
    root.addEventListener('click', e => {
      const el = e.target.closest('[data-bc-mode],[data-trace-retry]'); if (!el) return;
      if (el.dataset.bcMode) { mode = el.dataset.bcMode; renderCards(); }
      if (el.dataset.traceRetry) { const c = D.cases.find(c => c.id === el.dataset.traceRetry); if (c) void loadTrace(c, true); }
    });
    root.addEventListener('input', e => {
      const el = e.target;
      if (el.hasAttribute('data-bc-search')) { q = el.value; renderCards(); }
      if (el.hasAttribute('data-trace-search')) { const c = D.cases.find(c => c.id === el.dataset.traceSearch); if (c) { queries.set(c.id, el.value); renderTraceContent(c, el.closest('[data-trace-host]')); } }
    });
    root.addEventListener('change', e => { const el = e.target; if (el.hasAttribute('data-bc-stage')) { stage = el.value; renderCards(); } if (el.hasAttribute('data-bc-model')) { model = el.value; renderCards(); } });
    return { render(data) { D = data; for (const [id, row] of cache) if (!D.cases.some(c => c.id === id && c.traceBundle?.hash === row.hash)) cache.delete(id); funnel(); renderCards(); },
      focus(n) { q = ''; stage = 'all'; model = 'all'; $('[data-bc-search]').value = ''; $('[data-bc-stage]').value = 'all'; $('[data-bc-model]').value = 'all'; renderCards(); root.querySelector('#bc-' + Number(n))?.scrollIntoView({ block: 'center' }); } };
  };
})();
