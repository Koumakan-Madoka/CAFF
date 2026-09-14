// @ts-check
// Official-channel OAuth login mock (v2) — overlaid on the REAL provider management view.
// Mock only: no backend calls, no real network requests. Login state persists in localStorage.
// Removal plan: when the real OAuth backend lands, delete this file plus the two touch points
// in personas.html (the #official-channel-login button and this script tag); the real
// implementation replaces openLoginFlow with an API call and drops the DOM observers.

(function registerOauthLoginMockV2() {
  const STORAGE_KEY = 'caff.oauthLoginMock.v2';
  const stepWait = () => (window.CAFF_OAUTH_MOCK_FAST ? 5 : 600);

  const CHANNELS = {
    anthropic: {
      key: 'anthropic',
      stateKey: 'anthropic',
      label: 'Claude Pro / Max',
      vendor: 'Anthropic',
      authorizeUrl: 'https://claude.ai/oauth/authorize?client_id=…&code_challenge=…',
      scopes: ['oauth:read:user', 'chat:read', 'chat:write'],
      account: 'claude-pro@example.com',
      extraStep: '',
      desc: '凭证写入 auth.json 的 anthropic 条目。目录导入或手动配置的 anthropic 供应商无需改动，即刻被订阅凭证驱动（存储凭证优先于 API key）。',
    },
    codex: {
      key: 'codex',
      stateKey: 'openai-codex',
      label: 'ChatGPT Codex',
      vendor: 'OpenAI',
      authorizeUrl: 'https://auth.openai.com/oauth/authorize?client_id=…&code_challenge=…',
      scopes: ['chatgpt.account.read', 'codex'],
      account: 'chatgpt-pro@example.com',
      extraStep: '注册 openai-codex provider 到 models.json（含 Codex 模型清单）',
      desc: 'models.dev 目录不收录 openai-codex；订阅渠道只能通过官方渠道登录注册。',
    },
  };

  const DEMO_PROVIDERS = [
    {
      id: 'anthropic', name: 'Anthropic', modelCount: 9, api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com', sourceLabel: '目录导入 · 演示条目',
      models: ['claude-opus-4.5', 'claude-sonnet-4.5', 'claude-haiku-4.5'],
    },
    {
      id: 'openai', name: 'OpenAI（API）', modelCount: 12, api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1', sourceLabel: '目录导入 · 演示条目',
      models: ['gpt-5.2', 'gpt-5.2-mini'],
    },
  ];

  const CODEX_PROVIDER = {
    id: 'openai-codex', name: 'OpenAI Codex（订阅）', modelCount: 3, api: 'openai-codex-responses',
    baseUrl: '（由 pi 的 openai-codex provider 定义）', sourceLabel: '官方渠道登录注册',
    models: ['gpt-5.2-codex', 'gpt-5.2-codex-high', 'gpt-5.1-codex'],
  };

  const $ = (id) => document.getElementById(id);

  let state = loadState();
  let channelViewActive = false;
  let mockDetailId = '';

  function defaultState() {
    return {
      channels: {
        anthropic: { logged: false, account: '', expiresAt: '' },
        'openai-codex': { logged: false, account: '', expiresAt: '' },
      },
      codexRegistered: false,
    };
  }

  function loadState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      base.channels.anthropic = Object.assign(base.channels.anthropic, parsed.channels && parsed.channels.anthropic);
      base.channels['openai-codex'] = Object.assign(base.channels['openai-codex'], parsed.channels && parsed.channels['openai-codex']);
      base.codexRegistered = Boolean(parsed.codexRegistered);
      return base;
    } catch (error) {
      return defaultState();
    }
  }

  function saveState() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (error) { /* mock only */ }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/gu, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
  }

  let toastTimer = 0;
  function showToast(message) {
    const target = $('toast');
    if (!target) return;
    target.textContent = message;
    target.classList.remove('hidden');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => target.classList.add('hidden'), 2600);
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.setAttribute('data-oauth-mock-styles', '');
    style.textContent = `
      .oauth-mock-channel-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:0.8rem; padding:0.7rem 0; }
      .oauth-mock-channel-row + .oauth-mock-channel-row { border-top:1px solid var(--caff-border); }
      .oauth-mock-channel-copy { display:grid; gap:0.2rem; min-width:0; }
      .oauth-mock-channel-copy small { color:var(--caff-text-soft); overflow:hidden; text-overflow:ellipsis; }
      .oauth-mock-channel-actions { display:flex; flex-wrap:wrap; gap:0.45rem; justify-content:flex-end; }
      .oauth-mock-tag { display:inline-block; margin-left:0.4rem; padding:0 0.35rem; border:1px dashed var(--caff-border); border-radius:6px; font-size:0.68rem; color:var(--caff-text-soft); }
    `;
    document.head.appendChild(style);
  }

  // ----- Provider list overlay -----

  function buildMockRow(provider, options) {
    const li = document.createElement('li');
    li.className = 'management-list-item';
    li.setAttribute('data-oauth-mock-row', provider.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-list-item management-list-row';
    button.dataset.providerId = provider.id;
    const mark = document.createElement('span');
    mark.className = 'provider-mark';
    mark.textContent = provider.id.slice(0, 2).toUpperCase();
    const copy = document.createElement('span');
    copy.className = 'management-list-copy';
    const name = document.createElement('strong');
    name.textContent = provider.name;
    if (options && options.tag) {
      const tag = document.createElement('span');
      tag.className = 'oauth-mock-tag';
      tag.textContent = options.tag;
      name.appendChild(tag);
    }
    const meta = document.createElement('small');
    const oauthNote = provider.id === 'anthropic' && state.channels.anthropic.logged ? ' · OAuth external' : '';
    const credentialNote = provider.id === 'openai-codex'
      ? (state.channels['openai-codex'].logged ? ' · OAuth external' : ' · OAuth 凭证已移除')
      : '';
    meta.textContent = `${provider.id} · ${provider.sourceLabel} · ${provider.modelCount} 个模型${oauthNote}${credentialNote}`;
    copy.append(name, meta);
    const status = document.createElement('span');
    const loggedIn = provider.id === 'anthropic' ? state.channels.anthropic.logged : state.channels['openai-codex'].logged;
    status.className = `status-dot${loggedIn ? ' default' : ' warning'}`;
    status.title = loggedIn ? 'auth.json OAuth 凭证优先于 API key' : (provider.id === 'openai-codex' ? 'OAuth 凭证已移除，等待重新登录' : '演示条目 · 待验证');
    button.append(mark, copy, status);
    button.addEventListener('click', () => { renderMockDetail(provider.id); });
    li.appendChild(button);
    return li;
  }

  function patchAnthropicRow(button) {
    const small = button.querySelector('.management-list-copy small');
    if (!small) return;
    if (!small.dataset.oauthBaseMeta) small.dataset.oauthBaseMeta = small.textContent;
    small.textContent = state.channels.anthropic.logged
      ? `${small.dataset.oauthBaseMeta} · OAuth external`
      : small.dataset.oauthBaseMeta;
    const dot = button.querySelector('.status-dot');
    if (dot) {
      dot.classList.toggle('default', state.channels.anthropic.logged);
      dot.classList.toggle('warning', !state.channels.anthropic.logged);
      dot.title = state.channels.anthropic.logged ? 'auth.json OAuth 凭证优先于 API key' : dot.title;
    }
  }

  function overlayList() {
    const list = $('provider-list');
    if (!list) return;
    list.querySelectorAll('[data-oauth-mock-row]').forEach((li) => li.remove());
    const realRows = Array.from(list.querySelectorAll('button[data-provider-id]'));
    const realIds = new Set(realRows.map((row) => row.dataset.providerId));
    let mockCount = 0;
    for (const provider of DEMO_PROVIDERS) {
      if (realIds.has(provider.id)) continue;
      list.appendChild(buildMockRow(provider, { tag: '演示' }));
      mockCount += 1;
    }
    if (state.codexRegistered) {
      list.appendChild(buildMockRow(CODEX_PROVIDER, { tag: '登录注册' }));
      mockCount += 1;
    }
    if (mockCount) {
      const empty = list.querySelector('.empty-state');
      if (empty) empty.remove();
    }
    const anthropicRow = list.querySelector('button[data-provider-id="anthropic"]');
    if (anthropicRow) patchAnthropicRow(anthropicRow);
    const count = $('provider-count');
    if (count) {
      const base = `${realRows.length} 个连接`;
      count.textContent = mockCount ? `${base} · 另有 ${mockCount} 个 mock 条目` : base;
    }
  }

  // ----- Real provider detail patch (anthropic / openai) -----

  function oauthSectionMarkup(channelKey) {
    const channel = CHANNELS[channelKey];
    const channelState = state.channels[channel.stateKey];
    if (channelKey === 'anthropic') {
      return channelState.logged ? `
        <div data-oauth-mock-section>
          <p class="management-note"><strong>官方渠道订阅 · Claude Pro/Max 已登录</strong><br />${escapeHtml(channelState.account)} · access token 有效期至 ${escapeHtml(channelState.expiresAt)}。auth.json 存储凭证优先于上方的 API key 配置；退出登录后自动回退。</p>
          <div class="button-row"><button id="oauth-mock-detail-logout" class="ghost-button danger" type="button">退出订阅登录</button></div>
        </div>` : `
        <div data-oauth-mock-section>
          <p class="management-note"><strong>官方渠道订阅</strong><br />Claude Pro / Max 订阅可通过浏览器 OAuth 登录；凭证写入 auth.json 后即优先于 API key，本页配置无需改动。</p>
          <div class="button-row"><button id="oauth-mock-detail-login" type="button">使用 Claude 订阅登录</button></div>
        </div>`;
    }
    return `
      <div data-oauth-mock-section>
        <p class="management-note"><strong>官方渠道订阅</strong><br />ChatGPT Plus/Pro 的 Codex 订阅是独立 provider（openai-codex），目录导入覆盖不到；请使用顶部的「官方渠道登录」。</p>
      </div>`;
  }

  function bindOauthSection(root, channelKey) {
    const login = root.querySelector('#oauth-mock-detail-login');
    if (login) login.addEventListener('click', () => openLoginFlow(CHANNELS[channelKey]));
    const logout = root.querySelector('#oauth-mock-detail-logout');
    if (logout) logout.addEventListener('click', () => logoutChannel(CHANNELS[channelKey]));
  }

  function handleRealDetailRendered() {
    const idInput = /** @type {HTMLInputElement} */ (document.getElementById('provider-id'));
    if (!idInput) return;
    const providerId = idInput.value.trim();
    const detail = $('provider-detail');
    if (!detail) return;
    detail.querySelectorAll('[data-oauth-mock-section]').forEach((node) => node.remove());
    const anchor = providerId === 'anthropic' ? 'anthropic' : providerId === 'openai' ? 'codex-hint' : '';
    if (!anchor) return;
    const card = detail.querySelector('#provider-api-key') && detail.querySelector('#provider-api-key').closest('section.management-card');
    if (!card) return;
    const holder = document.createElement('div');
    holder.innerHTML = oauthSectionMarkup(anchor === 'anthropic' ? 'anthropic' : 'codex');
    const section = holder.firstElementChild;
    const clearButton = card.querySelector('#clear-provider-secret');
    if (clearButton) card.insertBefore(section, clearButton);
    else card.appendChild(section);
    bindOauthSection(section, anchor === 'anthropic' ? 'anthropic' : 'codex');
  }

  // ----- Mock provider detail (demo / codex rows) -----

  function readonlyField(label, value) {
    return `<label><span>${escapeHtml(label)}</span><input value="${escapeHtml(value)}" readonly /></label>`;
  }

  function renderMockDetail(providerId) {
    const detail = $('provider-detail');
    if (!detail) return;
    channelViewActive = false;
    mockDetailId = providerId;
    const provider = providerId === 'openai-codex'
      ? CODEX_PROVIDER
      : DEMO_PROVIDERS.find((entry) => entry.id === providerId);
    if (!provider) { mockDetailId = ''; return; }
    const channelState = state.channels[providerId];
    const oauthActive = Boolean(channelState && channelState.logged);
    const isCodex = providerId === 'openai-codex';
    const isAnthropic = providerId === 'anthropic';
    const badge = isCodex
      ? (oauthActive ? '<span class="status-badge">OAuth · external</span>' : '<span class="status-badge warning">OAuth 凭证已移除</span>')
      : isAnthropic && oauthActive
        ? '<span class="status-badge">OAuth external · 优先于 API key</span>'
        : '<span class="status-badge neutral">API key · literal</span>';
    detail.innerHTML = `
      <div class="management-detail-top">
        <div><p class="eyebrow">Model Provider <span class="oauth-mock-tag">mock 演示详情</span></p><h2>${escapeHtml(provider.name)}</h2><p>${provider.modelCount} 个模型条目 · ${escapeHtml(provider.sourceLabel)}</p></div>
        ${badge}
      </div>
      <section class="management-card">
        <div class="management-card-title"><div><h3>连接设置</h3><p>Provider 是 catalog 上游，不直接改写角色。</p></div></div>
        <div class="field-grid">
          ${readonlyField('Provider ID', provider.id)}
          ${readonlyField('显示名称', provider.name)}
          ${readonlyField('Base URL', provider.baseUrl)}
          ${readonlyField('API 协议', provider.api)}
          ${readonlyField('Authorization Header', '由协议处理')}
          ${readonlyField('models.json 认证模式', isCodex ? 'external（auth.json）' : 'literal')}
        </div>
      </section>
      <section class="management-card">
        <div class="management-card-title"><div><h3>API Key / 鉴权</h3><p>auth.json 存储凭证优先；API key 仅在无存储凭证时兜底。</p></div></div>
        ${isAnthropic ? (oauthActive ? `
          <div class="field-grid">
            ${readonlyField('订阅账号', channelState.account)}
            ${readonlyField('凭证格式', 'oauth · refresh + access（auth.json）')}
            ${readonlyField('access token 有效期至', channelState.expiresAt)}
          </div>
          <p class="management-note">当前请求实际使用订阅鉴权；API key 配置处于闲置状态，退出订阅登录后自动回退。</p>
          <div class="button-row"><button id="oauth-mock-detail-logout" class="ghost-button danger" type="button">退出订阅登录</button></div>
        ` : `
          <p class="management-note">当前仅 API key 鉴权（literal）。</p>
          <div class="button-row"><button id="oauth-mock-detail-login" type="button">使用 Claude 订阅登录</button></div>
        `) : isCodex ? (oauthActive ? `
          <div class="field-grid">
            ${readonlyField('订阅账号', channelState.account)}
            ${readonlyField('凭证格式', 'oauth · refresh + access（auth.json）')}
            ${readonlyField('access token 有效期至', channelState.expiresAt)}
          </div>
          <p class="management-note">凭证在 auth.json；本 provider 由官方渠道登录注册进 models.json，目录导入永远覆盖不到。</p>
          <div class="button-row"><button id="oauth-mock-detail-logout" class="ghost-button danger" type="button">退出订阅登录</button></div>
        ` : `
          <p class="management-note warning">OAuth 凭证已移除：请重新执行官方渠道登录以恢复订阅鉴权。</p>
          <div class="button-row"><button id="oauth-mock-detail-login" type="button">重新登录 ChatGPT Codex</button></div>
        `) : `
          <p class="management-note">仅 API key 鉴权。ChatGPT 订阅（Codex）是独立 provider（openai-codex），请使用顶部的「官方渠道登录」。</p>
        `}
      </section>
      <section class="management-card">
        <div class="management-card-title"><div><h3>模型目录</h3><p>显式 family 决定系统模型族角色的可见模型。</p></div></div>
        <div class="provider-model-editor">${provider.models.map((model) => `
          <div class="provider-model-row">
            ${readonlyField('模型 ID', model)}
            ${readonlyField('显示名称', model)}
            <p class="provider-model-limit-copy">上下文 200000（显式） · 输出 32000（显式）</p>
          </div>`).join('')}
        </div>
        <p class="management-note">mock 演示详情：仅展示前几个模型，真实数据以接口为准。</p>
      </section>
      <div class="management-actions"><button id="oauth-mock-validate" class="ghost-button" type="button">验证当前已保存连接</button></div>`;
    const login = detail.querySelector('#oauth-mock-detail-login');
    if (login) login.addEventListener('click', () => openLoginFlow(isCodex ? CHANNELS.codex : CHANNELS.anthropic));
    const logout = detail.querySelector('#oauth-mock-detail-logout');
    if (logout) logout.addEventListener('click', () => logoutChannel(isCodex ? CHANNELS.codex : CHANNELS.anthropic));
    detail.querySelector('#oauth-mock-validate').addEventListener('click', () => showToast('mock：演示环境不发起真实验证'));
  }

  // ----- Channel view (detail pane, mirrors catalog-import layout) -----

  function channelRowMarkup(channel) {
    const channelState = state.channels[channel.stateKey];
    return `
      <div class="oauth-mock-channel-row">
        <span class="provider-mark">${channel.stateKey === 'anthropic' ? 'CL' : 'CD'}</span>
        <span class="oauth-mock-channel-copy">
          <strong>${escapeHtml(channel.label)}<span class="oauth-mock-tag">${escapeHtml(channel.vendor)}</span></strong>
          <small>${channelState.logged ? `已连接 · ${escapeHtml(channelState.account)}` : escapeHtml(channel.desc)}</small>
        </span>
        <span class="oauth-mock-channel-actions">
          ${channelState.logged
            ? `<button data-oauth-channel-logout="${channel.key}" class="ghost-button danger" type="button">退出登录</button>`
            : `<button data-oauth-channel-login="${channel.key}" type="button">使用浏览器登录</button>`}
          ${channel.key === 'codex' && state.codexRegistered ? `<button data-oauth-channel-view="openai-codex" class="ghost-button" type="button">查看供应商</button>` : ''}
        </span>
      </div>`;
  }

  function renderChannelView() {
    const detail = $('provider-detail');
    if (!detail) return;
    mockDetailId = '';
    channelViewActive = true;
    const logged = Object.values(CHANNELS).filter((channel) => state.channels[channel.stateKey].logged).length;
    detail.innerHTML = `
      <div class="management-detail-top">
        <div><p class="eyebrow">Official Channel Login <span class="oauth-mock-tag">mock</span></p><h2>官方渠道登录</h2><p>订阅 OAuth 渠道 · PKCE 浏览器授权 · 凭证写入共享 agentDir 的 auth.json。</p></div>
        <button id="oauth-channel-back" class="ghost-button" type="button">返回供应商</button>
      </div>
      <section class="management-card">
        <div class="management-card-title"><div><h3>订阅渠道</h3><p>${logged} / 2 已登录 · token 刷新由 pi 运行时自动完成，CAFF 不自建刷新逻辑。</p></div></div>
        ${channelRowMarkup(CHANNELS.anthropic)}
        ${channelRowMarkup(CHANNELS.codex)}
      </section>
      <section class="management-card">
        <div class="management-card-title"><div><h3>与「从目录导入」的关系</h3><p>两条入口互补，不是一条链路。</p></div></div>
        <p class="management-note">目录导入只产生 API key 形态的配置。anthropic 导入条目无需改动即可被订阅凭证驱动；openai-codex 不在 models.dev 目录中，只能通过官方渠道登录注册。</p>
      </section>
      <div class="management-actions"><button id="oauth-mock-reset" class="ghost-button danger" type="button">重置演示状态</button></div>`;
    detail.querySelector('#oauth-channel-back').addEventListener('click', backToProviders);
    detail.querySelectorAll('[data-oauth-channel-login]').forEach((button) => {
      button.addEventListener('click', () => openLoginFlow(CHANNELS[button.dataset.oauthChannelLogin]));
    });
    detail.querySelectorAll('[data-oauth-channel-logout]').forEach((button) => {
      button.addEventListener('click', () => logoutChannel(CHANNELS[button.dataset.oauthChannelLogout]));
    });
    detail.querySelectorAll('[data-oauth-channel-view]').forEach((button) => {
      button.addEventListener('click', () => renderMockDetail(button.dataset.oauthChannelView));
    });
    detail.querySelector('#oauth-mock-reset').addEventListener('click', resetDemo);
  }

  function backToProviders() {
    channelViewActive = false;
    mockDetailId = '';
    const refresh = /** @type {HTMLButtonElement} */ ($('refresh-providers'));
    if (refresh && !refresh.disabled) { refresh.click(); return; }
    const detail = $('provider-detail');
    if (detail) detail.innerHTML = '<div class="empty-state">选择一个供应商查看详情。</div>';
  }

  // ----- Login flow dialog (same pattern as v1 prototype) -----

  function flowSteps(channel) {
    const steps = [
      { key: 'pkce', label: '生成 PKCE（code_verifier / code_challenge）' },
      { key: 'browser', label: '打开系统默认浏览器授权页' },
      { key: 'callback', label: '本地回调接收授权码（localhost）' },
      { key: 'exchange', label: '交换 access / refresh token' },
      { key: 'persist', label: '写入共享 agentDir 的 auth.json' },
    ];
    if (channel.extraStep) steps.push({ key: 'register', label: channel.extraStep });
    return steps;
  }

  function ensureFlowDialog() {
    let backdrop = $('oauth-mock-flow-backdrop');
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.id = 'oauth-mock-flow-backdrop';
    backdrop.className = 'new-conversation-backdrop hidden';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    const dialog = document.createElement('div');
    dialog.className = 'new-conversation-dialog';
    dialog.id = 'oauth-mock-flow-dialog';
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeFlowDialog();
    });
    return backdrop;
  }

  function closeFlowDialog() {
    const backdrop = $('oauth-mock-flow-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
  }

  function openLoginFlow(channel) {
    const backdrop = ensureFlowDialog();
    const dialog = $('oauth-mock-flow-dialog');
    const steps = flowSteps(channel);
    dialog.innerHTML = `
      <div class="new-conversation-header">
        <div><h2 id="oauth-flow-title">登录 ${escapeHtml(channel.label)}</h2><p>授权流为模拟演示；正式实现复用 pi 的 OAuth 流程。</p></div>
        <button id="oauth-flow-close" class="ghost-button" type="button">关闭</button>
      </div>
      <div style="padding:20px 22px;overflow:auto;display:grid;gap:16px">
        <ol id="oauth-flow-steps" style="margin:0;padding-left:1.2rem;display:grid;gap:0.45rem">
          ${steps.map((step, index) => `<li data-step="${step.key}" style="opacity:0.55">${index + 1}. ${escapeHtml(step.label)}</li>`).join('')}
        </ol>
        <div id="oauth-browser-frame" style="border:1px solid var(--caff-border);border-radius:var(--radius-sm);overflow:hidden">
          <div style="padding:0.5rem 0.8rem;border-bottom:1px solid var(--caff-border);background:var(--caff-surface-sunk);font-size:0.75rem;word-break:break-all">🔒 <span id="oauth-browser-url">${escapeHtml(channel.authorizeUrl)}</span></div>
          <div style="padding:1.1rem;display:grid;gap:0.7rem">
            <strong>模拟授权页 · ${escapeHtml(channel.label)}</strong>
            <p style="margin:0;font-size:0.85rem">CAFF（pi 驱动）请求访问你的订阅账号。<br />授权范围：${channel.scopes.map(escapeHtml).join(' · ')}</p>
            <div class="button-row">
              <button id="oauth-consent" type="button">同意授权</button>
              <button id="oauth-cancel" class="ghost-button" type="button">取消</button>
            </div>
          </div>
        </div>
        <div id="oauth-flow-result" class="hidden" style="display:grid;gap:0.6rem">
          <pre style="margin:0;padding:0.8rem;border-radius:var(--radius-sm);background:var(--caff-surface-sunk);font-size:0.72rem;overflow:auto"></pre>
          <p class="management-note" style="margin:0"></p>
        </div>
      </div>`;
    backdrop.classList.remove('hidden');
    $('oauth-flow-close').addEventListener('click', closeFlowDialog);

    const stepItems = () => Array.from(dialog.querySelectorAll('[data-step]'));
    const setStep = (key, mark) => {
      const item = dialog.querySelector(`[data-step="${key}"]`);
      if (!item) return;
      item.style.opacity = '1';
      item.textContent = item.textContent.replace(/^(⏳|✓|✗)\s*/, '');
      if (mark === 'active') item.textContent = '⏳ ' + item.textContent;
      if (mark === 'done') item.textContent = '✓ ' + item.textContent;
      if (mark === 'error') item.textContent = '✗ ' + item.textContent;
    };

    $('oauth-cancel').addEventListener('click', () => {
      setStep('browser', 'error');
      const result = $('oauth-flow-result');
      result.classList.remove('hidden');
      result.querySelector('pre').textContent = '已取消：未写入任何凭证，auth.json 保持原状。';
      $('oauth-browser-frame').style.opacity = '0.5';
    });

    $('oauth-consent').addEventListener('click', async () => {
      $('oauth-consent').disabled = true;
      $('oauth-cancel').disabled = true;
      $('oauth-browser-frame').style.opacity = '0.55';
      const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, window.CAFF_OAUTH_MOCK_FAST ? 5 : ms));
      for (const step of steps) {
        setStep(step.key, 'active');
        await wait(stepWait());
        setStep(step.key, 'done');
      }
      const expiresAt = new Date(Date.now() + 3600_000).toLocaleTimeString('zh-CN');
      state.channels[channel.stateKey] = { logged: true, account: channel.account, expiresAt };
      if (channel.key === 'codex') state.codexRegistered = true;
      saveState();
      const result = $('oauth-flow-result');
      result.classList.remove('hidden');
      result.querySelector('pre').textContent = `auth.json → "${channel.stateKey}": { "type": "oauth", "refresh": "eyJhbGci…", "access": "eyJhbGci…", "expires": … }`;
      result.querySelector('.management-note').textContent = channel.key === 'codex'
        ? '凭证已写入，openai-codex provider 已注册进 models.json。目录导入永远不覆盖此渠道。'
        : '凭证已写入。目录导入的 anthropic 供应商即刻起由订阅凭证驱动。';
      refreshAfterChannelChange(channel);
      showToast(`${channel.label} 登录成功`);
    });
  }

  function logoutChannel(channel) {
    state.channels[channel.stateKey] = { logged: false, account: '', expiresAt: '' };
    saveState();
    refreshAfterChannelChange(channel);
    showToast(`${channel.label} 已退出登录${channel.key === 'codex' ? '；openai-codex 供应商条目保留，等待重新登录' : '；anthropic 回退到 API key（如已配置）'}`);
  }

  function refreshAfterChannelChange(channel) {
    overlayList();
    if (channelViewActive) renderChannelView();
    else if (mockDetailId === channel.stateKey || (channel.key === 'codex' && mockDetailId === 'openai-codex')) renderMockDetail(mockDetailId);
    else handleRealDetailRendered();
  }

  function resetDemo() {
    state = defaultState();
    saveState();
    overlayList();
    if (channelViewActive) renderChannelView();
    else if (mockDetailId) renderMockDetail(mockDetailId);
    else handleRealDetailRendered();
    showToast('演示状态已重置');
  }

  // ----- Wiring -----

  function isOwnMockNode(node) {
    return node.nodeType === 1 && Boolean(node.hasAttribute && node.hasAttribute('data-oauth-mock-row'));
  }

  function init() {
    injectStyles();
    const button = $('official-channel-login');
    if (button) button.addEventListener('click', renderChannelView);

    const list = $('provider-list');
    if (list) {
      new MutationObserver((mutations) => {
        // Ignore mutations caused by overlayList itself (its own mock rows) to avoid a feedback loop.
        const foreign = mutations.some((mutation) =>
          Array.from(mutation.addedNodes).some((node) => !isOwnMockNode(node))
          || Array.from(mutation.removedNodes).some((node) => !isOwnMockNode(node)));
        if (foreign) overlayList();
      }).observe(list, { childList: true });
    }
    const detail = $('provider-detail');
    if (detail) {
      new MutationObserver(() => {
        // A real provider-editor render always contains #provider-id; it replaces any mock view.
        if (document.getElementById('provider-id')) {
          mockDetailId = '';
          channelViewActive = false;
          handleRealDetailRendered();
        }
      }).observe(detail, { childList: true, subtree: false });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeFlowDialog();
    });

    overlayList();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
