// @ts-check
(function registerBadcaseWiki() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseWikiPanel = function (options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirm = options.confirm || (message => window.confirm(message));
    let projectId = '', generation = 0, state = null, versionId = '', pending = false, writable = false;
    root.innerHTML = `<h3>WikiSkill 审核 · GPT</h3>
      <p class="muted">模型生成的均为草稿。通过条目不修改生产 prompt，也不启动评测。生成由操作方运行；本页无需填写 JSON。</p>
      <div class="button-row"><label>版本 <select data-wiki-versions></select></label><button type="button" data-wiki-refresh>刷新</button></div>
      <p data-wiki-status role="status" aria-live="polite"></p>
      <div data-wiki-coverage></div><div data-wiki-entries></div><details><summary>关联用例（纯文本不用于评测）</summary><div data-wiki-cases></div></details>`;
    const el = name => root.querySelector(`[data-wiki-${name}]`);
    const notice = message => { el('status').textContent = message; };
    const node = (tag, text) => { const result = document.createElement(tag); result.textContent = text; return result; };
    function controls() {
      el('refresh').disabled = !projectId || pending;
      el('versions').disabled = pending || !state?.versions.length;
      for (const input of el('entries').querySelectorAll('textarea,button')) input.disabled = pending || !writable || input.dataset.reviewed === 'true';
      root.setAttribute('aria-busy', String(pending));
    }
    function accept(data, id) {
      if (!data || data.projectId !== id || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision)
        || !Array.isArray(data.cases) || !Array.isArray(data.versions)) throw Error('invalid_wiki_response');
      state = data; writable = true;
      if (!state.versions.some(v => v.id === versionId)) versionId = state.versions.at(-1)?.id || '';
      render();
    }
    function render() {
      el('versions').replaceChildren(); el('coverage').replaceChildren(); el('entries').replaceChildren(); el('cases').replaceChildren();
      if (!state) return;
      for (const v of state.versions) {
        const option = node('option', `${v.id} · ${v.createdAt}`); option.value = v.id; option.selected = v.id === versionId;
        el('versions').append(option);
      }
      const v = state.versions.find(item => item.id === versionId);
      if (!v) { el('coverage').textContent = `已导入 ${state.cases.length} 条用例，尚无 wiki 版本。`; return; }
      const assigned = new Set(v.entries.flatMap(e => e.caseIds));
      el('coverage').append(node('p', `训练用例 ${v.caseIds.length} 条；已归类 ${assigned.size} 条；未归类 ${v.unclassified.length} 条。`));
      for (const u of v.unclassified) el('coverage').append(node('p', `${u.caseId}：未归类 — ${u.reason}`));
      for (const e of v.entries) {
        const card = document.createElement('section'); card.className = 'stack-card';
        card.append(node('h4', `${e.title} · ${e.status === 'approved' ? '已通过' : e.status === 'rejected' ? '已驳回' : '草稿'}`));
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
      for (const c of state.cases.filter(c => v.caseIds.includes(c.id))) {
        const details = document.createElement('details'); details.append(node('summary', `${c.id} · ${c.kind} · ${c.split}`));
        const content = node('pre', `实际问题：${c.actual}\n期望行为：${c.expected}\n消息${c.messageTruncated ? '（截断）' : ''}：\n${c.message}\n轨迹${c.traceTruncated ? '（截断）' : ''}（${c.traceState}）：\n${c.traceExcerpt}`);
        content.style.whiteSpace = 'pre-wrap'; content.style.overflowWrap = 'anywhere'; details.append(content); el('cases').append(details);
      }
    }
    async function select(project) {
      const seq = ++generation; projectId = project?.id || ''; state = null; versionId = ''; writable = false; pending = Boolean(projectId);
      render(); notice(projectId ? '读取 wiki…' : '未选择项目'); controls();
      if (!projectId) return;
      const id = projectId;
      try {
        const data = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-wiki`);
        if (seq !== generation) return;
        accept(data, id); notice('只读加载完成；未调用模型。');
      } catch { if (seq === generation) notice('读取失败；未修改 wiki。'); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function review(entry, inputs, action) {
      if (pending || !writable || entry.status !== 'draft') return;
      const seq = generation, id = projectId, selected = versionId, revision = state.revision;
      const patch = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      if (!patch.guideline.trim() || [...patch.guideline].length > 300) { notice('准则须为1–300字。'); return; }
      if (action !== 'save' && !confirm(`确认${action === 'approved' ? '通过' : '驳回'} ${patch.title}？审核后冻结，不能覆盖。\n准则：${patch.guideline}`)) return;
      if (seq !== generation || selected !== versionId) return;
      pending = true; notice('保存中…'); controls();
      try {
        const data = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-wiki/review`, { method: 'POST',
          body: { confirmed: true, versionId: selected, entryId: entry.id, expectedRevision: revision, patch, ...(action === 'save' ? {} : { decision: action }) } });
        if (seq !== generation) return;
        accept(data, id); notice('已保存；未修改 prompt 或启动评测。');
      } catch {
        if (seq === generation) { writable = false; notice('保存失败或结果未知；未自动重试。草稿保留在页面，请刷新核对最新状态。'); }
      } finally { if (seq === generation) { pending = false; controls(); } }
    }
    el('refresh').addEventListener('click', () => { void select({ id: projectId }); });
    el('versions').addEventListener('change', () => { versionId = el('versions').value; render(); controls(); });
    render(); controls();
    return { select };
  };
})();
