// @ts-check
(function registerBadcaseWiki() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseWikiPanel = function (options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirm = options.confirm || (message => window.confirm(message));
    let generation = 0, state = null, versionId = '', pending = false, writable = false;
    root.innerHTML = `<section class="wiki-progress" aria-labelledby="wiki-progress-title">
        <div><p class="wiki-eyebrow" id="wiki-progress-title">当前进度</p><p class="wiki-progress-text" data-wiki-progress-text>正在读取进度…</p></div>
        <button class="ghost-button wiki-refresh" type="button" data-wiki-refresh>刷新数据</button>
      </section>
      <nav class="wiki-steps" aria-label="WikiSkill 四个步骤">
        <a href="#wikiskill-cases"><span class="wiki-step-number">1</span><span><strong>用例</strong><small data-wiki-step-cases-meta>了解问题来源</small></span></a>
        <a href="#wikiskill-wiki"><span class="wiki-step-number">2</span><span><strong>Wiki 准则</strong><small data-wiki-step-wiki-meta>审核归纳结果</small></span></a>
        <a href="#wikiskill-candidates"><span class="wiki-step-number">3</span><span><strong>候选</strong><small data-wiki-step-candidates-meta>看懂改动再确认</small></span></a>
        <a href="#wikiskill-results"><span class="wiki-step-number">4</span><span><strong>对照结果</strong><small data-wiki-step-results-meta>查看真实通过率</small></span></a>
      </nav>
      <p class="wiki-notice" data-wiki-status role="status" aria-live="polite"></p>
      <section id="wikiskill-cases" class="stack-card wikiskill-section">
        <div class="wiki-section-heading"><div><p class="wiki-eyebrow">第 1 步 · 收集问题</p><h2>用例</h2></div><span class="wiki-count" data-wiki-case-count></span></div>
        <p class="muted">这些是全局问题来源。纯文本用例只帮助归纳准则；另有封存现场的同类任务才能用于回放评测。</p>
        <p class="wiki-split-info" data-wiki-split-info></p><div class="wiki-case-list" data-wiki-cases></div></section>
      <section id="wikiskill-wiki" class="stack-card wikiskill-section">
        <div class="wiki-section-heading"><div><p class="wiki-eyebrow">第 2 步 · 审核准则</p><h2>Wiki 准则</h2></div></div>
        <p class="muted">准则是从训练用例归纳出的通用改进方向。通过或驳回只完成审核，不会修改生产提示词，也不会启动评测。</p>
        <div class="wiki-version-row"><label>查看版本 <select data-wiki-versions></select></label><div data-wiki-coverage></div></div>
        <div class="wiki-entry-list" data-wiki-entries></div></section>
      <section id="wikiskill-candidates" class="stack-card wikiskill-section wikiskill-candidates-section">
        <div class="wiki-section-heading"><div><p class="wiki-eyebrow">第 3 步 · 确认改动</p><h2>候选</h2></div></div>
        <p class="muted">每份候选只改一个目标。先看新增内容及其来源，再决定是否确认；确认不会直接修改生产提示词。</p>
        <div class="wiki-candidate-list" data-wiki-candidates></div>
        <details class="wiki-generator"><summary>需要另一份候选？选择目标与已通过准则</summary>
          <div class="wiki-generator-body"><label>要修改的目标 <select data-wiki-targets></select></label><p class="muted" data-wiki-target-info></p>
          <details><summary>查看目标原文</summary><pre data-wiki-target-base></pre></details>
          <fieldset class="wiki-entry-picker"><legend>选择当前版本中已通过的准则</legend><div data-wiki-candidate-entries></div></fieldset>
          <div class="button-row"><button type="button" data-wiki-generate>生成候选草稿</button></div>
          <p class="muted">生成只保存一份草稿，不调用模型、不启动评测，也不修改生产配置。</p></div></details></section>
      <section id="wikiskill-results" class="stack-card wikiskill-section">
        <div class="wiki-section-heading"><div><p class="wiki-eyebrow">第 4 步 · 查看证据</p><h2>对照结果</h2></div></div>
        <div data-wiki-results></div></section>`;
    const el = name => root.querySelector(`[data-wiki-${name}]`);
    const notice = message => { el('status').textContent = message; };
    const node = (tag, text) => { const result = document.createElement(tag); result.textContent = text; return result; };
    const badge = (text, tone = '') => { const result = node('span', text); result.className = `wiki-badge ${tone}`; return result; };
    const categoryLabels = { reproduction: '汇报复现题', probe: '接口膨胀探针', control: '控制题' };
    const statusLabels = { approved: '已通过', rejected: '已驳回', draft: '草稿', confirmed: '已确认', deprecated: '已废弃' };
    const shortId = value => value ? String(value).slice(0, 8) + '…' : '未记录';
    const caseTitle = item => String(item?.actual || item?.task || '未命名问题').trim().split('\n')[0] || '未命名问题';
    const caseById = id => state?.cases?.find(item => item.id === id);
    const targetLabel = target => {
      if (!target) return '未声明目标';
      if (target.kind === 'global-system-prompt') return '全局系统提示词（所有 agent 共用）';
      const fromTitle = String(target.title || '').split('·').pop().trim().split(/[（(]/)[0].trim();
      return `工具 ${target.toolName || fromTitle || '描述'} 的说明`;
    };
    function controls() {
      el('refresh').disabled = pending;
      el('versions').disabled = pending || !state?.versions.length;
      for (const input of el('entries').querySelectorAll('textarea,button')) input.disabled = pending || !writable || input.dataset.reviewed === 'true';
      el('targets').disabled = pending || !writable || !state?.targets?.length;
      for (const input of el('candidate-entries').querySelectorAll('input')) input.disabled = pending || !writable;
      el('generate').disabled = pending || !writable || !el('targets').value || !el('candidate-entries').querySelector('input:checked');
      for (const button of el('candidates').querySelectorAll('[data-wiki-confirm-candidate]')) button.disabled = pending || !writable || button.dataset.reviewed === 'true';
      root.setAttribute('aria-busy', String(pending));
    }
    function accept(data) {
      if (!data || data.scope !== 'global' || data.projectId !== undefined || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision)
        || !Array.isArray(data.cases) || !Array.isArray(data.versions)) throw Error('invalid_wiki_response');
      state = data; writable = true;
      if (!state.versions.some(v => v.id === versionId)) versionId = state.versions.at(-1)?.id || '';
      render();
    }
    function renderProgress() {
      if (!state) { el('progress-text').textContent = '读取完成后，这里会告诉你下一步该做什么。'; return; }
      const latest = state.versions.at(-1), approved = latest?.entries.filter(entry => entry.status === 'approved').length || 0;
      const globalCandidates = (state.candidates || []).filter(candidate => candidate.kind === 'global-wiki-candidate-v1'
        && candidate.status !== 'deprecated' && candidate.target?.kind === 'global-system-prompt');
      const confirmed = globalCandidates.find(candidate => candidate.status === 'confirmed');
      const results = state.comparisons || [];
      if (results.length) el('progress-text').textContent = `已保存 ${results.length} 份对照结果 → 查看逐题与总体通过率`;
      else if (confirmed) el('progress-text').textContent = '全局提示词候选已确认 → 下一步：用 7 道题，原版本与候选各 3 次运行真实模型对照';
      else if (globalCandidates.some(candidate => candidate.status === 'draft')) el('progress-text').textContent = `${approved} 条准则已通过 → 请确认全局提示词候选 → 然后开始对照评测`;
      else if (approved) el('progress-text').textContent = `${approved} 条准则已通过 → 请生成并确认全局提示词候选 → 然后开始对照评测`;
      else el('progress-text').textContent = '请先审核 Wiki 准则 → 通过后生成候选 → 确认后再开始对照评测';
      el('step-cases-meta').textContent = `${state.cases.length} 条来源 · ${(state.replayCases || []).length} 道封存题`;
      el('step-wiki-meta').textContent = `${approved} 条已通过`;
      el('step-candidates-meta').textContent = globalCandidates.length ? '有候选待查看' : '看懂改动再确认';
      el('step-results-meta').textContent = results.length ? `${results.length} 份已保存结果` : '尚无正式结果';
    }
    function renderCases() {
      el('cases').replaceChildren();
      el('case-count').textContent = state ? `${state.cases.length} 条来源 · ${(state.replayCases || []).length} 道封存题` : '尚未读取';
      const split = state?.replaySplit;
      el('split-info').textContent = split ? `训练 ${split.trainCaseIds.length} 条，留出 ${split.testCaseIds.length} 条${split.insufficientSamples ? '（不足6条，无独立留出集）' : ''}。留出不参与准则归纳；这不代表已产生可回放封存。` : '尚未固定训练与留出划分。';
      if (!state) return;
      for (const c of state.cases) {
        const details = document.createElement('details'), source = c.source || {};
        details.className = 'wiki-case-card';
        const summary = document.createElement('summary');
        const title = node('span', caseTitle(c)); title.className = 'wiki-case-title';
        const meta = node('span', ''); meta.className = 'wiki-case-meta';
        meta.append(badge(c.split === 'test' ? '留出' : '训练', c.split === 'test' ? 'is-holdout' : ''));
        const replays = (state.replayCases || []).filter(replay => replay.sourceCaseId === c.id);
        meta.append(badge(c.replayable === true ? '可回放' : '纯文本来源'));
        if (replays.length) meta.append(badge(`${replays.length} 道可回放题`, 'is-replay'));
        meta.append(node('span', `来源房间：${shortId(source.conversationId)}`));
        summary.append(title, meta); details.append(summary);
        const sourceLine = node('p', `来源房间：${source.conversationId || '未记录'}；来源项目：${source.projectId || '未绑定'}`);
        sourceLine.className = 'wiki-case-source'; details.append(sourceLine);
        for (const replay of replays) {
          const replayCard = node('section', ''); replayCard.className = 'wiki-replay-card';
          replayCard.append(node('h3', `同类封存任务 · ${categoryLabels[replay.category] || replay.category} · ${replay.split === 'test' ? '留出' : '训练'}`));
          replayCard.append(node('p', replay.task));
          replayCard.append(node('p', '这是用于评测的同类任务，不是原历史现场。'));
          const technical = document.createElement('details'); technical.className = 'wiki-technical';
          technical.append(node('summary', '封存技术详情'), node('pre', `固定提交：${replay.fixture.commit}\n检查点：${replay.request.association.checkpointId}`));
          replayCard.append(technical); details.append(replayCard);
        }
        const content = node('pre', `实际问题：${c.actual}\n期望行为：${c.expected}\n消息${c.messageTruncated ? '（截断）' : ''}：\n${c.message}\n轨迹${c.traceTruncated ? '（截断）' : ''}（${c.traceState}）：\n${c.traceExcerpt}`);
        content.className = 'wiki-case-content'; details.append(content);
        const technical = document.createElement('details'); technical.className = 'wiki-technical';
        technical.append(node('summary', '来源技术详情'), node('pre', `用例标识：${c.id}\n消息标识：${source.messageId || '未记录'}\n执行角色：${source.agentId || '未记录'}`));
        details.append(technical); el('cases').append(details);
      }
    }
    function renderWiki() {
      el('versions').replaceChildren(); el('coverage').replaceChildren(); el('entries').replaceChildren();
      if (!state) return;
      state.versions.forEach((v, index) => {
        const option = node('option', `版本 ${index + 1} · ${v.entries.length} 条准则 · ${v.createdAt}`);
        option.value = v.id; option.selected = v.id === versionId; el('versions').append(option);
      });
      const v = state.versions.find(item => item.id === versionId);
      if (!v) { el('coverage').textContent = '尚无 Wiki 版本。'; return; }
      const assigned = new Set(v.entries.flatMap(entry => entry.caseIds));
      el('coverage').append(node('p', `训练用例 ${v.caseIds.length} 条；已归类 ${assigned.size} 条；未归类 ${v.unclassified.length} 条。`));
      for (const u of v.unclassified) el('coverage').append(node('p', `${caseById(u.caseId) ? caseTitle(caseById(u.caseId)) : '来源用例'}：未归类 — ${u.reason}`));
      const technical = document.createElement('details'); technical.className = 'wiki-technical';
      technical.append(node('summary', '版本技术详情'), node('p', `版本标识：${v.id}`)); el('coverage').append(technical);
      for (const e of v.entries) {
        const card = document.createElement('details'); card.className = 'wiki-entry-card settings-form';
        card.dataset.wikiEntryCard = e.id; card.open = e.status === 'draft';
        const summary = document.createElement('summary');
        summary.append(node('span', e.title), badge(statusLabels[e.status] || e.status, e.status === 'approved' ? 'is-approved' : ''), node('span', `${e.caseIds.length} 条关联用例`));
        card.append(summary);
        const inputs = {};
        for (const [field, label] of Object.entries({ title: '标题', failureMode: '失败模式', symptoms: '症状', rootCauseHypothesis: '根因假设', guideline: 'Prompt 准则（≤300字）' })) {
          const wrap = node('label', label), input = document.createElement('textarea'); input.rows = field === 'title' ? 1 : 3;
          input.value = e[field]; input.name = field; input.dataset.reviewed = String(e.status !== 'draft'); input.disabled = e.status !== 'draft';
          inputs[field] = input; wrap.append(input); card.append(wrap);
        }
        const related = node('div', ''); related.className = 'wiki-related-cases';
        related.append(node('p', `关联用例（${e.caseIds.length} 条）：`));
        const list = document.createElement('ul');
        for (const id of e.caseIds) list.append(node('li', caseById(id) ? caseTitle(caseById(id)) : '来源用例（技术详情见用例列表）'));
        related.append(list); card.append(related);
        const buttons = document.createElement('div'); buttons.className = 'button-row';
        for (const [action, label] of [['save', '保存草稿'], ['approved', '通过'], ['rejected', '驳回']]) {
          const button = node('button', label); button.type = 'button'; button.dataset.action = action; button.dataset.entry = e.id;
          button.dataset.reviewed = String(e.status !== 'draft'); button.disabled = e.status !== 'draft';
          button.addEventListener('click', () => { void review(e, inputs, action); }); buttons.append(button);
        }
        card.append(buttons); el('entries').append(card);
      }
    }
    function showTarget() {
      const target = state?.targets?.find(item => item.id === el('targets').value);
      el('target-info').textContent = !target ? '暂无声明目标。' : target.kind === 'tool-description'
        ? `${targetLabel(target)}：只生成候选并展示改动，本期不要求评测结论。` : `${targetLabel(target)}：只替换这一处，其余提示词、角色、工具和技能保持不变。`;
      el('target-base').textContent = target?.baseText || '';
    }
    function showWikiEntry(selectedVersion, entryId) {
      if (!state?.versions.some(item => item.id === selectedVersion)) return;
      versionId = selectedVersion; render(); controls();
      const entry = [...el('entries').querySelectorAll('[data-wiki-entry-card]')].find(item => item.dataset.wikiEntryCard === entryId);
      if (entry) { entry.open = true; entry.scrollIntoView?.({ block: 'center' }); entry.querySelector('summary')?.focus(); }
    }
    function sourceButton(entry, selectedVersion) {
      const button = node('button', `来源：${entry.title} · ${entry.caseIds.length} 条关联用例`);
      button.type = 'button'; button.className = 'wiki-source-link'; button.dataset.wikiSourceEntry = entry.id;
      button.addEventListener('click', () => showWikiEntry(selectedVersion, entry.id)); return button;
    }
    function appendAddition(container, candidate, entries) {
      const base = candidate.target?.baseText || '', full = String(candidate.candidateText || '');
      const addition = base && full.startsWith(base) ? full.slice(base.length) : full;
      let cursor = 0, matched = true;
      const parts = [];
      for (const entry of entries) {
        const index = addition.indexOf(entry.guideline, cursor);
        if (index < 0) { matched = false; break; }
        parts.push({ text: addition.slice(cursor, index), entry }); cursor = index + entry.guideline.length;
      }
      if (!matched) {
        container.append(node('pre', addition));
        if (entries.length) {
          const sources = node('div', ''); sources.className = 'wiki-addition-sources';
          for (const entry of entries) sources.append(sourceButton(entry, candidate.versionId));
          container.append(sources);
        }
        return;
      }
      for (const part of parts) {
        container.append(node('span', part.text));
        const guideline = node('section', ''); guideline.className = 'wiki-added-guideline';
        guideline.append(node('p', part.entry.guideline), sourceButton(part.entry, candidate.versionId)); container.append(guideline);
      }
      container.append(node('span', addition.slice(cursor)));
    }
    function renderCandidates() {
      const selected = el('targets').value;
      el('targets').replaceChildren(); el('candidate-entries').replaceChildren(); el('candidates').replaceChildren();
      for (const target of state?.targets || []) {
        const option = node('option', targetLabel(target)); option.value = target.id; option.selected = target.id === selected; el('targets').append(option);
      }
      showTarget();
      const approved = state?.versions.find(v => v.id === versionId)?.entries.filter(entry => entry.status === 'approved') || [];
      if (!approved.length) el('candidate-entries').append(node('p', '当前版本没有已通过准则；请先完成 Wiki 审核。'));
      for (const entry of approved) {
        const label = node('label', ''), box = document.createElement('input'); box.type = 'checkbox'; box.value = entry.id;
        box.addEventListener('change', controls); label.append(box, node('span', `${entry.title}（${entry.caseIds.length} 条关联用例）\n${entry.guideline}`)); el('candidate-entries').append(label);
      }
      const candidates = (state?.candidates || []).filter(candidate => candidate.kind === 'global-wiki-candidate-v1')
        .slice().sort((a, b) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated'));
      if (!candidates.length) el('candidates').append(node('p', '尚无候选。可在下方选择目标和已通过准则生成草稿。'));
      for (const candidate of candidates) {
        const deprecated = candidate.status === 'deprecated', confirmed = candidate.status === 'confirmed';
        const card = node('article', ''); card.className = `wiki-candidate-card${deprecated ? ' is-deprecated' : ''}`;
        const heading = node('div', ''); heading.className = 'wiki-candidate-heading';
        heading.append(node('h3', targetLabel(candidate.target)), badge(statusLabels[candidate.status] || candidate.status, confirmed ? 'is-approved' : '')); card.append(heading);
        card.append(node('p', candidate.target?.kind === 'global-system-prompt'
          ? '只修改所有 agent 共用的这一段系统提示词；其他角色、工具和配置保持不变。'
          : '只修改这个工具的说明文字；工具参数、执行逻辑和其他提示词保持不变。'));
        if (deprecated) card.append(node('p', '已废弃：所选工具用途与准则无关。原文和记录保留，不能再确认或用于评测。'));
        const entries = candidate.entryIds.map(id => state.versions.find(v => v.id === candidate.versionId)?.entries.find(entry => entry.id === id)).filter(Boolean);
        const compare = node('div', ''); compare.className = 'wiki-candidate-compare';
        const original = node('section', ''); original.className = 'wiki-compare-pane wiki-original-pane';
        original.append(node('h4', '原文'), node('p', '未变内容默认折叠。'));
        const originalDetails = document.createElement('details'); originalDetails.dataset.wikiOriginal = '';
        originalDetails.append(node('summary', `展开原文（${[...(candidate.target?.baseText || '')].length} 字）`), node('pre', candidate.target?.baseText || '')); original.append(originalDetails);
        const proposed = node('section', ''); proposed.className = 'wiki-compare-pane wiki-proposed-pane';
        proposed.append(node('h4', '候选'), node('p', '原文不变，下面高亮部分是新增内容。'));
        const proposedBase = document.createElement('details'); proposedBase.dataset.wikiCandidateBase = '';
        proposedBase.append(node('summary', '展开相同的原文'), node('pre', candidate.target?.baseText || '')); proposed.append(proposedBase);
        proposed.append(node('h5', entries.length ? `新增 ${entries.length} 条准则` : '新增内容'));
        const addition = node('div', ''); addition.className = 'wiki-addition'; appendAddition(addition, candidate, entries); proposed.append(addition);
        compare.append(original, proposed); card.append(compare);
        const technical = document.createElement('details'); technical.className = 'wiki-technical';
        technical.append(node('summary', '技术详情'), node('pre', `候选标识：${candidate.id}\n来源版本：${candidate.versionId}\n条目标识：${candidate.entryIds.join('、')}\n内容 hash：${candidate.candidateHash}`)); card.append(technical);
        const action = node('div', ''); action.className = 'wiki-confirm-row';
        const button = node('button', deprecated ? '已废弃，不可确认' : confirmed ? '已确认' : '确认此候选'); button.type = 'button';
        button.dataset.wikiConfirmCandidate = ''; button.dataset.reviewed = String(candidate.status !== 'draft');
        button.addEventListener('click', () => { void confirmCandidate(candidate); }); action.append(button);
        const explanation = candidate.target?.kind === 'global-system-prompt'
          ? confirmed ? '正式对照将使用 7 道题，原版本与候选各 3 次运行真实模型；页面不会自行启动评测。'
            : '确认后才会安排正式对照：7 道题，原版本与候选各 3 次，使用真实模型。此按钮不会直接启动评测，也不会改生产提示词。'
          : '工具描述本期只展示候选，不运行对照；确认不会修改生产工具说明。';
        action.append(node('p', explanation)); card.append(action); el('candidates').append(card);
      }
    }
    function renderResults() {
      const container = el('results'); container.replaceChildren();
      if (!state) { container.append(node('p', '尚未读取对照结果。')); return; }
      const results = state.comparisons || [];
      if (!results.length) { container.append(node('p', '尚未保存本轮全局提示词对照；历史筛选结果不冒充正式评测结果。')); return; }
      container.append(node('p', '这里只展示已保存的真实对照。通过/计划包含错误与未运行；可评分通过率仅以通过+失败为分母，不保证提分。'));
      container.append(node('p', '题组经原基线筛选，存在选择偏差；只复现了汇报难懂一类，接口膨胀探针与控制题不计作更多失败复现。'));
      function appendTotals(parent, label, totals) {
        const group = node('div', ''); group.className = 'wiki-result-totals'; group.append(node('h4', label));
        for (const variant of ['original', 'candidate']) {
          const t = totals[variant], rate = t.passRate === null ? 'N/A' : (100 * t.passRate).toFixed(1) + '%';
          group.append(node('p', `${variant === 'original' ? '原版本' : '候选'}：${t.passed}/${t.planned} 通过，${t.failed} 失败，${t.errors} 错误，${t.notRun} 未运行；可评分通过率 ${rate}（${t.scored} 次）。`));
        }
        parent.append(group);
      }
      results.forEach((result, index) => {
        const card = document.createElement('details'); card.open = results.length === 1; card.className = 'wiki-result-card';
        card.append(node('summary', `${result.createdAt} · 第 ${index + 1} 份对照 · ${result.completed ? '已完整执行' : '执行不完整'}`));
        const target = state.targets?.find(item => item.id === result.candidate.targetId);
        card.append(node('p', `对照目标：${targetLabel(target || { kind: 'global-system-prompt' })}`));
        card.append(node('p', `模型：${result.model}；已记录 ${result.modelCallsKnown} 次模型请求${result.callsUnavailable ? '（调用记录存在未知或不完整，不能视为零调用）' : ''}。未自动重试。`));
        const technical = document.createElement('details'); technical.className = 'wiki-technical';
        technical.append(node('summary', '对照技术详情'), node('pre', `结果标识：${result.id}\n候选标识：${result.candidate.id}\n目标标识：${result.candidate.targetId}\n候选 hash：${result.candidate.candidateHash}\n计划 hash：${result.planHash}`)); card.append(technical);
        appendTotals(card, '总体', result.totals);
        for (const [key, label] of [['train', '训练'], ['test', '留出']]) appendTotals(card, label, result.bySplit[key]);
        for (const key of ['reproduction', 'probe', 'control']) appendTotals(card, categoryLabels[key], result.byCategory[key]);
        for (const c of result.cases) {
          const item = document.createElement('details'), source = caseById(c.sourceCaseId);
          const status = { completed: '已完整执行', error: '错误', unsupported: '不支持', 'not-run': '未执行' }[c.status] || c.status;
          item.append(node('summary', `${source ? caseTitle(source) : '来源用例'} · ${c.split === 'test' ? '留出' : '训练'} · ${categoryLabels[c.category]} · ${status}`));
          if (c.reason) item.append(node('p', `原因：${c.reason}`));
          item.append(node('p', `来源用例标识：${c.sourceCaseId}`));
          appendTotals(item, '逐题', c.totals);
          for (const r of c.runs) item.append(node('p', `${r.variant === 'original' ? '原版本' : '候选'} 第${r.iteration}次：${r.status}${r.reason ? ' · ' + r.reason : ''}`));
          card.append(item);
        }
        const disclosure = { fewer_than_6_prepared_replays: '预检支持的封存不足6条', fewer_than_10_wiki_training_cases: 'Wiki训练用例不足10条' };
        for (const key of result.disclosures || []) if (disclosure[key]) card.append(node('p', '披露：' + disclosure[key]));
        container.append(card);
      });
    }
    function render() {
      renderCases(); renderWiki(); renderCandidates(); renderResults(); renderProgress();
    }
    async function generateCandidate() {
      if (pending || !writable) return;
      const entryIds = [...el('candidate-entries').querySelectorAll('input:checked')].map(input => input.value);
      const targetId = el('targets').value, selected = versionId, revision = state.revision, seq = generation;
      if (!entryIds.length || !targetId || !confirm('用所选已通过准则为此目标生成候选草稿？不会修改生产提示词或启动评测。')) return;
      if (seq !== generation || selected !== versionId) return;
      pending = true; notice('生成候选草稿…'); controls();
      try {
        const data = await fetchJson('/api/wikiskill/candidate', { method: 'POST', body: { confirmed: true, expectedRevision: revision, versionId: selected, entryIds, targetId } });
        if (seq !== generation) return;
        accept(data); notice('候选草稿已保存；请查看新增内容后确认，未修改生产提示词或启动评测。');
      } catch { if (seq === generation) { writable = false; notice('生成被拒绝、失败或结果未知；未自动重试，请刷新核对。若仍被拒绝，请检查批准状态、目标版本或字面泄漏。'); } }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function confirmCandidate(candidate) {
      if (pending || !writable || candidate.status !== 'draft') return;
      const seq = generation, revision = state.revision;
      const consequence = candidate.target?.kind === 'global-system-prompt'
        ? '确认后才会安排正式对照：7 道题，原版本与候选各 3 次，使用真实模型。此操作本身不启动评测，也不修改生产提示词。'
        : '工具描述本期只展示候选，不运行对照；此操作不会修改生产工具说明。';
      if (!confirm(`确认 ${targetLabel(candidate.target)} 的这份候选？\n${consequence}`)) return;
      if (seq !== generation) return;
      pending = true; notice('确认候选…'); controls();
      try {
        const data = await fetchJson('/api/wikiskill/confirm-global-candidate', { method: 'POST', body: { confirmed: true,
          candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: revision } });
        if (seq !== generation) return;
        accept(data); notice('候选已确认；未修改生产提示词、未启动评测。');
      } catch { if (seq === generation) { writable = false; notice('确认被拒绝、失败或结果未知；未自动重试，请刷新核对。'); } }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function load() {
      const seq = ++generation; state = null; writable = false; pending = true;
      render(); notice('读取全局用例与准则…'); controls();
      try {
        const data = await fetchJson('/api/wikiskill');
        if (seq !== generation) return;
        accept(data); notice('只读加载完成；未调用模型。');
      } catch { if (seq === generation) notice('读取失败；未修改 Wiki。'); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function review(entry, inputs, action) {
      if (pending || !writable || entry.status !== 'draft') return;
      const seq = generation, selected = versionId, revision = state.revision;
      const patch = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      if (!patch.guideline.trim() || [...patch.guideline].length > 300) { notice('准则须为1–300字。'); return; }
      if (action !== 'save' && !confirm(`确认${action === 'approved' ? '通过' : '驳回'} ${patch.title}？审核后冻结，不能覆盖。\n准则：${patch.guideline}`)) return;
      if (seq !== generation || selected !== versionId) return;
      pending = true; notice('保存中…'); controls();
      try {
        const data = await fetchJson('/api/wikiskill/review', { method: 'POST', body: { confirmed: true, versionId: selected,
          entryId: entry.id, expectedRevision: revision, patch, ...(action === 'save' ? {} : { decision: action }) } });
        if (seq !== generation) return;
        accept(data); notice('已保存；未修改 prompt 或启动评测。');
      } catch {
        if (seq === generation) { writable = false; notice('保存失败或结果未知；未自动重试。草稿保留在页面，请刷新核对最新状态。'); }
      } finally { if (seq === generation) { pending = false; controls(); } }
    }
    el('targets').addEventListener('change', () => { showTarget(); controls(); });
    el('generate').addEventListener('click', () => { void generateCandidate(); });
    el('refresh').addEventListener('click', () => { void load(); });
    el('versions').addEventListener('change', () => { versionId = el('versions').value; render(); controls(); });
    render(); controls();
    return { load };
  };
})();
