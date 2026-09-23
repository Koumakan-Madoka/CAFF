// @ts-check

// Subscription OAuth login (real implementation).
// Talks to /api/subscription-auth: channel status, browser OAuth login sessions
// (PKCE + local callback, driven by the pinned pi-ai flows on the server), and
// logout. Display rule (user-confirmed): subscription display appears in the
// provider list only while the subscription is logged in; logging out of the
// openai-codex channel removes its registered provider entry as well.

(function registerSubscriptionLogin() {
  const namespace = window.CaffPersonas || (window.CaffPersonas = {});

  const CHANNELS = [
    {
      channel: 'anthropic',
      providerId: 'anthropic',
      label: 'Claude Pro / Max',
      vendor: 'Anthropic',
      mark: 'CL',
      desc: '凭证写入 auth.json 的 anthropic 条目。已配置的 anthropic 供应商无需改动，即刻被订阅凭证驱动（存储凭证优先于 API key）。',
    },
    {
      channel: 'openai-codex',
      providerId: 'openai-codex',
      label: 'ChatGPT Codex',
      vendor: 'OpenAI',
      mark: 'CD',
      desc: 'models.dev 目录不收录 openai-codex；订阅渠道只能通过订阅登录注册，登出后条目一并移除。',
    },
  ];
  const CODEX_PROVIDER_ID = 'openai-codex';
  const POLL_INTERVAL_MS = 1200;
  const ACTIVE_STATES = new Set(['starting', 'waiting_browser', 'exchanging']);

  function channelConfig(channel) {
    return CHANNELS.find((entry) => entry.channel === channel) || null;
  }

  function formatTimestamp(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return '';
    return new Date(parsed).toLocaleString('zh-CN', { hour12: false });
  }

  namespace.createSubscriptionLogin = function createSubscriptionLogin(options) {
    const root = options.root;
    const utils = namespace.managementUtils;
    const escapeHtml = utils.escapeHtml;

    let status = { channels: [], logins: [] };
    let view = ''; // '' | 'channels' | 'codex'

    const channelState = (channel) => (status.channels || []).find((entry) => entry.channel === channel) || null;
    const activeLoginFor = (channel) => (status.logins || []).find((session) => session.channel === channel) || null;

    function adminHeaders() {
      const token = options.getCsrfToken();
      return token ? { 'X-CAFF-CSRF-Token': token } : {};
    }

    function mutate(url, body) {
      if (!options.isEnabled()) throw new Error('当前部署不允许订阅登录操作');
      return options.fetchJson(url, { method: 'POST', body, headers: adminHeaders() });
    }

    async function refreshStatus() {
      status = await options.fetchJson('/api/subscription-auth');
      return status;
    }

    // ----- Channel view (detail pane, mirrors the confirmed mock layout) -----

    function channelRowMarkup(channel) {
      const state = channelState(channel.channel);
      const loggedIn = Boolean(state && state.loggedIn);
      const activeLogin = activeLoginFor(channel.channel);
      const meta = loggedIn
        ? `已连接${state.accountId ? ` · ${state.accountId}` : ''}${formatTimestamp(state.expiresAt) ? ` · access token 有效期至 ${formatTimestamp(state.expiresAt)}` : ''}`
        : channel.desc;
      let actions = '';
      if (activeLogin) {
        actions = `<button data-oauth-channel-resume="${channel.channel}" class="ghost-button" type="button">查看进行中的登录</button>`;
      } else if (loggedIn) {
        actions = `<button data-oauth-channel-logout="${channel.channel}" class="ghost-button danger" type="button">退出登录</button>`;
      } else {
        actions = `<button data-oauth-channel-login="${channel.channel}" type="button">使用浏览器登录</button>`;
      }
      if (loggedIn && channel.channel === CODEX_PROVIDER_ID) {
        actions += `<button data-oauth-channel-view type="button" class="ghost-button">查看供应商</button>`;
      }
      return `
        <div class="subscription-channel-row">
          <span class="provider-mark">${channel.mark}</span>
          <span class="subscription-channel-copy">
            <strong>${escapeHtml(channel.label)}<span class="subscription-tag">${escapeHtml(channel.vendor)}</span></strong>
            <small>${escapeHtml(meta)}</small>
          </span>
          <span class="subscription-channel-actions">${actions}</span>
        </div>`;
    }

    function renderChannelView() {
      view = 'channels';
      const loggedInCount = CHANNELS.filter((channel) => channelState(channel.channel) && channelState(channel.channel).loggedIn).length;
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Subscription Login</p><h2>通过订阅登录</h2><p>订阅 OAuth 渠道 · PKCE 浏览器授权 · 凭证写入共享 agentDir 的 auth.json。</p></div>
          <button id="oauth-channel-back" class="ghost-button" type="button">返回供应商</button>
        </div>
        <section class="management-card">
          <div class="management-card-title"><div><h3>订阅渠道</h3><p>${loggedInCount} / ${CHANNELS.length} 已登录 · token 刷新由 pi 运行时自动完成，CAFF 不自建刷新逻辑。</p></div></div>
          ${CHANNELS.map(channelRowMarkup).join('')}
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>与「搜索供应商」的关系</h3><p>两条入口互补，不是一条链路。</p></div></div>
          <p class="management-note">「搜索供应商」（models.dev 目录）只产生 API key 形态的配置。anthropic 导入条目无需改动即可被订阅凭证驱动；openai-codex 不在目录中，只能通过订阅登录注册。未登录订阅时，供应商列表不出现任何订阅相关条目。</p>
        </section>`;
      root.querySelector('#oauth-channel-back').addEventListener('click', () => {
        view = '';
        options.onClose();
      });
      root.querySelectorAll('[data-oauth-channel-login]').forEach((button) => {
        button.addEventListener('click', () => openLoginFlow(button.dataset.oauthChannelLogin));
      });
      root.querySelectorAll('[data-oauth-channel-resume]').forEach((button) => {
        button.addEventListener('click', () => {
          const session = activeLoginFor(button.dataset.oauthChannelResume);
          if (session) openLoginFlow(session.channel, session);
        });
      });
      root.querySelectorAll('[data-oauth-channel-logout]').forEach((button) => {
        button.addEventListener('click', () => logoutChannel(button.dataset.oauthChannelLogout));
      });
      root.querySelectorAll('[data-oauth-channel-view]').forEach((button) => {
        button.addEventListener('click', () => options.selectProvider(CODEX_PROVIDER_ID));
      });
    }

    // ----- openai-codex read-only provider detail (registered by login) -----

    function readonlyField(label, value) {
      return `<label><span>${escapeHtml(label)}</span><input value="${escapeHtml(value)}" readonly /></label>`;
    }

    async function renderCodexDetail() {
      view = 'codex';
      const [providerResult] = await Promise.all([
        options.fetchJson('/api/model-providers'),
        refreshStatus(),
      ]);
      const provider = (providerResult.providers || []).find((entry) => entry.id === CODEX_PROVIDER_ID);
      const state = channelState(CODEX_PROVIDER_ID);
      if (!provider || !state || !state.loggedIn) {
        view = '';
        options.onClose();
        return;
      }
      const models = Array.isArray(provider.models) ? provider.models : [];
      const modelRows = models.map((model) => `
        <div class="provider-model-row">
          ${readonlyField('模型 ID', model.id || '')}
          ${readonlyField('显示名称', model.name || model.id || '')}
          <p class="provider-model-limit-copy">上下文 ${Number.isInteger(model.contextWindow) ? model.contextWindow : 128000}（显式） · 输出 ${Number.isInteger(model.maxTokens) ? model.maxTokens : 16384}（显式）</p>
        </div>`).join('');
      root.innerHTML = `
        <div class="management-detail-top">
          <div><p class="eyebrow">Model Provider</p><h2>${escapeHtml(provider.name || CODEX_PROVIDER_ID)}</h2><p>${models.length} 个模型条目 · 订阅登录注册</p></div>
          <span class="status-badge">OAuth · external</span>
        </div>
        <section class="management-card">
          <div class="management-card-title"><div><h3>连接设置</h3><p>Provider 是 catalog 上游，不直接改写角色。</p></div></div>
          <div class="field-grid">
            ${readonlyField('Provider ID', provider.id)}
            ${readonlyField('显示名称', provider.name || '')}
            ${readonlyField('Base URL', provider.baseUrl || '')}
            ${readonlyField('API 协议', provider.api || '')}
            ${readonlyField('Authorization Header', provider.authHeader ? '启用 Bearer' : '由协议处理')}
            ${readonlyField('models.json 认证模式', 'external（auth.json）')}
          </div>
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>API Key / 鉴权</h3><p>auth.json 存储凭证优先；订阅凭证由 pi 运行时自动刷新。</p></div></div>
          <div class="field-grid">
            ${readonlyField('订阅账号', state.accountId || 'ChatGPT 订阅账号')}
            ${readonlyField('凭证格式', 'oauth · refresh + access（auth.json）')}
            ${readonlyField('access token 有效期至', formatTimestamp(state.expiresAt) || '未知')}
          </div>
          <p class="management-note">凭证在 auth.json；本 provider 由订阅登录注册进 models.json，搜索供应商覆盖不到。退出订阅登录后，本条目一并移除。</p>
          <div class="button-row"><button id="oauth-codex-logout" class="ghost-button danger" type="button">退出订阅登录</button></div>
        </section>
        <section class="management-card">
          <div class="management-card-title"><div><h3>模型目录</h3><p>显式 family 决定系统模型族角色的可见模型。</p></div></div>
          <div class="provider-model-editor">${modelRows || '<div class="empty-state">暂无模型条目。</div>'}</div>
        </section>
        <div class="management-actions"><button id="oauth-codex-validate" class="ghost-button" type="button">验证当前已保存连接</button></div>`;
      root.querySelector('#oauth-codex-logout').addEventListener('click', () => logoutChannel(CODEX_PROVIDER_ID));
      root.querySelector('#oauth-codex-validate').addEventListener('click', async () => {
        try {
          const result = await mutate(`/api/model-providers/${encodeURIComponent(CODEX_PROVIDER_ID)}/validate`, {});
          const validation = result.validation || {};
          options.showToast(`连接验证完成 · ${validation.modelCount || 0} 个模型`);
        } catch (error) {
          options.showToast(utils.requestIssueMessage(error, '连接验证失败'));
        }
      });
    }

    // ----- Login flow dialog (driven by the real session API) -----

    function flowSteps(channel) {
      const steps = [
        { key: 'pkce', label: '生成 PKCE（code_verifier / code_challenge）' },
        { key: 'browser', label: '打开系统默认浏览器授权页' },
        { key: 'callback', label: '本地回调接收授权码（localhost）' },
        { key: 'exchange', label: '交换 access / refresh token' },
        { key: 'persist', label: '写入共享 agentDir 的 auth.json' },
      ];
      if (channel === CODEX_PROVIDER_ID) {
        steps.push({ key: 'register', label: '注册 openai-codex provider 到 models.json（含 Codex 模型清单）' });
      }
      return steps;
    }

    function activeStepKey(session) {
      switch (session.state) {
        case 'starting': return 'pkce';
        case 'waiting_browser': return 'callback';
        case 'exchanging': return 'exchange';
        default: return '';
      }
    }

    // Map the backend's last-known active state (recorded at failure time) to
    // the step that should carry the error mark. Errors surface at or after
    // this step; later steps must not be shown as completed.
    function failedStepKey(session) {
      switch (session.failedStep) {
        case 'starting': return 'pkce';
        case 'waiting_browser': return 'callback';
        case 'exchanging': return 'exchange';
        default: return '';
      }
    }

    function ensureFlowDialog() {
      let backdrop = document.getElementById('oauth-flow-backdrop');
      if (backdrop) return backdrop;
      backdrop = document.createElement('div');
      backdrop.id = 'oauth-flow-backdrop';
      backdrop.className = 'new-conversation-backdrop hidden';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      const dialog = document.createElement('div');
      dialog.className = 'new-conversation-dialog';
      dialog.id = 'oauth-flow-dialog';
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeFlowDialog();
      });
      return backdrop;
    }

    const flow = { session: null, timer: 0, openedUrl: false, closed: false };

    function flowDialog() {
      return document.getElementById('oauth-flow-dialog');
    }

    function setStepMark(item, mark) {
      item.style.opacity = mark === 'pending' ? '0.55' : '1';
      item.textContent = item.textContent.replace(/^(⏳|✓|✗)\s*/u, '');
      if (mark === 'active') item.textContent = '⏳ ' + item.textContent;
      if (mark === 'done') item.textContent = '✓ ' + item.textContent;
      if (mark === 'error') item.textContent = '✗ ' + item.textContent;
    }

    function renderFlowSession(session) {
      const dialog = flowDialog();
      if (!dialog || flow.session !== session) return;
      const config = channelConfig(session.channel);
      const steps = flowSteps(session.channel);
      const activeKey = activeStepKey(session);
      const settled = !ACTIVE_STATES.has(session.state);
      const activeIndex = steps.findIndex((step) => step.key === activeKey);
      const errorKey = session.state === 'error'
        ? (failedStepKey(session) || steps[steps.length - 1].key)
        : '';
      const errorIndex = errorKey ? steps.findIndex((step) => step.key === errorKey) : -1;

      steps.forEach((step, index) => {
        const item = dialog.querySelector(`[data-step="${step.key}"]`);
        if (!item) return;
        if (session.state === 'error') {
          // Honest failure display: only steps strictly before the last known
          // progress are done, the failing step gets the error mark, and the
          // remaining steps stay pending (unknown) instead of fake checkmarks.
          if (errorIndex >= 0 && index < errorIndex) {
            setStepMark(item, 'done');
          } else if (index === errorIndex) {
            setStepMark(item, 'error');
          } else {
            setStepMark(item, 'pending');
          }
        } else if (settled || (activeIndex >= 0 && index < activeIndex)) {
          setStepMark(item, 'done');
        } else if (index === activeIndex) {
          setStepMark(item, 'active');
        } else {
          setStepMark(item, 'pending');
        }
      });

      const urlBox = dialog.querySelector('#oauth-browser-url');
      if (urlBox && session.authUrl && urlBox.textContent !== session.authUrl) {
        urlBox.textContent = session.authUrl;
      }
      const urlArea = dialog.querySelector('#oauth-browser-frame');
      if (urlArea) urlArea.classList.toggle('hidden', !session.authUrl);
      if (session.authUrl && !flow.openedUrl && !settled) {
        flow.openedUrl = true;
        // The server cannot open a desktop browser from an HTTP handler; the
        // page tries once and always keeps the manual button as fallback.
        window.open(session.authUrl, '_blank', 'noopener');
      }

      const events = dialog.querySelector('#oauth-flow-events');
      if (events) {
        const messages = (session.events || []).slice(-4).map((event) => `<li>${escapeHtml(event.message || event.type)}</li>`).join('');
        events.innerHTML = messages;
        events.closest('#oauth-flow-events-card')?.classList.toggle('hidden', !messages);
      }

      const cancel = /** @type {HTMLButtonElement} */ (dialog.querySelector('#oauth-cancel'));
      if (cancel) cancel.disabled = settled;
      const consent = /** @type {HTMLButtonElement} */ (dialog.querySelector('#oauth-open-browser'));
      if (consent) {
        consent.disabled = !session.authUrl || settled;
        if (session.authUrl) consent.dataset.authUrl = session.authUrl;
      }

      const result = dialog.querySelector('#oauth-flow-result');
      if (result && settled) {
        result.classList.remove('hidden');
        const copy = result.querySelector('.management-note');
        if (session.state === 'success') {
          copy.innerHTML = config && config.channel === CODEX_PROVIDER_ID
            ? '凭证已写入 auth.json，openai-codex provider 已注册进 models.json。搜索供应商永远覆盖不到此渠道。'
            : '凭证已写入 auth.json。已配置的 anthropic 供应商即刻起由订阅凭证驱动。';
        } else if (session.state === 'cancelled') {
          copy.textContent = '已取消：未写入任何凭证，auth.json 保持原状。';
        } else {
          copy.textContent = `登录失败：${session.error || '未知错误'}`;
        }
      }
    }

    function stopPolling() {
      if (flow.timer) {
        window.clearTimeout(flow.timer);
        flow.timer = 0;
      }
    }

    async function pollSession() {
      const session = flow.session;
      if (!session || flow.closed) return;
      try {
        const result = await options.fetchJson(`/api/subscription-auth/logins/${encodeURIComponent(session.id)}`);
        flow.session = result.session;
        renderFlowSession(flow.session);
        if (ACTIVE_STATES.has(flow.session.state)) {
          flow.timer = window.setTimeout(pollSession, POLL_INTERVAL_MS);
          return;
        }
        await handleSettledLogin(flow.session);
      } catch (error) {
        if (flow.closed) return;
        const dialogEl = flowDialog();
        if (dialogEl) {
          const result = dialogEl.querySelector('#oauth-flow-result');
          const note = result && result.querySelector('.management-note');
          if (result && note) {
            result.classList.remove('hidden');
            note.textContent = `登录状态查询失败：${utils.requestIssueMessage(error, '请稍后重试')}`;
          }
        }
        flow.timer = window.setTimeout(pollSession, POLL_INTERVAL_MS * 2);
      }
    }

    async function handleSettledLogin(session) {
      stopPolling();
      if (session.state !== 'success') return;
      await refreshStatus();
      await options.onChannelChanged();
      options.showToast(`${channelConfig(session.channel) ? channelConfig(session.channel).label : session.channel} 登录成功`);
      if (view === 'channels') renderChannelView();
    }

    function openLoginFlow(channel, existingSession = null) {
      const config = channelConfig(channel);
      if (!config) return;
      const backdrop = ensureFlowDialog();
      const dialog = flowDialog();
      const steps = flowSteps(channel);
      flow.session = existingSession;
      flow.openedUrl = false;
      flow.closed = false;
      stopPolling();

      dialog.innerHTML = `
        <div class="new-conversation-header">
          <div><h2 id="oauth-flow-title">登录 ${escapeHtml(config.label)}</h2><p>浏览器授权由你操作；凭证只写入共享 agentDir 的 auth.json。</p></div>
          <button id="oauth-flow-close" class="ghost-button" type="button">关闭</button>
        </div>
        <div style="padding:20px 22px;overflow:auto;display:grid;gap:16px">
          <ol id="oauth-flow-steps" style="margin:0;padding-left:1.2rem;display:grid;gap:0.45rem">
            ${steps.map((step, index) => `<li data-step="${step.key}" style="opacity:0.55">${index + 1}. ${escapeHtml(step.label)}</li>`).join('')}
          </ol>
          <div id="oauth-browser-frame" class="hidden" style="border:1px solid var(--caff-border);border-radius:var(--radius-sm);overflow:hidden">
            <div style="padding:0.5rem 0.8rem;border-bottom:1px solid var(--caff-border);background:var(--caff-surface-sunk);font-size:0.75rem;word-break:break-all">🔒 <span id="oauth-browser-url"></span></div>
            <div style="padding:1.1rem;display:grid;gap:0.7rem">
              <strong>在浏览器中完成授权</strong>
              <p style="margin:0;font-size:0.85rem">应在浏览器授权页登录 ${escapeHtml(config.label)} 对应账号并同意授权；完成后本页自动继续。若浏览器没有自动打开，请点击下方按钮。</p>
              <div class="button-row">
                <button id="oauth-open-browser" type="button">打开授权页</button>
                <button id="oauth-cancel" class="ghost-button" type="button">取消登录</button>
              </div>
            </div>
          </div>
          <div id="oauth-flow-events-card" class="hidden">
            <ul id="oauth-flow-events" style="margin:0;padding-left:1.2rem;display:grid;gap:0.3rem;font-size:0.78rem;color:var(--caff-text-soft)"></ul>
          </div>
          <div id="oauth-flow-result" class="hidden" style="display:grid;gap:0.6rem">
            <p class="management-note" style="margin:0"></p>
            <div class="button-row"><button id="oauth-flow-done" type="button">完成</button></div>
          </div>
        </div>`;
      backdrop.classList.remove('hidden');

      dialog.querySelector('#oauth-flow-close').addEventListener('click', closeFlowDialog);
      dialog.querySelector('#oauth-flow-done').addEventListener('click', () => {
        backdrop.classList.add('hidden');
        flow.closed = true;
        stopPolling();
      });
      const openBrowser = /** @type {HTMLButtonElement} */ (dialog.querySelector('#oauth-open-browser'));
      openBrowser.addEventListener('click', () => {
        const url = openBrowser.dataset.authUrl;
        if (url) window.open(url, '_blank', 'noopener');
      });
      dialog.querySelector('#oauth-cancel').addEventListener('click', () => cancelLogin());

      if (existingSession) {
        renderFlowSession(existingSession);
        flow.timer = window.setTimeout(pollSession, POLL_INTERVAL_MS);
        return;
      }

      mutate('/api/subscription-auth/logins', { channel })
        .then((result) => {
          if (flow.closed) return;
          flow.session = result.session;
          renderFlowSession(result.session);
          flow.timer = window.setTimeout(pollSession, POLL_INTERVAL_MS);
        })
        .catch((error) => {
          if (flow.closed) return;
          const result = dialog.querySelector('#oauth-flow-result');
          result.classList.remove('hidden');
          result.querySelector('.management-note').textContent = utils.requestIssueMessage(error, '登录发起失败');
          const cancel = /** @type {HTMLButtonElement | null} */ (dialog.querySelector('#oauth-cancel'));
          if (cancel) cancel.disabled = true;
        });
    }

    async function cancelLogin() {
      const session = flow.session;
      const dialog = flowDialog();
      if (!session || !ACTIVE_STATES.has(session.state)) return;
      try {
        const result = await mutate(`/api/subscription-auth/logins/${encodeURIComponent(session.id)}/cancel`, {});
        flow.session = result.session;
        renderFlowSession(result.session);
        stopPolling();
      } catch (error) {
        if (dialog) options.showToast(utils.requestIssueMessage(error, '取消登录失败'));
      }
    }

    function closeFlowDialog() {
      const backdrop = document.getElementById('oauth-flow-backdrop');
      if (!backdrop || backdrop.classList.contains('hidden')) return;
      backdrop.classList.add('hidden');
      flow.closed = true;
      stopPolling();
      if (flow.session && ACTIVE_STATES.has(flow.session.state)) {
        // Closing the dialog abandons the browser flow; cancel the session so
        // the callback port is released instead of lingering until timeout.
        void cancelLogin();
      }
    }

    // ----- Logout -----

    async function logoutChannel(channel) {
      const config = channelConfig(channel);
      if (!config) return;
      try {
        await mutate('/api/subscription-auth/logout', { channel });
        await refreshStatus();
        await options.onChannelChanged();
        options.showToast(channel === CODEX_PROVIDER_ID
          ? `${config.label} 已退出登录；openai-codex 供应商条目一并移除`
          : `${config.label} 已退出登录；anthropic 回退到 API key（如已配置）`);
        if (view === 'channels') {
          renderChannelView();
        } else {
          // view === '' (editor detail) or 'codex': the providers were already
          // reloaded by onChannelChanged, so re-render the detail pane from the
          // fresh data instead of leaving a stale logged-in view behind.
          view = '';
          options.onClose();
        }
      } catch (error) {
        options.showToast(utils.requestIssueMessage(error, '退出登录失败'));
      }
    }

    return {
      async open() {
        await refreshStatus();
        renderChannelView();
      },
      refreshStatus,
      renderCodexDetail,
      logout: logoutChannel,
      describeProvider(providerId) {
        const config = CHANNELS.find((entry) => entry.providerId === providerId);
        if (!config) return null;
        const state = channelState(config.channel);
        if (!state || !state.loggedIn) return null;
        return {
          channel: config.channel,
          label: config.label,
          accountId: state.accountId || '',
          expiresAt: state.expiresAt,
          expiresLabel: formatTimestamp(state.expiresAt) || '未知',
        };
      },
    };
  };
})();
