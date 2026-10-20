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
    let dependency = null;
    const scopeNames = ['authorizedDirs', 'authorizedInputDirs', 'includedIgnoredPatterns', 'excludedPatterns', 'windowsExternalGit', 'callbackInputAuthorized'];
    const limitNames = ['stagingRetentionDays', 'stagingQuotaBytes'];
    root.innerHTML = `
      <h3>保存问题现场</h3>
      <p class="muted">执行前保存已授权的工作目录，之后可标记问题。打开页面不会自动授权或开启。</p>
      <p data-capture-status role="status" aria-live="polite">未选择项目</p>
      <fieldset class="settings-form compact-settings-form"><legend>1. 选择 worktree 并授权</legend>
        <label>本次实际工作目录<input name="worktree" type="text" spellcheck="false" /></label>
        <p class="muted">请核对实际 worktree，不要选应用安装目录或其他 Room；更改目录需重新授权。</p>
        <button type="button" data-capture-action="authorize-worktree">确认目录授权（不启用）</button>
      </fieldset>
      <fieldset class="settings-form compact-settings-form"><legend>2. 确认依赖与预估容量</legend>
        <p data-capture-dependency aria-live="polite">授权后检查 Git 依赖；外部目录逐根确认后才会读取。</p>
        <p class="muted">自动识别暂不支持含嵌套仓库/submodule 的 worktree；遇到限制会停止引导，不会跳过依赖检查。高级设置不保证该布局可采集。</p>
        <div class="button-row"><button type="button" data-capture-action="discover-git" class="ghost-button">重新检查 Git 依赖</button>
        <button type="button" data-capture-action="authorize-dependency">确认所列 Git 范围（不启用）</button></div>
        <label class="capture-consent"><input name="callbackInputAuthorized" type="checkbox" /> 另行同意保存执行前公共文本上下文，供回放使用</label>
        <details><summary>保存哪些对话内容？</summary><p class="muted">包括本项目各 Room 的标题、公共元数据、参与者和完整公共文本历史，不含私有信箱、附件或委托；存在这些不支持状态或秘密时整份回调输入缺失，不截断为完整材料。默认不同意；修改后需重新确认授权，不授权付费回放。</p></details>
        <button type="button" data-capture-action="estimate">预估已授权目录</button>
        <pre data-capture-estimate class="muted" style="white-space:pre-wrap;overflow-wrap:anywhere" aria-live="polite"></pre>
      </fieldset>
      <fieldset class="settings-form compact-settings-form"><legend>3. 开启采集</legend>
        <p class="muted">Windows 当前仅支持容量预估，采集开启尚不可用。授权和预估不会绕过此限制。</p>
        <div class="button-row"><button type="button" data-capture-action="enable">确认开启采集</button>
        <button type="button" data-capture-action="disable" class="ghost-button danger">关闭采集</button></div>
      </fieldset>
      <p data-capture-usage></p>
      <p data-capture-notice role="status" aria-live="polite"></p>
      <button type="button" data-capture-action="refresh" class="ghost-button">重新读取（丢弃未保存编辑）</button>
      <details data-capture-advanced><summary>高级设置与存储明细</summary>
      <p class="muted">默认暂存7天、配额10 GiB；凭据、私有目录及采集存储始终排除。仅信任同一 OS 用户的本地进程，不抵御本机 shell 模拟授权。授权不代表可回放或可严格评测。</p>
      <div class="settings-form compact-settings-form">
        <label>文件采集根（绝对路径，每行一个）<textarea name="authorizedDirs" rows="3" spellcheck="false"></textarea></label>
        <label>输入/session 授权根（绝对路径，每行一个，可空）<textarea name="authorizedInputDirs" rows="2" spellcheck="false"></textarea></label>
        <label>Windows 外置 Git 显式选择（JSON 数组，可空）<textarea name="windowsExternalGit" rows="3" spellcheck="false" placeholder='[{"worktree":"C:/work","metadataRoot":"C:/main/.git/worktrees/work","commonRoot":"C:/main/.git"}]'></textarea></label>
        <p class="muted">每个 worktree 单独选择两个外置 Git 根；文件根须列在上方文件授权中，两个元数据根须分别列在输入授权中。指针只提出候选，不授予权限；修改选择将关闭采集。此选择尚不开放 Windows 开启或 Docker 回放。</p>
        <label>明确纳入的 ignored 模式（每行一个，可空）<textarea name="includedIgnoredPatterns" rows="2" spellcheck="false"></textarea></label>
        <label>排除模式（每行一个）<textarea name="excludedPatterns" rows="2" spellcheck="false"></textarea></label>
        <div class="button-row"><button type="button" data-capture-action="authorize">1. 确认授权范围（不启用）</button></div>
        <label>未标记暂存期限（天）<input name="stagingRetentionDays" type="number" min="1" step="1" /></label>
        <label>暂存配额（字节）<input name="stagingQuotaBytes" type="number" min="1" step="1" /></label>
        <div class="button-row"><button type="button" data-capture-action="settings">仅保存期限/配额</button></div>
      </div>
      <p data-capture-storage-detail></p>
      <p class="muted">预估为文件元数据容量上界，可能包含 ignored 文件；重叠根可能重复计数。
      预估未包含 session、图片、镜像和清单成本，不保证实际空间充足。页面总占用为已提交文件逻辑字节，含 CAS/检查点/latest/标记/保留清单；
      不含 policy、staging、未发布临时文件或镜像，不是物理磁盘占用或可用空间。CAS 中的 session 未单独拆分；新增占用尚未提供。</p>
      <p class="muted">切换项目不会撤销已发出的管理请求；返回后请重新读取状态。关闭会使在途预估失效，但不立即取消扫描。
      重新授权会先关闭采集；即使 pin 失败，旧范围也已被新范围替换，需要重新授权。</p></details>`;
    const element = selector => root.querySelector(selector);
    const field = name => element(`[name="${name}"]`);
    const button = action => element(`[data-capture-action="${action}"]`);
    const notice = text => { element('[data-capture-notice]').textContent = text; };
    const draft = () => JSON.stringify(['worktree', ...scopeNames, ...limitNames].map(name => name === 'callbackInputAuthorized' ? field(name).checked : field(name).value));
    const lines = name => field(name).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const dirty = () => savedDraft !== draft();
    function clearReceipt() {
      receipt = null;
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    function updateControls() {
      const ready = Boolean(project && current && adminEnabled && csrf);
      for (const name of ['worktree', ...scopeNames, ...limitNames]) field(name).disabled = !ready || Boolean(pending);
      for (const action of ['authorize', 'authorize-worktree', 'authorize-dependency', 'discover-git', 'settings', 'estimate', 'enable']) button(action).disabled = !ready || Boolean(pending);
      button('discover-git').disabled ||= dirty() || !current?.policy?.authorizedDirs?.includes(field('worktree').value);
      button('authorize-dependency').disabled ||= dirty() || !dependency;
      button('authorize-dependency').hidden = !dependency;
      button('discover-git').hidden = !current?.policy?.authorizedDirs?.length;
      button('authorize-worktree').disabled ||= !field('worktree').value.trim();
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
      dependency = null;
      element('[data-capture-dependency]').textContent = '授权后检查 Git 依赖；外部目录逐根确认后才会读取。';
      const policy = result.policy;
      field('worktree').value = policy.authorizedDirs?.[0] || project?.worktreePath || project?.path || '';
      for (const name of scopeNames) {
        if (name === 'callbackInputAuthorized') field(name).checked = policy[name] === true;
        else field(name).value = name === 'windowsExternalGit'
          ? JSON.stringify(policy[name] || [], null, 2) : (policy[name] || []).join('\n');
      }
      for (const name of limitNames) field(name).value = String(policy[name]);
      savedDraft = draft();
      const status = { disabled: '已关闭', enabled: '已开启', suspended: '已暂停' }[policy.status] || String(policy.status);
      element('[data-capture-status]').textContent = `项目：${project.name || project.id} · 状态：${status}${policy.suspendReason ? ` · ${policy.suspendReason}` : ''}`;
      if (usageUnavailable) {
        element('[data-capture-storage-detail]').textContent = '';
        element('[data-capture-usage]').textContent = '已提交占用未知：capture_usage_unavailable。策略状态仍可管理；容量读取失败不表示零占用或采集可用，请检查存储后重新读取。';
        return;
      }
      const parts = result.usage.bytesByKind;
      const labels = { blobs: 'CAS', checkpoints: '检查点', latest: 'latest', flags: '标记', retention: '保留清单', cases: '封存记录', runReferences: '运行引用' };
      const breakdown = parts && Object.keys(labels).every(key => Number.isSafeInteger(parts[key]) && parts[key] >= 0)
        ? Object.entries(labels).map(([key, label]) => `${label}：${parts[key]} B`).join(' · ') : '分项未知';
      element('[data-capture-usage]').textContent = `已保存现场占用：${result.usage.totalBytes} B · ${result.usage.blobCount} 个 blob`;
      element('[data-capture-storage-detail]').textContent = `已提交总占用：${result.usage.totalBytes} B · ${breakdown}`;
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
      dependency = null;
      element('[data-capture-dependency]').textContent = '';
      element('[data-capture-storage-detail]').textContent = '';
      for (const name of ['worktree', ...scopeNames, ...limitNames]) {
        if (name === 'callbackInputAuthorized') field(name).checked = false;
        else field(name).value = '';
      }
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
    async function act(action, gitReadConfirmed = false) {
      if (button(action).disabled) return;
      if (action === 'refresh') { await select(project); return; }
      const id = project.id;
      /** @type {Record<string, any>} */
      let body = {};
      let nextAction = '';
      const guided = action === 'authorize-worktree' || action === 'authorize-dependency';
      const endpoint = guided ? 'authorize' : action;
      if (action === 'authorize' || guided) {
        body = Object.fromEntries(scopeNames.filter(name => name !== 'windowsExternalGit').map(name => [name,
          name === 'callbackInputAuthorized' ? field(name).checked : lines(name)]));
        try {
          body.windowsExternalGit = JSON.parse(field('windowsExternalGit').value.trim() || '[]');
          if (!Array.isArray(body.windowsExternalGit)) throw new Error('invalid');
        } catch { notice('外置 Git 选择必须为 JSON 数组；未发送授权请求。'); return; }
        if (action === 'authorize-worktree') {
          body.authorizedDirs = [field('worktree').value.trim()];
          body.windowsExternalGit = body.windowsExternalGit.filter(item => item.worktree === body.authorizedDirs[0]);
        } else if (action === 'authorize-dependency') {
          if (!dependency) return;
          if (dependency.next) body.authorizedInputDirs = [...new Set([...body.authorizedInputDirs, dependency.next.path])];
          if (dependency.selection) {
            body.windowsExternalGit = body.windowsExternalGit.filter(item => item.worktree !== dependency.targetDir);
            body.windowsExternalGit.push(dependency.selection);
          }
        }
        if (!body.authorizedDirs.length) { notice('请显式填写至少一个文件采集绝对路径。'); return; }
        // Reauthorization, not a collector bypass: explicitly confirm this
        // change before sending it. Intrinsic Git-data pruning remains intact;
        // custom .git/index, .git/** and all other exclusions are unchanged.
        const gitExclusionRemoved = guided && body.excludedPatterns.includes('.git');
        if (gitExclusionRemoved) body.excludedPatterns = body.excludedPatterns.filter(item => item !== '.git');
        const consent = body.callbackInputAuthorized ? '授权本项目各 Room 公共文本上下文（不含私有/附件/委托）' : '不授权公共文本上下文';
        const description = guided
          ? `文件目录：\n${body.authorizedDirs.join('\n')}\n\n输入/Git目录：\n${body.authorizedInputDirs.join('\n') || '（无）'}\n\n${consent}\n排除规则：${body.excludedPatterns.join('、') || '（无自定义规则）'}\n系统凭据/私有目录排除不变。将重新核验并固定上述全部根的当前身份。\n${gitExclusionRemoved ? '将从排除清单移除精确项 .git，以允许分类读取；其他排除项不变。\n' : ''}本次授权允许随后检查及每次 agent turn 读取已授权 worktree 内有界的 .git 分类元数据与 .gitignore；.git 数据仍由系统强制排除、不归档。外部候选仍需另行授权。`
          : scopeNames.map(name => `${name}:\n${name === 'callbackInputAuthorized'
            ? consent : name === 'windowsExternalGit' ? JSON.stringify(body[name], null, 2) : body[name].join('\n') || '（空）'}`).join('\n\n');
        if (!confirm(`授权项目 ${project.name || id} 的以下范围？\n${description}\n\n将先关闭采集并替换原授权；失败也不自动恢复旧范围。本步骤不启用采集。请勿纳入凭据或未获准的私有目录。`)) return;
        body.confirmed = true;
      } else if (action === 'discover-git') {
        if (!gitReadConfirmed && !confirm('读取已授权 worktree 内的 .git 分类元数据与 .gitignore 识别依赖？这只是元数据检查，不归档 .git、不授权外部候选、不启用采集。其他排除与私有根保护不变。')) return;
        dependency = null;
        body = { targetDir: field('worktree').value, confirmed: true };
      } else if (action === 'enable') {
        if (!receipt || receipt.expiresAt <= now()) {
          clearReceipt(); notice('预估回执已过期，请重新预估。'); updateControls(); return;
        }
        if (!confirm(`开启项目 ${project.name || id} 的执行前采集？\n${current.policy.authorizedDirs.join('\n')}\n公共文本上下文：${current.policy.callbackInputAuthorized === true ? '已独立授权' : '未授权，将标记回调输入缺失'}\n文件预估：${receipt.totalBytes} B（不含上下文/session/图片/镜像/清单；非空间保证）。\n将于每次 agent turn 开始前采集；不代表完整回放或严格评测可用。`)) return;
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
        const result = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-capture/${endpoint}`, {
          method: 'POST', body, headers: { 'X-CAFF-CSRF-Token': csrf },
        });
        if (seq !== generation) return;
        if (action === 'discover-git') {
          if (result.ok !== true) {
            element('[data-capture-dependency]').textContent = result.reason === 'git_metadata_unsupported'
              ? 'Git 布局不受支持（git_metadata_unsupported，例如嵌套仓库/submodule 或大小写变体的 .git）。已停止本次引导，未扩大授权、未自动继续预估或开启。可改选不含嵌套仓库的验证 worktree，再重新核对授权；如需检查原目录，可在高级设置查看范围，但不保证该布局可采集，不会自动改动仓库。'
              : `无法自动检查：${result.reason || 'git_discovery_unavailable'}。未扩大授权，未开启；可在高级设置查看现有范围。`;
            notice('Git 依赖检查未完成；没有自动授权或重试。');
          } else {
            if (typeof result.ready !== 'boolean' || result.targetDir !== body.targetDir
              || (result.next !== null && (!result.next || !['metadata', 'common'].includes(result.next.kind)
                || typeof result.next.path !== 'string' || !result.next.path))
              || (result.selection !== null && (!result.selection || result.selection.worktree !== body.targetDir
                || typeof result.selection.metadataRoot !== 'string' || typeof result.selection.commonRoot !== 'string'))
              || (!result.ready && !result.next)) throw new Error('git_discovery_result_invalid');
            const bound = !result.selection || (current.policy.windowsExternalGit || []).some(item =>
              ['worktree', 'metadataRoot', 'commonRoot'].every(key => item[key] === result.selection[key]));
            if (result.next || !bound) {
              dependency = result;
              element('[data-capture-dependency]').textContent = result.next
                ? `需单独授权${result.next.kind === 'metadata' ? '本 worktree 的 Git 元数据' : 'Git 公共元数据'}目录：\n${result.next.path}\n候选来自已授权目录中的指针；尚未单独授权此根，不会因此扩大读取范围。确认框会列出本次全部授权范围，仍不会启用采集。`
                : 'Git 目录均已授权，请确认它们与本 worktree 的关联；仍不会启用采集。';
              notice('请核对所列 Git 范围并单独确认；取消不会授权。');
            } else {
              element('[data-capture-dependency]').textContent = 'Git 依赖范围已确认；开始容量预估（不是完整回放或一致性证明）。';
              nextAction = 'estimate';
            }
          }
        } else if (action === 'estimate') {
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
          const unsupportedGit = Array.isArray(result.estimates) && result.estimates.some(item => item.reason === 'windows_git_environment_unsupported');
          notice(previewOnly ? unsupportedGit
            ? '当前实例的 Git 全局/system 配置环境暂不支持采集；不会自动关闭或改动 Git 配置，也不会读取未授权的外部配置。容量仍为元数据预估，不能开启。'
            : '容量预估可用，但 Windows 文件采集尚未接通；不能开启。预估包括 ignored 文件，不含 session、镜像和清单成本；已知凭据/私有名称强制排除，未扫描内容。'
            : valid ? '预估成功；仍未自动开启。请另行确认开启。' : '无可用开启回执；请检查原因后重新预估。');
        } else {
          showState(result);
          notice(endpoint === 'authorize' ? '已授权但未开启，请先预估。' : action === 'disable' ? '已关闭；不删除已有现场。' : action === 'enable' ? '已开启；采集能力和材料完整性仍需逐次检查。' : '已保存期限/配额，授权范围未变；未保存的范围草稿已丢弃，显示当前持久化范围。');
          if (guided) nextAction = 'discover-git';
        }
      } catch (error) {
        if (seq === generation) {
          dependency = null;
          element('[data-capture-dependency]').textContent = '操作未完成，请重新读取状态并检查依赖。';
          clearReceipt(); showError(error);
        }
      } finally {
        if (seq === generation) { pending = ''; updateControls(); }
      }
      if (seq === generation && nextAction) await act(nextAction, guided);
    }
    for (const action of ['authorize', 'authorize-worktree', 'authorize-dependency', 'discover-git', 'settings', 'estimate', 'enable', 'disable', 'refresh']) {
      button(action).addEventListener('click', () => { void act(action); });
    }
    root.addEventListener('input', () => {
      dependency = null;
      element('[data-capture-dependency]').textContent = '目录或设置有未保存编辑；请先确认授权或重新读取。';
      clearReceipt(); notice('有未保存编辑。范围需重新授权；期限/配额单独保存。开启前需重新预估。'); updateControls();
    });
    updateControls();
    return { select };
  };
})();
