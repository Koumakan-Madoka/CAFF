// @ts-check
// OAuth official-channel login interaction mock.
// Self-contained prototype: no backend calls, no persistent state.

(function registerOauthLoginMock() {
  const shared = window.CaffShared || (window.CaffShared = {});
  const toast = shared.createToastController(document.getElementById('toast'));

  const CHANNELS = {
    anthropic: {
      id: 'anthropic',
      label: 'Claude Pro / Max',
      providerId: 'anthropic',
      authorizeUrl: 'https://claude.ai/oauth/authorize?client_id=...&code_challenge=...',
      scopes: ['oauth:read:user', 'chat:read', 'chat:write'],
      codexOnlyStep: false,
      note: '登录后凭证写入 auth.json 的 anthropic 条目。目录导入或手动配置的 anthropic 供应商无需任何改动，即可被订阅凭证驱动（存储凭证优先于 API key）。',
    },
    'openai-codex': {
      id: 'openai-codex',
      label: 'ChatGPT（Codex 订阅）',
      providerId: 'openai-codex',
      authorizeUrl: 'https://auth.openai.com/oauth/authorize?client_id=...&code_challenge=...',
      scopes: ['chatgpt.account.read', 'codex'],
      codexOnlyStep: true,
      note: 'models.dev 目录不含 openai-codex：订阅渠道无法通过目录导入获得，登录成功后会自动把 openai-codex provider（含 Codex 模型清单）注册进 models.json。',
    },
  };

  const CATALOG_ENTRIES = [
    { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
    { id: 'openai', name: 'OpenAI（API）', env: 'OPENAI_API_KEY' },
    { id: 'google', name: 'Google AI Studio', env: 'GOOGLE_API_KEY' },
    { id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
    { id: 'zai', name: '智谱 AI', env: 'ZAI_API_KEY' },
    { id: 'moonshot-for-coding', name: 'Moonshot', env: 'MOONSHOT_API_KEY' },
  ];

  const CODEX_MODELS = ['gpt-5.2-codex', 'gpt-5.2-codex-high', 'gpt-5.1-codex'];

  let channels;
  let providers;
  let selection;

  function resetState() {
    channels = {
      anthropic: { logged: false, account: null, tokenPreview: null, expiresAt: null },
      'openai-codex': { logged: false, account: null, tokenPreview: null, expiresAt: null },
    };
    providers = [
      { id: 'anthropic', name: 'Anthropic', source: 'catalog', authMode: 'literal', modelCount: 9 },
      { id: 'openai', name: 'OpenAI（API）', source: 'catalog', authMode: 'literal', modelCount: 12 },
      { id: 'moonshot-relay', name: '自定义中转', source: 'manual', authMode: 'env', modelCount: 3 },
    ];
    selection = { kind: 'channel', id: 'anthropic' };
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/gu, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[char]);
  }

  function $(id) { return document.getElementById(id); }

  function channelBadge(channel) {
    return channel.logged
      ? '<span class="status-badge">OAuth · 已登录</span>'
      : '<span class="status-badge warning">未登录</span>';
  }

  function providerBadge(provider) {
    const channel = channels[provider.id];
    if (provider.source === 'oauth-login') {
      return channel && channel.logged
        ? '<span class="status-badge">OAuth · external</span>'
        : '<span class="status-badge warning">OAuth 凭证已移除</span>';
    }
    if (channel && channel.logged) {
      return '<span class="status-badge">OAuth external · 优先于 API key</span>';
    }
    return `<span class="status-badge neutral">API key · ${escapeHtml(provider.authMode)}</span>`;
  }

  function makeListRow(list, { key, active, mark, title, meta, badge, onSelect }) {
    const li = document.createElement('li');
    li.className = 'management-list-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-list-item management-list-row' + (active ? ' active' : '');
    if (active) button.setAttribute('aria-current', 'true');
    button.innerHTML = `
      <span class="provider-mark">${escapeHtml(mark)}</span>
      <span class="management-list-copy"><strong>${escapeHtml(title)}</strong><small>${meta}</small></span>
      ${badge || ''}`;
    button.addEventListener('click', onSelect);
    li.appendChild(button);
    list.appendChild(li);
  }

  function renderChannelList() {
    const list = $('oauth-channel-list');
    list.innerHTML = '';
    for (const channel of Object.values(CHANNELS)) {
      const state = channels[channel.id];
      makeListRow(list, {
        key: channel.id,
        active: selection.kind === 'channel' && selection.id === channel.id,
        mark: channel.id === 'anthropic' ? 'CL' : 'CD',
        title: channel.label,
        meta: state.logged ? `已连接 · ${state.account}` : '订阅 OAuth 渠道',
        badge: channelBadge(state),
        onSelect: () => { selection = { kind: 'channel', id: channel.id }; render(); },
      });
    }
    const logged = Object.values(channels).filter((entry) => entry.logged).length;
    $('channel-count').textContent = `${logged} / 2 已登录`;
  }

  function renderProviderList() {
    const list = $('provider-list');
    list.innerHTML = '';
    if (!providers.length) {
      list.appendChild(shared.createManagementListEmptyState('暂无供应商'));
    }
    for (const provider of providers) {
      const sourceLabel = provider.source === 'oauth-login' ? '官方渠道登录注册'
        : provider.source === 'catalog' ? '目录导入' : '手动添加';
      makeListRow(list, {
        key: provider.id,
        active: selection.kind === 'provider' && selection.id === provider.id,
        mark: provider.id.slice(0, 2).toUpperCase(),
        title: provider.name,
        meta: `${provider.id} · ${sourceLabel} · ${provider.modelCount} 个模型`,
        badge: providerBadge(provider),
        onSelect: () => { selection = { kind: 'provider', id: provider.id }; render(); },
      });
    }
    $('provider-count').textContent = `${providers.length} 个连接`;
  }

  function renderChannelDetail(channel) {
    const state = channels[channel.id];
    const root = $('provider-detail');
    root.innerHTML = `
      <div class="management-detail-top">
        <div><p class="eyebrow">Official Channel</p><h2>${escapeHtml(channel.label)}</h2><p>${state.logged ? `已连接 · ${escapeHtml(state.account)}` : '通过浏览器 OAuth 授权连接订阅账号。'}</p></div>
        ${channelBadge(state)}
      </div>
      <section class="management-card">
        <div class="management-card-title"><div><h3>订阅 OAuth 登录</h3><p>PKCE 授权流 · 凭证写入共享 agentDir 的 auth.json，由 pi 运行时按需自动刷新。</p></div></div>
        ${state.logged ? `
          <div class="field-grid">
            <label><span>账号</span><input value="${escapeHtml(state.account)}" readonly /></label>
            <label><span>凭证格式</span><input value="oauth · refresh + access（auth.json）" readonly /></label>
            <label><span>access token 有效期至</span><input value="${escapeHtml(state.expiresAt)}" readonly /></label>
          </div>
          <button id="channel-logout" class="ghost-button danger" type="button">退出登录</button>
          <div id="channel-logout-confirmation" class="danger-confirmation hidden" role="alert">
            <p><strong>确认退出登录？</strong><br />将删除 auth.json 中该 provider 的 OAuth 凭证。${channel.codexOnlyStep ? '已注册的 openai-codex 供应商条目保留，但会变为未认证。' : 'anthropic 供应商将回退到 API key（如已配置）。'}</p>
            <div><button id="cancel-channel-logout" class="ghost-button" type="button">取消</button><button id="confirm-channel-logout" class="ghost-button danger" type="button">确认退出</button></div>
          </div>
        ` : `
          <p class="management-note">${escapeHtml(channel.note)}</p>
          <button id="channel-login" type="button">使用浏览器登录</button>
        `}
      </section>
      <p class="management-note"><strong>刷新与安全边界</strong><br />CAFF 只发起登录并写入 auth.json；token 刷新在 pi 解析鉴权时自动完成（双检锁）。凭证不经过 CAFF 数据库，读取接口只返回状态与模式。</p>
    `;

    const loginButton = $('channel-login');
    if (loginButton) loginButton.addEventListener('click', () => openLoginFlow(channel));
    const logoutButton = $('channel-logout');
    if (logoutButton) {
      logoutButton.addEventListener('click', () => $('channel-logout-confirmation').classList.remove('hidden'));
      $('cancel-channel-logout').addEventListener('click', () => $('channel-logout-confirmation').classList.add('hidden'));
      $('confirm-channel-logout').addEventListener('click', () => {
        channels[channel.id] = { logged: false, account: null, tokenPreview: null, expiresAt: null };
        closeDialogs();
        render();
        toast.show(`${channel.label} 已退出登录`);
      });
    }
  }

  function renderProviderDetail(provider) {
    const channel = channels[provider.id];
    const oauthActive = Boolean(channel && channel.logged);
    const root = $('provider-detail');
    const sourceLabel = provider.source === 'oauth-login' ? '官方渠道登录注册' : provider.source === 'catalog' ? '目录导入' : '手动添加';
    root.innerHTML = `
      <div class="management-detail-top">
        <div><p class="eyebrow">Model Provider</p><h2>${escapeHtml(provider.name)}</h2><p>${provider.modelCount} 个模型条目 · ${sourceLabel}</p></div>
        ${providerBadge(provider)}
      </div>
      <section class="management-card">
        <div class="management-card-title"><div><h3>鉴权状态</h3><p>auth.json 存储凭证优先；环境变量与 models.json API key 仅在无存储凭证时兜底。</p></div></div>
        ${provider.source === 'oauth-login' ? `
          <div class="field-grid">
            <label><span>Provider ID</span><input value="${escapeHtml(provider.id)}" readonly /></label>
            <label><span>模型清单</span><input value="${escapeHtml(CODEX_MODELS.join(', '))}" readonly /></label>
          </div>
          ${oauthActive
            ? '<p class="management-note">OAuth 凭证有效。登录流程已把该 provider 写入 models.json；凭证本体在 auth.json。</p>'
            : '<p class="management-note warning">OAuth 凭证已移除：请重新执行官方渠道登录以恢复订阅鉴权。</p>'}
        ` : `
          <div class="field-grid">
            <label><span>Provider ID</span><input value="${escapeHtml(provider.id)}" readonly /></label>
            <label><span>API key 模式</span><input value="${escapeHtml(provider.authMode)}" readonly /></label>
          </div>
          ${oauthActive
            ? `<p class="management-note">检测到 auth.json 中该 provider 的 OAuth 凭证（external）：当前请求实际使用订阅鉴权，上面的 API key 处于闲置状态；退出 OAuth 登录后自动回退。</p>`
            : '<p class="management-note">仅 API key 鉴权。</p>'}
        `}
      </section>
      ${provider.id === 'anthropic' ? '<p class="management-note">目录导入与 OAuth 的关系：目录导入只写 API key 配置；Claude 订阅凭证存在后自动生效，无需重新导入。</p>' : ''}
      ${provider.id === 'openai' ? '<p class="management-note">目录导入的 openai 是 API 渠道。ChatGPT 订阅（Codex）是独立 provider（openai-codex），目录里没有它，只能通过官方渠道登录注册。</p>' : ''}
    `;
  }

  function render() {
    renderChannelList();
    renderProviderList();
    if (selection.kind === 'channel') renderChannelDetail(CHANNELS[selection.id]);
    else {
      const provider = providers.find((entry) => entry.id === selection.id);
      if (provider) renderProviderDetail(provider);
      else { selection = { kind: 'channel', id: 'anthropic' }; renderChannelDetail(CHANNELS.anthropic); }
    }
  }

  function closeDialogs() {
    $('oauth-flow-backdrop').classList.add('hidden');
    $('catalog-import-backdrop').classList.add('hidden');
  }

  // ----- Simulated OAuth flow -----

  function flowSteps(channel) {
    const steps = [
      { key: 'pkce', label: '生成 PKCE（code_verifier / code_challenge）' },
      { key: 'browser', label: '打开系统默认浏览器授权页' },
      { key: 'callback', label: '本地回调接收授权码（localhost）' },
      { key: 'exchange', label: '交换 access / refresh token' },
      { key: 'persist', label: '写入共享 agentDir 的 auth.json' },
    ];
    if (channel.codexOnlyStep) {
      steps.push({ key: 'register', label: '注册 openai-codex provider 到 models.json（含 Codex 模型清单）' });
    }
    return steps;
  }

  function openLoginFlow(channel) {
    const steps = flowSteps(channel);
    const dialog = $('oauth-flow-dialog');
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
      </div>
    `;
    $('oauth-flow-backdrop').classList.remove('hidden');

    $('oauth-flow-close').addEventListener('click', closeDialogs);
    $('oauth-flow-backdrop').addEventListener('click', (event) => {
      if (event.target === $('oauth-flow-backdrop')) closeDialogs();
    });

    const stepItems = () => Array.from(dialog.querySelectorAll('[data-step]'));
    const setStep = (key, state) => {
      const item = dialog.querySelector(`[data-step="${key}"]`);
      if (!item) return;
      item.style.opacity = '1';
      item.textContent = item.textContent.replace(/(进行中|✓|✗)\s*/, '');
      if (state === 'active') item.textContent = '⏳ ' + item.textContent;
      if (state === 'done') item.textContent = '✓ ' + item.textContent;
      if (state === 'error') item.textContent = '✗ ' + item.textContent;
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
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (const step of steps) {
        setStep(step.key, 'active');
        await wait(600);
        setStep(step.key, 'done');
      }
      const account = channel.id === 'anthropic' ? 'claude-pro@example.com' : 'chatgpt-pro@example.com';
      const expiresAt = new Date(Date.now() + 3600_000).toLocaleTimeString('zh-CN');
      channels[channel.id] = {
        logged: true,
        account,
        tokenPreview: JSON.stringify({ type: 'oauth', refresh: 'eyJhbGci…', access: 'eyJhbGci…', expires: Date.now() + 3600_000 }, null, 2),
        expiresAt,
      };
      if (channel.codexOnlyStep && !providers.some((entry) => entry.id === 'openai-codex')) {
        providers.push({ id: 'openai-codex', name: 'OpenAI Codex（订阅）', source: 'oauth-login', authMode: 'external', modelCount: CODEX_MODELS.length });
        selection = { kind: 'provider', id: 'openai-codex' };
      }
      const result = $('oauth-flow-result');
      result.classList.remove('hidden');
      result.querySelector('pre').textContent = `auth.json → "${channel.providerId}": ${channels[channel.id].tokenPreview}`;
      result.querySelector('.management-note').textContent = channel.codexOnlyStep
        ? '凭证已写入，openai-codex provider 已注册。目录导入永远不覆盖此渠道。'
        : '凭证已写入。目录导入的 anthropic 供应商即刻起由订阅凭证驱动。';
      render();
      toast.show(`${channel.label} 登录成功`);
    });
  }

  // ----- Simulated catalog import -----

  function openCatalogImport() {
    const dialog = $('catalog-import-dialog');
    const existing = new Set(providers.map((entry) => entry.id));
    dialog.innerHTML = `
      <div class="new-conversation-header">
        <div><h2 id="catalog-import-title">从目录导入（模拟）</h2><p>来源：models.dev · 只提供 API key 渠道配置。</p></div>
        <button id="catalog-import-close" class="ghost-button" type="button">关闭</button>
      </div>
      <div style="padding:20px 22px;overflow:auto;display:grid;gap:16px">
        <div class="management-warning"><strong>为什么没有 Codex？</strong><p>models.dev 目录不收录 openai-codex 订阅渠道；订阅 OAuth 只能通过「官方渠道登录」注册。Claude（anthropic）目录导入与 OAuth 可共存：存储凭证优先。</p></div>
        <ul style="margin:0;padding:0;list-style:none;display:grid;gap:0.5rem">
          ${CATALOG_ENTRIES.map((entry) => `
            <li><label style="display:flex;align-items:center;gap:0.6rem;padding:0.55rem 0.7rem;border:1px solid var(--caff-border);border-radius:var(--radius-sm)">
              <input type="checkbox" value="${entry.id}" ${existing.has(entry.id) ? 'checked disabled' : ''} />
              <span><strong>${escapeHtml(entry.name)}</strong> <small style="opacity:0.7">${entry.id} · ${escapeHtml(entry.env)}</small></span>
            </label></li>`).join('')}
        </ul>
        <div class="button-row"><button id="catalog-import-confirm" type="button">导入所选</button></div>
      </div>
    `;
    $('catalog-import-backdrop').classList.remove('hidden');
    $('catalog-import-close').addEventListener('click', closeDialogs);
    $('catalog-import-backdrop').addEventListener('click', (event) => {
      if (event.target === $('catalog-import-backdrop')) closeDialogs();
    });
    $('catalog-import-confirm').addEventListener('click', () => {
      const checked = Array.from(dialog.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
      let added = 0;
      for (const id of checked) {
        if (providers.some((entry) => entry.id === id)) continue;
        const entry = CATALOG_ENTRIES.find((item) => item.id === id);
        providers.push({ id, name: entry.name, source: 'catalog', authMode: 'literal', modelCount: 6 });
        added += 1;
      }
      closeDialogs();
      render();
      toast.show(added ? `目录导入完成 · 新增 ${added} 个供应商（API key 渠道）` : '没有新增供应商');
    });
  }

  $('import-from-catalog').addEventListener('click', openCatalogImport);
  $('mock-reset').addEventListener('click', () => {
    resetState();
    closeDialogs();
    render();
    toast.show('演示状态已重置');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDialogs();
  });

  resetState();
  render();
})();
