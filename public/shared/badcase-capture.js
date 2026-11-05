// @ts-check
(function registerBadcaseCapture() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseCapturePanel = function createBadcaseCapturePanel(options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirm = options.confirm || (text => window.confirm(text));
    let project = null, current = null, csrf = '', generation = 0, pending = false;
    const storageAdvice = '请将 CAFF_BADCASE_CAPTURE_DIR 设为项目目录外的绝对路径，并重启本实例。已有现场不会自动搬迁，请保留旧采集库。';
    root.innerHTML = `
      <h3>保存问题现场</h3>
      <p class="muted">开启后，每轮执行前保存 Git HEAD、相对 HEAD 的改动补丁、未跟踪文件及实际加载的项目 skill，并保存本轮回放输入（含 session 历史和本项目公共文本上下文）。只替换本机已知 key 的原值，不保证发现其他秘密。</p>
      <p data-capture-directory class="muted"></p>
      <div class="button-row"><button type="button" role="switch" aria-checked="false" data-capture-action="toggle">开启采集</button>
      <button type="button" class="ghost-button" data-capture-action="refresh">刷新状态</button></div>
      <p data-capture-status role="status" aria-live="polite">未选择项目</p>
      <p data-capture-coverage></p>
      <p data-capture-storage class="capture-warning" role="note" hidden></p>
      <p data-capture-usage></p><p data-capture-last></p>
      <p data-capture-notice role="status" aria-live="polite"></p>
      <p class="muted">范围为项目根目录及同仓库 worktree；数量按 Git 登记统计，各目录能否读取 HEAD 以实际采集结果为准。忽略文件不采，异常条目跳过并记原因。不支持非 Git 目录、嵌套仓库或 submodule；不保证原子一致性或暂存区区分。已保存不代表可回放。默认暂存 7 天 / 10 GiB，封存后不自动删除。</p>`;
    const element = selector => root.querySelector(selector);
    const toggle = element('[data-capture-action="toggle"]');
    const enabled = () => current?.policy?.status === 'enabled';
    const notice = text => { element('[data-capture-notice]').textContent = text; };
    function controls() {
      toggle.disabled = pending || !current || !csrf || (!enabled() && current.storage?.overlapsProject === true);
      toggle.textContent = enabled() ? '关闭采集' : '开启采集';
      toggle.setAttribute('aria-checked', String(enabled()));
      element('[data-capture-action="refresh"]').disabled = !project || pending;
      root.setAttribute('aria-busy', String(pending));
    }
    const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
    function show(result) {
      if (!result?.policy || !['enabled', 'disabled', 'suspended'].includes(result.policy.status)
        || (!result.usage && result.usageError !== 'capture_usage_unavailable')) throw new Error('采集状态无效');
      current = result;
      const directory = result.projectPath || project?.path || '';
      element('[data-capture-directory]').textContent = `项目目录：${directory || '未知'}`;
      const state = enabled() ? '已开启' : result.policy.status === 'suspended' ? '已暂停' : '已关闭';
      element('[data-capture-status]').textContent = `项目：${project.name || project.id} · ${state}${result.policy.suspendReason ? ` · ${result.policy.suspendReason}` : ''}`;
      const count = result.coverage?.roomWorktreeCount;
      element('[data-capture-coverage]').textContent = nonnegative(count)
        ? `${enabled() ? '已覆盖' : '开启后覆盖'}的房间 worktree：${count} 个（不含项目根目录）。` : '房间 worktree 覆盖数量未知，请刷新核对。';
      const storage = element('[data-capture-storage]');
      storage.hidden = result.storage?.overlapsProject !== true;
      storage.textContent = storage.hidden ? '' : `${result.storage.insideProject ? '采集库位于项目目录内' : '采集库与项目目录重叠'}，不能开启采集。${storageAdvice}`;
      element('[data-capture-usage]').textContent = result.usage
        ? `已保存现场占用：${result.usage.totalBytes} B` : '现场占用未知，请检查存储后刷新。';
      const data = result.lastCapture;
      const labels = { captured: '已保存', partial: '部分保存', pending_skills: '等待 skill 归档', failed: '采集失败' };
      if (!data) {
        element('[data-capture-last]').textContent = result.lastCaptureError ? '最近采集结果暂不可用，请刷新核对。' : '尚无采集记录。';
      } else {
        const timestamp = Number.isFinite(Date.parse(data.createdAt)) ? new Date(data.createdAt).toLocaleString() : '时间未知';
        element('[data-capture-last]').textContent = `最近采集：${labels[data.status] || '已保存（旧记录）'} · ${timestamp}`
          + `\n跳过：${nonnegative(data.skippedCount) ? data.skippedCount : '未知'} 项`
          + (nonnegative(data.totalNewBytes) ? ` · 新增 ${data.totalNewBytes} B` : '')
          + (typeof data.preparationDurationMs === 'number' && Number.isFinite(data.preparationDurationMs) && data.preparationDurationMs >= 0 ? ` · ${Math.round(data.preparationDurationMs)} ms` : '')
          + (data.targetDir ? `\n目录：${data.targetDir}` : '') + (data.reason ? `\n原因：${data.reason}` : '');
      }
    }
    function errorText(error) {
      const codes = error?.issues?.map(issue => issue.code).filter(Boolean).join(', ');
      const remedy = codes?.includes('badcase_capture_storage_overlaps_project') ? storageAdvice : '请刷新核对状态；不会自动重试。';
      return `操作未完成：${codes || error?.message || '未知错误'}。${remedy}`;
    }
    async function select(selected) {
      const seq = ++generation;
      project = selected; current = null; csrf = ''; pending = Boolean(selected);
      for (const name of ['directory', 'coverage', 'storage', 'usage', 'last', 'notice']) element(`[data-capture-${name}]`).textContent = '';
      element('[data-capture-storage]').hidden = true;
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
      const turnOn = !enabled(), targetDir = current.projectPath || project.path || '';
      if (!confirm(turnOn
        ? `开启项目 ${project.name || project.id} 的执行前采集？\n目录：${targetDir}\n覆盖项目根及同仓库房间 worktree（含以后新建的），保存 HEAD、补丁、未跟踪文件、实际项目 skill、本实例 session 历史及本项目公共文本上下文。仅替换本机已知 key，其他秘密请勿放入采集范围。异常条目会跳过并记录。`
        : '关闭采集？已保存和已封存的现场不会删除。')) return;
      const seq = ++generation, id = project.id;
      pending = true; notice('处理中…'); controls();
      try {
        const result = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-capture/configure`, {
          method: 'POST', body: { enabled: turnOn, confirmed: true }, headers: { 'X-CAFF-CSRF-Token': csrf },
        });
        if (seq !== generation) return;
        show(result); notice(turnOn ? '已开启。之后执行的轮次才会保存现场。' : '已关闭；已有现场保留。');
      } catch (error) { if (seq === generation) notice(errorText(error)); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    toggle.addEventListener('click', () => { void change(); });
    element('[data-capture-action="refresh"]').addEventListener('click', () => { void select(project); });
    controls();
    return { select };
  };
})();
