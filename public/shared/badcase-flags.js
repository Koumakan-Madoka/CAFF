// @ts-check
(function registerBadcaseFlags() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseFlagPanel = function createBadcaseFlagPanel({ root, fetchJson, confirm = text => window.confirm(text) }) {
    let selected = null, generation = 0, csrf = '', ready = false, pending = false, existing = null;
    root.innerHTML = `
      <h2 id="badcase-flag-title">标记消息问题（预览）</h2>
      <p data-flag-target></p>
      <p class="muted">只记录问题描述，不会开启采集。标记不是 prompt 根因结论；目前尚未封存文件、输入或轨迹，不能保证现场保全、回放或评测。</p>
      <p class="muted">描述保存后不可修改。不要填写凭据或未授权的私有内容；同一 OS 用户的本地进程可读取描述。</p>
      <p data-flag-status role="status" aria-live="polite"></p>
      <div class="settings-form">
        <label>实际问题（最多 8192 UTF-8 字节）<textarea name="actual" rows="4" maxlength="8192"></textarea></label>
        <label>期望行为（最多 8192 UTF-8 字节）<textarea name="expected" rows="4" maxlength="8192"></textarea></label>
      </div>
      <div class="button-row">
        <button type="button" data-flag-action="submit">确认标记</button>
        <button type="button" data-flag-action="refresh" class="ghost-button">重新查询（丢弃草稿）</button>
        <button type="button" data-flag-action="close" class="ghost-button">关闭</button>
      </div>
      <p data-flag-notice role="status" aria-live="polite"></p>
      <p class="muted">关闭或切换不会撤销已发出的请求；结果不确定时请重新查询。删除源消息或取消项目登记后，现有标记可能无法从此入口读取。</p>`;
    const el = selector => root.querySelector(selector);
    const field = name => el(`[name="${name}"]`);
    const button = action => el(`[data-flag-action="${action}"]`);
    const status = text => { el('[data-flag-status]').textContent = text; };
    const notice = text => { el('[data-flag-notice]').textContent = text; };
    const url = () => `/api/projects/${encodeURIComponent(selected.projectId)}/conversations/${encodeURIComponent(selected.conversationId)}/messages/${encodeURIComponent(selected.messageId)}/badcase-flag`;
    function controls() {
      button('submit').disabled = !ready || pending || Boolean(existing);
      button('refresh').disabled = !selected || pending;
      for (const name of ['actual', 'expected']) {
        field(name).disabled = !ready || pending;
        field(name).readOnly = Boolean(existing);
      }
      root.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
    function showFlag(record) {
      if (!record || ['projectId', 'conversationId', 'messageId'].some(key => record[key] !== selected[key])
        || typeof record.flagId !== 'string' || !record.flagId || typeof record.actual !== 'string' || typeof record.expected !== 'string'
        || record.sealState !== 'pending' || ['captured', 'runnable', 'reproduced', 'evaluable'].some(key => record[key] !== false)) {
        throw new Error('badcase_flag_response_invalid');
      }
      existing = record;
      field('actual').value = record.actual; field('expected').value = record.expected;
      const evidence = record.checkpointState === 'manifest_present_unverified'
        ? '清单存在但未验证，未封存'
        : '缺现场或关联证据不完整';
      status(`已标记 · 待封存 · ${evidence}（${String(record.checkpointState || 'unknown')}）`);
      notice(`标记 ID：${record.flagId}。尚不可回放或评测。`);
    }
    function failureText(error) {
      const codes = Array.isArray(error?.issues) ? error.issues.map(issue => issue?.code).filter(Boolean).join(', ') : '';
      return codes || (error?.status ? `HTTP ${error.status}` : error?.message || 'unknown_error');
    }
    function reset() {
      generation++; selected = null; ready = false; pending = false; csrf = ''; existing = null;
      for (const name of ['actual', 'expected']) field(name).value = '';
      status(''); notice(''); el('[data-flag-target]').textContent = ''; controls();
    }
    function close() {
      reset();
      if (root.open) root.close();
    }
    async function open(scope) {
      const seq = ++generation;
      selected = null; ready = false; pending = false; csrf = ''; existing = null;
      for (const name of ['actual', 'expected']) field(name).value = '';
      notice(''); status('读取标记…'); el('[data-flag-target]').textContent = '';
      if (!root.open) root.showModal();
      if (!scope || !['projectId', 'conversationId', 'messageId'].every(key => typeof scope[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(scope[key]))) {
        status('无法标记：需要已绑定项目的终态 AI 消息。'); controls(); return;
      }
      selected = { projectId: scope.projectId, conversationId: scope.conversationId, messageId: scope.messageId };
      el('[data-flag-target]').textContent = `项目 ${selected.projectId} · 会话 ${selected.conversationId} · 消息 ${selected.messageId}`;
      pending = true; controls();
      try {
        const bootstrap = await fetchJson('/api/bootstrap');
        if (seq !== generation) return;
        const admin = bootstrap.localAdmin?.modelProviders;
        if (admin?.enabled !== true || typeof admin.csrfToken !== 'string' || !admin.csrfToken) throw new Error('本地管理能力不可用');
        csrf = admin.csrfToken;
        const result = await fetchJson(url());
        if (seq !== generation) return;
        if (!result || !Object.prototype.hasOwnProperty.call(result, 'flag')) throw new Error('badcase_flag_response_invalid');
        if (result.flag !== null) showFlag(result.flag);
        else status('尚未标记；提交仅保存描述，现场尚未封存。');
        ready = true;
      } catch (error) {
        if (seq === generation) { ready = false; status('读取失败；禁止提交。'); notice(failureText(error)); }
      } finally {
        if (seq === generation) { pending = false; controls(); }
      }
    }
    async function submit() {
      if (!ready || pending || existing || !selected) return;
      const actual = field('actual').value, expected = field('expected').value;
      if ([actual, expected].some(text => !text.trim() || text.includes('\0') || new Blob([text]).size > 8192)) {
        notice('实际问题与期望不能为空，不得含 NUL，各不得超过 8192 UTF-8 字节。'); return;
      }
      if (!confirm(`确认标记消息 ${selected.messageId} 的问题？\n描述保存后不可修改；不自动开启采集，目前仍待封存。请勿填写凭据或私有秘密。`)) return;
      const seq = ++generation;
      pending = true; notice('提交中…'); controls();
      try {
        const result = await fetchJson(url(), { method: 'POST', body: { confirmed: true, actual, expected }, headers: { 'X-CAFF-CSRF-Token': csrf } });
        if (seq !== generation) return;
        showFlag(result?.flag);
      } catch (error) {
        if (seq === generation) notice(`提交失败：${failureText(error)}。结果可能已落盘，请重新查询，或保持原文重试；不自动覆盖已有标记。`);
      } finally {
        if (seq === generation) { pending = false; controls(); }
      }
    }
    button('submit').addEventListener('click', () => { void submit(); });
    button('refresh').addEventListener('click', () => { if (selected && !pending) void open(selected); });
    button('close').addEventListener('click', close);
    root.addEventListener('cancel', event => { event.preventDefault(); close(); });
    // Native close events are queued; an old close must not reset a reopened dialog.
    root.addEventListener('close', () => { if (!root.open) reset(); });
    controls();
    return { open, close, syncConversation(conversation) {
      if (selected && (conversation?.id !== selected.conversationId || (conversation.projectScopeId || conversation.projectId) !== selected.projectId)) close();
    } };
  };
})();
