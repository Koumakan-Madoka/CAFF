// @ts-check
(function registerPlannerTerminalPane() {
  const chat = window.CaffChat || (window.CaffChat = {});
  const explanations = {
    planner_process_exited: 'Claude Code 已退出。需要时手动连接即可继续同一会话；不会自动重启。',
    planner_process_stopped: 'Claude Code 已停止。会话 UUID 保留，需要时手动连接即可继续；不会自动重启。',
    planner_process_exit_unconfirmed: '旧进程是否退出尚未确认。请先自行核实所有旧会话进程均已停止，再修复遗留租约。修复不会终止进程，也不会更换 UUID。',
    planner_session_unavailable: '会话可能不可用：可能尚未保存过消息，或会话记录已不存在。可确认后保留 UUID 重新初始化；如果会话其实还在，CLI 会拒绝一次，再打开即可恢复。元数据损坏则需要用户检查配置，不会自动重置。',
    planner_terminal_in_use: '另一个页面正在使用这个终端。请先关闭该页面的终端，再手动重连。',
    planner_room_busy: '房间进程正在启动、运行或停止，请稍后手动刷新状态。',
    planner_process_limit: '全局规划者进程已达上限，不会替你停止其他房间。',
    planner_workspace_invalid: '房间工作区不可用，请检查绑定；不会自动改用其他目录。',
    planner_cli_version_unsupported: 'Claude Code 版本低于支持下限，请自行更新后按授权流程重启实例。',
    planner_cli_missing: '未找到 Claude Code，请检查本机安装和配置。',
    planner_cli_version_invalid: '无法识别 Claude Code 版本，请检查安装版本；没有启动房间进程。',
    planner_cli_probe_timeout: 'Claude Code 版本检查超时，请检查本机安装后手动刷新。',
    planner_cli_launch_unsupported: '不支持当前 Claude Code 启动入口，请检查本机安装布局。',
    planner_environment_invalid: '缺少必需的用户或系统路径配置，请检查允许列表环境。',
    planner_process_spawn_failed: '无法启动规划者进程，请检查本机配置后手动重连。',
    planner_terminal_connection_failed: '终端连接失败，请检查服务并手动重连。没有自动重试或重放输入。',
    planner_cli_checking: '正在核查 Claude Code 版本，请稍后手动刷新。',
    planner_terminal_assets_unavailable: '终端静态资源不可用，请检查构建结果。',
    planner_terminal_unicode_unavailable: 'Unicode 字素插件不可用，已停止连接以避免重影；请检查本地构建资源，不会回退到旧宽度表。',
    planner_conpty_unavailable: 'node-pty 自带的新版 ConPTY 不可用，请检查依赖安装中的 conpty.dll 和 OpenConsole.exe；不会回退到系统旧版。',
    planner_terminal_auth_invalid: '终端鉴权未通过。请刷新页面或明确点击重连获取新凭据；不会自动重试。',
    planner_terminal_message_invalid: '终端协议不匹配，已断开；没有重放输入。',
    planner_terminal_slow_consumer: '终端连接过慢，已断开以限制缓冲；请手动重连。',
  };
  const labels = { connecting: '正在连接', authenticating: '正在鉴权', attached: '已连接', disconnected: '已断开（手动重连）', exited: '已退出', stopping: '正在停止', unavailable: '暂不可用' };

  /** Pane owns its DOM/requests only, never chat messages or planner credentials. @param {any} options */
  chat.createPlannerTerminalPane = function createPlannerTerminalPane(options = {}) {
    const fetchJson = options.fetchJson || window.CaffShared.fetchJson;
    const confirm = options.confirm || (text => window.confirm(text));
    const clientFactory = options.clientFactory || chat.createPlannerTerminalClient;
    const q = id => document.getElementById('planner-terminal-' + id);
    const pane = q('pane'), toggle = /** @type {HTMLButtonElement} */ (q('toggle')), resize = q('resize'), screen = q('screen');
    if (!pane || !toggle || !resize || !screen) throw new Error('Planner terminal pane DOM is required');
    const button = id => /** @type {HTMLButtonElement} */ (q(id));
    const narrow = window.matchMedia('(max-width: 1099px)');
    const listeners = [];
    let roomId = '', capability = {}, epoch = 0, visible = false, operation = false, destroyed = false;
    let phase = 'disconnected', lastCode = '', preferredWidth = 500, pointer = null;
    let readToken = '', wakeState = {}, recordsBefore = null, recordId = '', recordAfter = 0, recordsHasMore = false, recordHasMore = false;
    const wakeInput = /** @type {HTMLInputElement} */ (q('wakeups'));
    try { const saved = Number(localStorage.getItem('caff:planner-terminal-width')); if (saved >= 320 && saved <= 900) preferredWidth = saved; } catch {}
    function listen(target, event, fn) { target.addEventListener(event, fn); listeners.push(() => target.removeEventListener(event, fn)); }
    function notice(text) { q('notice').textContent = text; }
    function controls() {
      button('reconnect').disabled = operation || ['connecting','authenticating','stopping'].includes(phase);
      button('refresh').disabled = operation;
      button('stop').disabled = operation || phase !== 'attached';
      button('repair').hidden = lastCode !== 'planner_process_exit_unconfirmed';
      button('reinitialize').hidden = lastCode !== 'planner_session_unavailable';
      button('repair').disabled = button('reinitialize').disabled = operation || ['connecting','authenticating','attached','stopping'].includes(phase);
      wakeInput.disabled = operation || (!wakeState.wakeupAvailable && !wakeState.wakeupsEnabled);
      button('records').disabled = operation || !readToken;
      button('records-next').disabled = operation || !recordsHasMore;
      button('record-next').disabled = operation || !recordHasMore;
      for (const row of q('record-list').querySelectorAll('button')) row.disabled = operation;
    }
    function showWakeState(state) {
      wakeState = state; wakeInput.checked = !!state.wakeupsEnabled;
      const reasons = { planner_wakeup_tools_unverified: '叫醒工具策略未验证：仅支持已验证的 2.1.x（至少 2.1.310）且可信路径无空格；需规划者重新验证。', planner_wakeup_credential_unavailable: '叫醒凭证文件不可用，请检查本机规划者凭证。', planner_wakeup_goal_unbound: '只有当前规划者绑定的未完成 Goal 可以开启叫醒。', planner_wakeup_storage_unavailable: '叫醒存储不可用，已停止后续叫醒；请检查本机实例。', session_uninitialized: '请先打开终端并保存一次会话；初始化前不会叫醒。' };
      const issue = state.wakeupSettingsIssue;
      const kinds = { bash_allow: 'Bash 放行规则', read_allow: 'Read/Glob/Grep 放行规则', additional_directories: 'additionalDirectories 非空', unreadable: '读不了', invalid_json: '解析不了（须为 JSON 对象）' };
      const settingsReason = state.wakeupReasonCode === 'planner_wakeup_settings_unsafe'
        ? '叫醒设置不安全：' + (typeof issue?.file === 'string' ? issue.file : '设置文件') + '；' + (kinds[issue?.kind] || '请检查设置文件') + '。未启动叫醒，不占配额，事项保持待处理。'
        : '';
      q('wake-status').textContent = `待处理 ${state.pendingCount || 0}；需要用户 ${state.needsUserCount || 0}；小时用量 ${state.quota?.used || 0} / 4。` + (settingsReason || reasons[state.wakeupReasonCode] || '') + ' 终端在线或仍在保留期时不叫醒。';
      controls();
    }
    function clearRecords() {
      recordsBefore = null; recordId = ''; recordAfter = 0; recordsHasMore = recordHasMore = false;
      q('record-panel').hidden = true; q('record-list').replaceChildren(); q('record-output').textContent = ''; q('record-title').textContent = '';
      button('records-next').disabled = button('record-next').disabled = true;
    }
    function setStatus(next, code = '') {
      // A socket close after an exit/error must not erase the actionable reason.
      if (next === 'disconnected' && ['exited','unavailable'].includes(phase)) return;
      phase = next;
      if (next === 'unavailable' && !code) code = 'planner_terminal_connection_failed';
      if (code) { lastCode = code; notice(explanations[code] || '终端暂不可用，请检查本机配置后手动重连。不会自动重试或重放输入。'); }
      q('status').textContent = labels[next] || '暂不可用';
      pane.dataset.connection = next; controls();
    }
    const client = clientFactory({ screen, onState: setStatus, onNotice: notice,
      onReady(message) { lastCode = ''; notice(message.resumed ? '已续接同一会话；仅显示后续输出，不回放历史。' : '正在初始化同一房间会话；若目录可信，请自行选择 Yes, I trust this folder（默认可能为 No, exit）。CAFF 不会自动确认。'); controls(); },
      onExit(message) { setStatus('exited', message.reasonCode || 'planner_process_exited'); },
      onAttention(message) { if (Number.isSafeInteger(message.unresolvedCount)) { showWakeState({ ...wakeState, pendingCount: message.unresolvedCount, needsUserCount: message.needsUserCount }); notice(`有 ${message.unresolvedCount} 条待处理事项，请读取当前状态；不会注入终端输入。`); } },
      focusToolbar() { button('close').focus(); } });
    function widthLimit() {
      const side = document.getElementById('sidebar')?.getBoundingClientRect().width || 0;
      const rail = document.querySelector('.rail')?.getBoundingClientRect().width || 0;
      return Math.min(900, Math.max(320, window.innerWidth - side - rail - 380));
    }
    function applyWidth(value = preferredWidth, persist = false) {
      const max = widthLimit(), width = Math.round(Math.max(320, Math.min(max, value)));
      pane.style.setProperty('--planner-terminal-width', width + 'px');
      resize.setAttribute('aria-valuenow', String(width)); resize.setAttribute('aria-valuemax', String(max));
      if (persist) { preferredWidth = width; try { localStorage.setItem('caff:planner-terminal-width', String(width)); } catch {} }
      client.fit();
    }
    function layout() {
      if (!visible) return;
      // Snapshot before inert: browsers may drop background focus to BODY.
      const focusInside = pane.contains(document.activeElement);
      pane.setAttribute('role', narrow.matches ? 'dialog' : 'region');
      if (narrow.matches) pane.setAttribute('aria-modal', 'true'); else pane.removeAttribute('aria-modal');
      window.caffShell?.setTerminalOverlay(narrow.matches);
      if (narrow.matches && !focusInside) button('close').focus();
      applyWidth();
    }
    function close(restoreFocus = true) {
      epoch++; visible = false; operation = false; pointer = null; readToken = ''; clearRecords();
      client.dispose(); phase = 'disconnected';
      pane.hidden = true; pane.inert = true; pane.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      window.caffShell?.setTerminalOverlay(false);
      if (restoreFocus && !toggle.hidden) toggle.focus();
    }
    function isCurrent(id, version) { return !destroyed && visible && id === roomId && version === epoch; }
    async function readState(id, version) {
      // Explicit user action always refreshes bootstrap. No cached-token retry.
      const boot = await fetchJson('/api/bootstrap');
      if (!isCurrent(id, version)) return null;
      if (!boot.plannerTerminal?.enabled) { close(); toggle.hidden = true; return null; }
      const token = boot.apiSecurity?.csrfToken;
      if (typeof token !== 'string' || !token) throw new Error('missing bootstrap');
      readToken = token;
      const state = await fetchJson(`/api/conversations/${encodeURIComponent(id)}/planner/state`, { headers: { 'X-CAFF-CSRF-Token': token } });
      if (!isCurrent(id, version)) return null;
      showWakeState(state);
      return { state, token, capability: boot.plannerTerminal };
    }
    async function connect() {
      if (!visible || operation) return;
      const id = roomId, version = ++epoch; operation = true;
      client.dispose(); phase = 'connecting'; controls(); q('status').textContent = labels.connecting;
      try {
        const result = await readState(id, version);
        if (!result) return;
        if (result.state.processState === 'uncertain') { setStatus('unavailable', 'planner_process_exit_unconfirmed'); return; }
        if (['headless-running','starting','stopping'].includes(result.state.processState)) { setStatus('unavailable', 'planner_room_busy'); return; }
        if (!result.capability.available || !result.state.available) { setStatus('unavailable', result.state.reasonCode || result.capability.reasonCode); return; }
        client.connect(id, result.token);
      } catch (error) {
        if (isCurrent(id, version)) { client.dispose(); setStatus('unavailable', error.code); }
      } finally { if (isCurrent(id, version)) { operation = false; controls(); } }
    }
    async function open() {
      if (destroyed || visible || !roomId || !capability.enabled) return;
      window.caffShell?.closeDrawer();
      visible = true; pane.hidden = false; pane.inert = false; pane.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true'); layout(); button('close').focus(); await connect();
    }
    async function refresh() {
      if (!visible || operation) return;
      const id = roomId, version = epoch; operation = true; controls();
      try {
        const result = await readState(id, version);
        if (!result) return;
        if (result.state.processState === 'uncertain') setStatus('unavailable', 'planner_process_exit_unconfirmed');
        else if (!result.state.available) setStatus('unavailable', result.state.reasonCode);
        else if (phase !== 'attached') { phase = 'disconnected'; q('status').textContent = '状态已刷新，请手动连接'; controls(); }
      } catch (error) { if (isCurrent(id, version)) setStatus('unavailable', error.code); }
      finally { if (isCurrent(id, version)) { operation = false; controls(); } }
    }
    async function recover(kind) {
      if (!visible || operation) return;
      const id = roomId, version = epoch;
      const text = kind === 'repair'
        ? '请先自行确认这个房间所有旧会话进程均已停止。此操作只释放遗留租约，不终止进程、不改变会话 UUID。确认修复？'
        : '会话可能尚未保存消息或已不存在。保留 UUID，只允许下一次手动连接重新初始化；如果会话其实还在，CLI 会拒绝一次，再打开即可恢复。确认？';
      if (!confirm(text) || !isCurrent(id, version)) return;
      operation = true; controls();
      try {
        await fetchJson(`/api/conversations/${encodeURIComponent(id)}/planner/terminal/${kind === 'repair' ? 'repair' : 'session/reinitialize'}`, { method: 'POST', body: { confirm: true } });
        if (!isCurrent(id, version)) return;
        lastCode = ''; phase = 'disconnected'; q('status').textContent = '恢复操作已确认';
        notice('操作完成。请手动连接；没有自动重连或发送输入。');
      } catch (error) { if (isCurrent(id, version)) setStatus('unavailable', error.code); }
      finally { if (isCurrent(id, version)) { operation = false; controls(); } }
    }
    async function toggleWakeups() {
      const enabled = wakeInput.checked, id = roomId, version = epoch;
      wakeInput.checked = !!wakeState.wakeupsEnabled;
      if (!visible || operation || (enabled && !confirm('自动叫醒会消耗 Claude 订阅额度，每房间每小时最多 4 次，仅处理当前规划者 Goal 的指定事项。终端在线或保留期间不运行。确认开启？'))) return;
      operation = true; controls();
      try {
        await fetchJson(`/api/conversations/${encodeURIComponent(id)}/planner/wakeups`, { method: 'PUT', body: { enabled } });
        if (isCurrent(id,version)) { wakeState.wakeupsEnabled = enabled; wakeInput.checked = enabled; }
      } catch { if (isCurrent(id,version)) q('wake-status').textContent = '叫醒设置未确认，请手动刷新状态；不会自动重试。'; }
      finally { if (isCurrent(id,version)) { operation = false; controls(); } }
    }
    async function readRecords(before = null) {
      if (!visible || operation) return;
      const id = roomId, version = epoch; operation = true; controls();
      try {
        const page = await fetchJson(`/api/conversations/${encodeURIComponent(id)}/planner/wakeups` + (before === null ? '' : `?before=${before}`), { headers: { 'X-CAFF-CSRF-Token': readToken } });
        if (!isCurrent(id,version)) return;
        q('record-panel').hidden = false; q('record-list').hidden = false; q('record-list').replaceChildren(); q('record-output').textContent = '';
        q('record-title').textContent = '叫醒摘要（正文保留 30 天；显示内容可能已截断）';
        recordsBefore = page.nextBefore; recordsHasMore = !!page.hasMore; recordId = ''; recordAfter = 0; recordHasMore = false;
        for (const item of page.items || []) {
          const row = document.createElement('button'); row.type = 'button'; row.className = 'ghost-button';
          row.textContent = `${item.reservedAt} · ${item.status} · ${item.summary}`;
          row.addEventListener('click', () => { recordId = item.id; recordAfter = 0; void readRecord(); }); q('record-list').append(row);
        }
      } catch { if (isCurrent(id,version)) q('record-title').textContent = '记录读取失败，请手动重试。'; }
      finally { if (isCurrent(id,version)) { operation = false; controls(); client.fit(); } }
    }
    async function readRecord() {
      if (!visible || operation || !recordId) return;
      const id = roomId, version = epoch, attempt = recordId; operation = true; controls();
      try {
        const page = await fetchJson(`/api/conversations/${encodeURIComponent(id)}/planner/wakeups/${encodeURIComponent(attempt)}?afterChunk=${recordAfter}`, { headers: { 'X-CAFF-CSRF-Token': readToken } });
        if (!isCurrent(id,version) || recordId !== attempt) return;
        q('record-title').textContent = `${page.summary?.status || ''}${page.summary?.reasonCode ? ' · ' + page.summary.reasonCode : ''}${page.truncated ? ' · 正文已截断' : ''}${page.transcriptExpired ? ' · 正文已过期' : ''}`;
        q('record-list').hidden = true;
        q('record-output').textContent = (page.chunks || []).map(item => `[${item.kind}] ${item.text}`).join('\n');
        recordAfter = page.nextAfter; recordHasMore = !!page.hasMore;
      } catch { if (isCurrent(id,version)) q('record-title').textContent = '事件读取失败，请手动重试。'; }
      finally { if (isCurrent(id,version)) { operation = false; controls(); client.fit(); } }
    }
    listen(wakeInput, 'change', () => { void toggleWakeups(); });
    listen(button('records'), 'click', () => { void readRecords(); });
    listen(button('records-next'), 'click', () => { void readRecords(recordsBefore); });
    listen(button('record-next'), 'click', () => { void readRecord(); });
    listen(button('records-close'), 'click', () => { clearRecords(); client.fit(); button('records').focus(); });
    listen(toggle, 'click', () => { if (visible) close(); else void open(); });
    listen(button('close'), 'click', () => close());
    listen(pane, 'caff-terminal-close', () => close());
    listen(button('reconnect'), 'click', () => { void connect(); });
    listen(button('refresh'), 'click', () => { void refresh(); });
    listen(button('repair'), 'click', () => { void recover('repair'); });
    listen(button('reinitialize'), 'click', () => { void recover('reinitialize'); });
    listen(button('stop'), 'click', () => {
      const id = roomId;
      if (phase === 'attached' && confirm('停止当前房间的规划者进程及其子进程？会话 UUID 保留。') && id === roomId && visible) client.terminate();
    });
    listen(resize, 'keydown', event => {
      let value = Number(resize.getAttribute('aria-valuenow'));
      if (event.key === 'ArrowLeft') value += 32;
      else if (event.key === 'ArrowRight') value -= 32;
      else if (event.key === 'Home') value = 320;
      else if (event.key === 'End') value = widthLimit();
      else return;
      event.preventDefault(); applyWidth(value, true);
    });
    listen(resize, 'pointerdown', event => {
      if (event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX, width: Number(resize.getAttribute('aria-valuenow')) };
      resize.setPointerCapture?.(event.pointerId); event.preventDefault();
    });
    listen(resize, 'pointermove', event => { if (pointer?.id === event.pointerId) applyWidth(pointer.width + pointer.x - event.clientX); });
    const endDrag = event => { if (pointer?.id === event.pointerId) { applyWidth(Number(resize.getAttribute('aria-valuenow')), true); pointer = null; } };
    listen(resize, 'pointerup', endDrag); listen(resize, 'pointercancel', endDrag);
    listen(window, 'resize', layout); listen(narrow, 'change', layout);
    listen(window, 'pagehide', () => close(false));
    return { open, close, refresh,
      sync(id, nextCapability) {
        if (id !== roomId) { close(false); roomId = id || ''; lastCode = ''; notice(''); }
        capability = nextCapability || {};
        toggle.hidden = !capability.enabled; toggle.disabled = !roomId;
        if (!capability.enabled && visible) close();
      },
      destroy() { close(false); destroyed = true; for (const remove of listeners) remove(); },
    };
  };
})();
