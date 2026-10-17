// @ts-check

(function registerBadcaseCapture() {
  const shared = window.CaffShared || (window.CaffShared = {});

  // No authorization on load. This panel manages the selected project, not the
  // active project. Selection/action generations guard every asynchronous write.
  shared.createBadcaseCapturePanel = function createBadcaseCapturePanel(options) {
    const root = options.root;
    const fetchJson = options.fetchJson;
    const confirm = options.confirm || ((text) => window.confirm(text));
    const now = options.now || Date.now;
    let project = null;
    let generation = 0;
    let current = null;
    let receipt = null;
    let pending = '';
    let csrf = '';
    let adminEnabled = false;
    let savedDraft = '';
    let expiryTimer = null;
    const scopeNames = ['authorizedDirs', 'authorizedInputDirs', 'includedIgnoredPatterns', 'excludedPatterns', 'windowsExternalGit'];
    const limitNames = ['stagingRetentionDays', 'stagingQuotaBytes'];
    root.innerHTML = `
      <h3>问题现场采集（预览）</h3>
      <p class="muted">仅信任同一 OS 用户的本地进程；不抵御本机 shell 模拟授权。不会自动授权项目路径。
      Windows 可在授权后预估文件容量，但 Windows/darwin 文件采集仍不可用；授权不代表可回放或可严格评测。请勿授权凭据或未获准的私有目录。</p>
      <p data-capture-status role="status" aria-live="polite">未选择项目</p>
      <div class="settings-form compact-settings-form">
        <label>文件采集根（绝对路径，每行一个）<textarea name="authorizedDirs" rows="3" spellcheck="false"></textarea></label>
        <label>输入/session 授权根（绝对路径，每行一个，可空）<textarea name="authorizedInputDirs" rows="2" spellcheck="false"></textarea></label>
        <label>Windows 外置 Git 显式选择（JSON 数组，可空）<textarea name="windowsExternalGit" rows="3" spellcheck="false" placeholder='[{"worktree":"C:/work","metadataRoot":"C:/main/.git/worktrees/work","commonRoot":"C:/main/.git"}]'></textarea></label>
        <p class="muted">每个 worktree 单独选择两个外置 Git 根；文件根须列在上方文件授权中，两个元数据根须分别列在输入授权中。指针不授予权限，不自动发现根；修改选择将关闭采集。此选择尚不开放 Windows 开启或 Docker 回放。</p>
        <label>明确纳入的 ignored 模式（每行一个，可空）<textarea name="includedIgnoredPatterns" rows="2" spellcheck="false"></textarea></label>
        <label>排除模式（每行一个）<textarea name="excludedPatterns" rows="2" spellcheck="false"></textarea></label>
        <div class="button-row"><button type="button" data-capture-action="authorize">1. 确认授权目录（不启用）</button></div>
        <label>未标记暂存期限（天）<input name="stagingRetentionDays" type="number" min="1" step="1" /></label>
        <label>暂存配额（字节）<input name="stagingQuotaBytes" type="number" min="1" step="1" /></label>
        <div class="button-row"><button type="button" data-capture-action="settings">仅保存期限/配额</button></div>
      </div>
      <p data-capture-usage></p>
      <p class="muted">预估为文件元数据容量上界，可能包含 ignored 文件；重叠根可能重复计数。
      预估未包含 session、图片、镜像和清单成本，不保证实际空间充足。页面总占用为已提交文件逻辑字节，含 CAS/检查点/latest/标记/保留清单；
      不含 policy、staging、未发布临时文件或镜像，不是物理磁盘占用或可用空间。CAS 中的 session 未单独拆分；新增占用尚未提供。</p>
      <pre data-capture-estimate class="muted" style="white-space:pre-wrap;overflow-wrap:anywhere" aria-live="polite"></pre>
      <div class="button-row">
        <button type="button" data-capture-action="estimate">2. 预估已授权目录</button>
        <button type="button" data-capture-action="enable">3. 确认开启采集</button>
        <button type="button" data-capture-action="disable" class="ghost-button danger">关闭采集</button>
        <button type="button" data-capture-action="refresh" class="ghost-button">重新读取（丢弃未保存编辑）</button>
      </div>
      <p data-capture-notice role="status" aria-live="polite"></p>
      <p class="muted">切换项目不会撤销已发出的管理请求；返回后请重新读取状态。关闭会使在途预估失效，但不立即取消扫描。
      重新授权会先关闭采集；即使 pin 失败，旧范围也已被新范围替换，需要重新授权。</p>`;
    const element = selector => root.querySelector(selector);
    const field = name => element(`[name="${name}"]`);
    const button = action => element(`[data-capture-action="${action}"]`);
    const notice = text => { element('[data-capture-notice]').textContent = text; };
    const draft = () => JSON.stringify([...scopeNames, ...limitNames].map(name => field(name).value));
    const lines = name => field(name).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const dirty = () => savedDraft !== draft();
    function clearReceipt() {
      receipt = null;
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    function updateControls() {
      const ready = Boolean(project && current && adminEnabled && csrf);
      for (const name of [...scopeNames, ...limitNames]) field(name).disabled = !ready || Boolean(pending);
      for (const action of ['authorize', 'settings', 'estimate', 'enable']) button(action).disabled = !ready || Boolean(pending);
      button('estimate').disabled ||= dirty() || !current?.policy?.authorizedDirs?.length;
      button('enable').disabled ||= dirty() || !receipt || receipt.expiresAt <= now();
      // Allow closing even while an estimate/enable request is in flight.
      button('disable').disabled = !ready || pending === 'disable';
      button('refresh').disabled = !project;
      root.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
    function showState(result) {
      const usageUnavailable = result?.usage === null && result?.usageError === 'capture_usage_unavailable';
      if (!result?.policy || (!result?.usage && !usageUnavailable)) throw new Error('badcase_capture_state_invalid');
      current = result;
      const policy = result.policy;
      for (const name of scopeNames) field(name).value = name === 'windowsExternalGit'
        ? JSON.stringify(policy[name] || [], null, 2) : (policy[name] || []).join('\n');
      for (const name of limitNames) field(name).value = String(policy[name]);
      savedDraft = draft();
      const status = { disabled: '已关闭', enabled: '已开启', suspended: '已暂停' }[policy.status] || String(policy.status);
      element('[data-capture-status]').textContent = `项目：${project.name || project.id} · 状态：${status}${policy.suspendReason ? ` · ${policy.suspendReason}` : ''}`;
      if (usageUnavailable) {
        element('[data-capture-usage]').textContent = '已提交占用未知：capture_usage_unavailable。策略状态仍可管理；容量读取失败不表示零占用或采集可用，请检查存储后重新读取。';
        return;
      }
      const parts = result.usage.bytesByKind;
      const labels = { blobs: 'CAS', checkpoints: '检查点', latest: 'latest', flags: '标记', retention: '保留清单', cases: '封存记录', runReferences: '运行引用' };
      const breakdown = parts && Object.keys(labels).every(key => Number.isSafeInteger(parts[key]) && parts[key] >= 0)
        ? Object.entries(labels).map(([key, label]) => `${label}：${parts[key]} B`).join(' · ') : '分项未知';
      element('[data-capture-usage]').textContent = `已提交总占用：${result.usage.totalBytes} B · ${result.usage.blobCount} 个 blob · ${breakdown}`;
    }
    function showError(error) {
      const codes = Array.isArray(error?.issues) ? error.issues.map(issue => issue.code).filter(Boolean).join(', ') : '';
      if (Array.isArray(error?.issues) && error.issues.some(issue => issue.code === 'capture_writer_busy')) {
        notice('存储正忙（capture_writer_busy），请稍后重新读取状态并重试；开启前需重新预估。');
        return;
      }
      // textContent, never HTML. Unknown reasons are retained, not translated
      // into misleading "directory missing" or a success indication.
      notice(`操作失败：${codes || error?.message || 'unknown_error'}。状态可能已改变，请重新读取；开启前需重新预估。`);
    }
    async function select(selected) {
      const seq = ++generation;
      project = selected;
      current = null; csrf = ''; adminEnabled = false; pending = selected ? 'load' : '';
      clearReceipt();
      for (const name of [...scopeNames, ...limitNames]) field(name).value = '';
      savedDraft = draft();
      element('[data-capture-status]').textContent = selected ? '读取项目采集状态…' : '未选择项目';
      element('[data-capture-usage]').textContent = '';
      element('[data-capture-estimate]').textContent = '';
      notice(''); updateControls();
      if (!selected) return;
      try {
        const bootstrap = await fetchJson('/api/bootstrap');
        if (seq !== generation) return;
        const admin = bootstrap.localAdmin?.modelProviders;
        adminEnabled = admin?.enabled === true;
        csrf = String(admin?.csrfToken || '');
        if (!adminEnabled || !csrf) throw new Error('当前部署未开放本地采集管理');
        const result = await fetchJson(`/api/projects/${encodeURIComponent(selected.id)}/badcase-capture`);
        if (seq !== generation) return;
        showState(result);
      } catch (error) {
        if (seq === generation) {
          element('[data-capture-status]').textContent = '无法读取项目采集状态';
          showError(error);
        }
      } finally {
        if (seq === generation) { pending = ''; updateControls(); }
      }
    }
    async function act(action) {
      if (button(action).disabled) return;
      if (action === 'refresh') { await select(project); return; }
      const id = project.id;
      /** @type {Record<string, any>} */
      let body = {};
      if (action === 'authorize') {
        body = Object.fromEntries(scopeNames.filter(name => name !== 'windowsExternalGit').map(name => [name, lines(name)]));
        try {
          body.windowsExternalGit = JSON.parse(field('windowsExternalGit').value.trim() || '[]');
          if (!Array.isArray(body.windowsExternalGit)) throw new Error('invalid');
        } catch { notice('外置 Git 选择必须为 JSON 数组；未发送授权请求。'); return; }
        if (!body.authorizedDirs.length) { notice('请显式填写至少一个文件采集绝对路径。'); return; }
        const description = scopeNames.map(name => `${name}:\n${name === 'windowsExternalGit'
          ? JSON.stringify(body[name], null, 2) : body[name].join('\n') || '（空）'}`).join('\n\n');
        if (!confirm(`授权项目 ${project.name || id} 的以下范围？\n${description}\n\n将先关闭采集并替换原授权；失败也不自动恢复旧范围。本步骤不启用采集。请勿纳入凭据或未获准的私有目录。`)) return;
        body.confirmed = true;
      } else if (action === 'enable') {
        if (!receipt || receipt.expiresAt <= now()) {
          clearReceipt(); notice('预估回执已过期，请重新预估。'); updateControls(); return;
        }
        if (!confirm(`开启项目 ${project.name || id} 的执行前采集？\n${current.policy.authorizedDirs.join('\n')}\n文件预估：${receipt.totalBytes} B（不含 session/图片/镜像/清单；非空间保证）。\n将于每次 agent turn 开始前采集；不代表完整回放或严格评测可用。`)) return;
        body = { confirmed: true, estimateId: receipt.estimateId };
      } else if (action === 'settings') {
        body = Object.fromEntries(limitNames.map(name => [name, Number(field(name).value)]));
        if (Object.values(body).some(value => !Number.isSafeInteger(value) || value <= 0)) {
          notice('期限和配额必须为正的安全整数。'); return;
        }
      }
      const seq = ++generation;
      clearReceipt(); pending = action;
      notice('处理中…'); element('[data-capture-estimate]').textContent = ''; updateControls();
      try {
        const result = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-capture/${action}`, {
          method: 'POST', body, headers: { 'X-CAFF-CSRF-Token': csrf },
        });
        if (seq !== generation) return;
        if (action === 'estimate') {
          const valid = result.captureAvailable !== false && result.complete === true && typeof result.estimateId === 'string' && result.estimateId.length > 0
            && Number.isFinite(result.expiresAt) && result.expiresAt > now()
            && Number.isFinite(result.totalBytes) && result.totalBytes >= 0
            && Array.isArray(result.estimates) && result.estimates.length > 0
            && result.estimates.every(item => item.ok === true && item.complete === true && item.captureAvailable !== false);
          const previewOnly = result.complete === true && result.captureAvailable === false;
          element('[data-capture-estimate]').textContent = [
            `文件预估合计：${result.totalBytes ?? '未知'} B · ${previewOnly ? '元数据预估完成；采集尚不可用' : valid ? '完整预估（非完整回放）' : '预估失败或不完整'}`,
            ...(Array.isArray(result.estimates) ? result.estimates.map(item =>
              `${item.targetDir}: ${item.totalBytes ?? '未知'} B / ${item.fileCount ?? '未知'} 文件 · ${item.reason || (item.ok && item.complete ? '预估完成' : '不完整')}`) : []),
          ].join('\n');
          if (valid) {
            receipt = result;
            expiryTimer = window.setTimeout(() => {
              if (seq !== generation) return;
              clearReceipt(); notice('预估回执已过期，请重新预估。'); updateControls();
            }, Math.min(2147483647, result.expiresAt - now()));
          }
          notice(previewOnly ? '容量预估可用，但 Windows 文件采集尚未接通；不能开启。预估包括 ignored 文件，不含 session、镜像和清单成本；已知凭据/私有名称强制排除，未扫描内容。'
            : valid ? '预估成功；仍未自动开启。请另行确认开启。' : '无可用开启回执；请检查原因后重新预估。');
        } else {
          showState(result);
          notice(action === 'authorize' ? '已授权但未开启，请先预估。' : action === 'disable' ? '已关闭；不删除已有现场。' : action === 'enable' ? '已开启；采集能力和材料完整性仍需逐次检查。' : '已保存期限/配额，授权范围未变；未保存的范围草稿已丢弃，显示当前持久化范围。');
        }
      } catch (error) {
        if (seq === generation) { clearReceipt(); showError(error); }
      } finally {
        if (seq === generation) { pending = ''; updateControls(); }
      }
    }
    for (const action of ['authorize', 'settings', 'estimate', 'enable', 'disable', 'refresh']) {
      button(action).addEventListener('click', () => { void act(action); });
    }
    root.addEventListener('input', () => {
      clearReceipt(); notice('有未保存编辑。范围需重新授权；期限/配额单独保存。开启前需重新预估。'); updateControls();
    });
    updateControls();
    return { select };
  };
})();
