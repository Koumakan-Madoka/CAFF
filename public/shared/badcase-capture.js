// @ts-check
(function registerBadcaseCapture() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseCapturePanel = function createBadcaseCapturePanel(options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirm = options.confirm || (text => window.confirm(text));
    let project = null, current = null, csrf = '', generation = 0, pending = false;
    root.innerHTML = `
      <h3>保存问题现场</h3>
      <p class="muted">开启后，在每次 agent 执行前保存工作目录、session 历史和本项目公共文本上下文；凭据和私有目录不保存。默认关闭，暂存7天 / 10 GiB，封存后不自动删除。</p>
      <label>工作目录<input name="worktree" type="text" spellcheck="false" /></label>
      <div class="button-row"><button type="button" role="switch" aria-checked="false" data-capture-action="toggle">开启采集</button>
      <button type="button" class="ghost-button" data-capture-action="refresh">刷新状态</button></div>
      <p data-capture-status role="status" aria-live="polite">未选择项目</p>
      <p data-capture-usage></p><p data-capture-last></p>
      <p data-capture-notice role="status" aria-live="polite"></p>
      <p class="muted">仅支持整个普通 Git 仓库。换根、外置 Git 元数据、嵌套仓库/submodule、权限保真和并发一致性不支持；材料缺失会明确报告，不代表可回放。</p>`;
    const element = selector => root.querySelector(selector);
    const directory = element('[name="worktree"]'), toggle = element('[data-capture-action="toggle"]');
    const enabled = () => current?.policy?.status === 'enabled';
    const notice = text => { element('[data-capture-notice]').textContent = text; };
    function controls() {
      directory.disabled = pending || !current || enabled();
      toggle.disabled = pending || !current || !csrf || (!enabled() && !directory.value.trim());
      toggle.textContent = enabled() ? '关闭采集' : '开启采集';
      toggle.setAttribute('aria-checked', String(enabled()));
      element('[data-capture-action="refresh"]').disabled = !project;
      root.setAttribute('aria-busy', String(pending));
    }
    function show(result) {
      if (!result?.policy || !['enabled', 'disabled', 'suspended'].includes(result.policy.status)
        || (!result.usage && result.usageError !== 'capture_usage_unavailable')) throw new Error('采集状态无效');
      current = result;
      directory.value = result.policy.authorizedDirs?.[0] || project?.worktreePath || project?.path || '';
      element('[data-capture-status]').textContent = `项目：${project.name || project.id} · ${enabled() ? '已开启' : '已关闭'}${result.policy.suspendReason ? ` · ${result.policy.suspendReason}` : ''}`;
      element('[data-capture-usage]').textContent = result.usage
        ? `已保存现场占用：${result.usage.totalBytes} B` : '现场占用未知，请检查存储后刷新。';
      const data = result.lastCapture;
      element('[data-capture-last]').textContent = data && Number.isSafeInteger(data.totalNewBytes)
        ? `最近一次新增：${data.totalNewBytes} B` : '';
    }
    function errorText(error) {
      const codes = error?.issues?.map(issue => issue.code).filter(Boolean).join(', ');
      return `操作未完成：${codes || error?.message || '未知错误'}。当前布局或环境可能不支持，请刷新核对状态；不会自动重试。`;
    }
    async function select(selected) {
      const seq = ++generation;
      project = selected; current = null; csrf = ''; pending = Boolean(selected); directory.value = '';
      for (const name of ['usage', 'last', 'notice']) element(`[data-capture-${name}]`).textContent = '';
      element('[data-capture-status]').textContent = selected ? '读取采集状态…' : '未选择项目'; controls();
      if (!selected) return;
      try {
        const bootstrap = await fetchJson('/api/bootstrap');
        if (seq !== generation) return;
        const admin = bootstrap.localAdmin?.modelProviders;
        if (!admin?.enabled || !admin.csrfToken) throw new Error('本实例未开放本地采集管理');
        csrf = admin.csrfToken;
        const result = await fetchJson(`/api/projects/${encodeURIComponent(selected.id)}/badcase-capture`);
        if (seq === generation) show(result);
      } catch (error) { if (seq === generation) notice(errorText(error)); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function change() {
      if (toggle.disabled) return;
      const turnOn = !enabled(), targetDir = directory.value.trim();
      if (!confirm(turnOn
        ? `开启项目 ${project.name || project.id} 的执行前采集？\n目录：${targetDir}\n包含工作目录内 Git 分类元数据、文件现场、本实例 session 历史及本项目公共文本上下文；不保存凭据或私有目录。不支持外置 Git 和嵌套仓库。将替换原范围并检查后开启。`
        : '关闭采集？已保存和已封存的现场不会删除。')) return;
      const seq = ++generation, id = project.id;
      pending = true; notice('处理中…'); controls();
      try {
        const body = turnOn ? { targetDir, enabled: true, confirmed: true } : { enabled: false, confirmed: true };
        const result = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-capture/configure`, {
          method: 'POST', body, headers: { 'X-CAFF-CSRF-Token': csrf },
        });
        if (seq !== generation) return;
        show(result); notice(turnOn ? '已开启。之后执行的 turn 才会保存现场。' : '已关闭；已有现场保留。');
      } catch (error) { if (seq === generation) notice(errorText(error)); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    toggle.addEventListener('click', () => { void change(); });
    element('[data-capture-action="refresh"]').addEventListener('click', () => { void select(project); });
    directory.addEventListener('input', controls);
    controls();
    return { select };
  };
})();
