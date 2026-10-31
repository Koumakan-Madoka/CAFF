// @ts-check
(function registerBadcaseWiki() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseWikiPanel = function (options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirm = options.confirm || (message => window.confirm(message));
    let generation = 0, state = null, versionId = '', pending = false, writable = false;
    root.innerHTML = `<div class="button-row"><button type="button" data-wiki-refresh>刷新</button></div>
      <p data-wiki-status role="status" aria-live="polite"></p>
      <section id="wikiskill-cases" class="stack-card"><h2>用例</h2><p data-wiki-case-count></p>
        <p class="muted">用例为全局对象，来源仅作记录；纯文本缺现场，不能用于回放评测。</p>
        <p data-wiki-split-info></p><div data-wiki-cases></div></section>
      <section id="wikiskill-wiki" class="stack-card"><h2>Wiki 审核</h2>
        <p class="muted">生成一律为草稿。通过条目不会修改生产提示词或启动评测；审核后冻结，重新归纳另存版本。</p>
        <label>版本 <select data-wiki-versions></select></label>
        <div data-wiki-coverage></div><div data-wiki-entries></div></section>
      <section id="wikiskill-candidates" class="stack-card"><h2>候选</h2>
        <p>仅用已通过条目生成一版草稿，每次只替换一个声明目标。生成与确认均不修改生产提示词，也不启动评测。</p>
        <label>目标 <select data-wiki-targets></select></label><p data-wiki-target-info></p>
        <details><summary>目标原文</summary><pre data-wiki-target-base></pre></details>
        <p>选择当前 Wiki 版本中已通过的条目：</p><div data-wiki-candidate-entries></div>
        <div class="button-row"><button type="button" data-wiki-generate>生成候选草稿</button></div>
        <div data-wiki-candidates></div></section>
      <section id="wikiskill-results" class="stack-card"><h2>对照结果</h2>
        <p>尚未运行本轮全局提示词对照；历史筛选结果不冒充正式评测结果。</p></section>`;
    const el = name => root.querySelector(`[data-wiki-${name}]`);
    const notice = message => { el('status').textContent = message; };
    const node = (tag, text) => { const result = document.createElement(tag); result.textContent = text; return result; };
    function controls() {
      el('refresh').disabled = pending;
      el('versions').disabled = pending || !state?.versions.length;
      for (const input of el('entries').querySelectorAll('textarea,button')) input.disabled = pending || !writable || input.dataset.reviewed === 'true';
      el('targets').disabled = pending || !writable || !state?.targets?.length;
      for (const input of el('candidate-entries').querySelectorAll('input')) input.disabled = pending || !writable;
      el('generate').disabled = pending || !writable || !el('targets').value || !el('candidate-entries').querySelector('input:checked');
      for (const button of el('candidates').querySelectorAll('button')) button.disabled = pending || !writable || button.dataset.reviewed === 'true';
      root.setAttribute('aria-busy', String(pending));
    }
    function accept(data) {
      if (!data || data.scope !== 'global' || data.projectId !== undefined || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision)
        || !Array.isArray(data.cases) || !Array.isArray(data.versions)) throw Error('invalid_wiki_response');
      state = data; writable = true;
      if (!state.versions.some(v => v.id === versionId)) versionId = state.versions.at(-1)?.id || '';
      render();
    }
    function render() {
      el('versions').replaceChildren(); el('coverage').replaceChildren(); el('entries').replaceChildren(); el('cases').replaceChildren();
      el('case-count').textContent = state ? `全局共 ${state.cases.length} 条来源用例，${(state.replayCases || []).length} 条同类任务封存` : '尚未读取';
      const split = state?.replaySplit;
      el('split-info').textContent = split ? `已固定重放任务来源划分：训练 ${split.trainCaseIds.length} 条，留出 ${split.testCaseIds.length} 条${split.insufficientSamples ? '（不足6条，无独立留出集）' : ''}。留出来源不进入 wiki 生成；这不代表已产生可回放封存。` : '尚未固定重放任务来源划分。';
      renderCandidates();
      if (!state) return;
      // List ALL cases independently of the selected wiki version, including
      // holdout and unclassified sources. All external prose is textContent.
      for (const c of state.cases) {
        const details = document.createElement('details'), source = c.source || {};
        details.append(node('summary', `${c.id} · ${c.replayable === true ? '可回放' : '纯文本 · 缺现场'} · ${c.split === 'test' ? '留出' : '训练'}`));
        details.append(node('p', `来源项目：${source.projectId || '未绑定'}；房间：${source.conversationId || '未记录'}；消息：${source.messageId || '未记录'}`));
        for (const replay of (state.replayCases || []).filter(r => r.sourceCaseId === c.id)) {
          const category = { reproduction: '汇报复现题', probe: '接口膨胀探针', control: '控制题' }[replay.category] || replay.category;
          details.append(node('p', `同类任务 · 可回放封存 · ${category} · ${replay.split === 'test' ? '留出' : '训练'}；不是原历史现场。`));
          details.append(node('p', `任务：${replay.task}`));
          details.append(node('p', `固定提交：${replay.fixture.commit}；检查点：${replay.request.association.checkpointId}`));
        }
        const content = node('pre', `实际问题：${c.actual}\n期望行为：${c.expected}\n消息${c.messageTruncated ? '（截断）' : ''}：\n${c.message}\n轨迹${c.traceTruncated ? '（截断）' : ''}（${c.traceState}）：\n${c.traceExcerpt}`);
        content.style.whiteSpace = 'pre-wrap'; content.style.overflowWrap = 'anywhere'; details.append(content); el('cases').append(details);
      }
      for (const v of state.versions) {
        const option = node('option', `${v.id} · ${v.createdAt}`); option.value = v.id; option.selected = v.id === versionId; el('versions').append(option);
      }
      const v = state.versions.find(item => item.id === versionId);
      if (!v) { el('coverage').textContent = '尚无 wiki 版本。'; return; }
      const assigned = new Set(v.entries.flatMap(e => e.caseIds));
      el('coverage').append(node('p', `训练用例 ${v.caseIds.length} 条；已归类 ${assigned.size} 条；未归类 ${v.unclassified.length} 条。`));
      for (const u of v.unclassified) el('coverage').append(node('p', `${u.caseId}：未归类 — ${u.reason}`));
      for (const e of v.entries) {
        const card = document.createElement('section'); card.className = 'stack-card settings-form';
        card.append(node('h3', `${e.title} · ${e.status === 'approved' ? '已通过' : e.status === 'rejected' ? '已驳回' : '草稿'}`));
        const inputs = {};
        for (const [field, label] of Object.entries({ title: '标题', failureMode: '失败模式', symptoms: '症状', rootCauseHypothesis: '根因假设', guideline: 'Prompt 准则（≤300字）' })) {
          const wrap = node('label', label), input = document.createElement('textarea'); input.rows = field === 'title' ? 1 : 3;
          input.value = e[field]; input.name = field; input.dataset.reviewed = String(e.status !== 'draft'); inputs[field] = input;
          wrap.append(input); card.append(wrap);
        }
        card.append(node('p', '关联用例：' + e.caseIds.join('、')));
        const buttons = document.createElement('div'); buttons.className = 'button-row';
        for (const [action, label] of [['save', '保存草稿'], ['approved', '通过'], ['rejected', '驳回']]) {
          const button = node('button', label); button.type = 'button'; button.dataset.action = action; button.dataset.entry = e.id;
          button.dataset.reviewed = String(e.status !== 'draft');
          button.addEventListener('click', () => { void review(e, inputs, action); }); buttons.append(button);
        }
        card.append(buttons); el('entries').append(card);
      }
    }
    function showTarget() {
      const target = state?.targets?.find(t => t.id === el('targets').value);
      el('target-info').textContent = !target ? '暂无声明目标。' : target.kind === 'tool-description'
        ? '工具描述：只生成候选和 diff；本期不要求评测结论。' : '全局系统提示词片段：所有 agent 共用；其余提示词、角色、工具、技能保持不变。';
      el('target-base').textContent = target?.baseText || '';
    }
    function renderCandidates() {
      const selected = el('targets').value;
      el('targets').replaceChildren(); el('candidate-entries').replaceChildren(); el('candidates').replaceChildren();
      for (const target of state?.targets || []) {
        const option = node('option', target.title); option.value = target.id; option.selected = target.id === selected; el('targets').append(option);
      }
      showTarget();
      const approved = state?.versions.find(v => v.id === versionId)?.entries.filter(e => e.status === 'approved') || [];
      if (!approved.length) el('candidate-entries').append(node('p', '当前版本没有已通过条目；请先审核 Wiki。'));
      for (const entry of approved) {
        const label = node('label', ''), box = document.createElement('input'); box.type = 'checkbox'; box.value = entry.id;
        box.addEventListener('change', controls); label.append(box, node('span', entry.title + '：' + entry.guideline)); el('candidate-entries').append(label);
      }
      const candidates = (state?.candidates || []).filter(c => c.kind === 'global-wiki-candidate-v1');
      if (!candidates.length) el('candidates').append(node('p', '尚无全局目标候选；旧角色候选不用于本轮调优。'));
      for (const candidate of candidates) {
        const card = document.createElement('section'); card.className = 'stack-card';
        card.append(node('h3', `${candidate.target.title} · ${candidate.status === 'confirmed' ? '已确认' : '草稿'}`));
        card.append(node('p', `来源版本：${candidate.versionId}；条目：${candidate.entryIds.join('、')}；候选：${candidate.id}`));
        card.append(node('p', `内容 hash：${candidate.candidateHash}`));
        const details = document.createElement('details'); details.append(node('summary', '候选全文'), node('pre', candidate.candidateText)); card.append(details);
        card.append(node('h4', 'Diff'), node('pre', candidate.diff));
        const button = node('button', candidate.status === 'confirmed' ? '已确认（未启动评测）' : '确认此候选'); button.type = 'button';
        button.dataset.reviewed = String(candidate.status === 'confirmed'); button.addEventListener('click', () => { void confirmCandidate(candidate); });
        card.append(button); el('candidates').append(card);
      }
    }
    async function generateCandidate() {
      if (pending || !writable) return;
      const entryIds = [...el('candidate-entries').querySelectorAll('input:checked')].map(input => input.value);
      const targetId = el('targets').value, selected = versionId, revision = state.revision, seq = generation;
      if (!entryIds.length || !targetId || !confirm('用所选已通过条目为此目标生成候选草稿？不会修改生产提示词或启动评测。')) return;
      if (seq !== generation || selected !== versionId) return;
      pending = true; notice('生成候选草稿…'); controls();
      try {
        const data = await fetchJson('/api/wikiskill/candidate', { method: 'POST', body: { confirmed: true, expectedRevision: revision, versionId: selected, entryIds, targetId } });
        if (seq !== generation) return;
        accept(data); notice('候选草稿已保存；请查看全文和 diff 后确认，未修改生产提示词或启动评测。');
      } catch { if (seq === generation) { writable = false; notice('生成被拒绝、失败或结果未知；未自动重试，请刷新核对。若仍被拒绝，请检查批准状态、目标版本或字面泄漏。'); } }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function confirmCandidate(candidate) {
      if (pending || !writable || candidate.status !== 'draft') return;
      const seq = generation, revision = state.revision;
      if (!confirm(`确认已查看 ${candidate.target.title} 的候选全文和 diff？\n内容 hash：${candidate.candidateHash}\n仅确认候选，不修改生产提示词或启动评测。`)) return;
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
      render(); notice('读取全局用例与 wiki…'); controls();
      try {
        const data = await fetchJson('/api/wikiskill');
        if (seq !== generation) return;
        accept(data); notice('只读加载完成；未调用模型。');
      } catch { if (seq === generation) notice('读取失败；未修改 wiki。'); }
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
