// @ts-check
// CAFF 工作台 AppShell 控制器：固定视口 + 会话侧栏 + 统一上下文抽屉。
// 交互契约锚定 designs/mock-app-shell-a.html (v4 冻结, SHA256 25447836…F3356F)。

(function registerAppShell() {
  const body = document.body;
  if (!body || !body.classList.contains('chat-app')) {
    return;
  }

  const appShell = document.getElementById('appShell');
  const rail = /** @type {HTMLElement | null} */ (document.querySelector('.rail'));
  const main = /** @type {HTMLElement | null} */ (document.querySelector('.main'));
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarClose = document.getElementById('sidebarClose');
  const drawer = document.getElementById('contextDrawer');
  const drawerToggle = document.getElementById('drawerToggle');
  const drawerClose = document.getElementById('drawerClose');
  const drawerOverlay = document.getElementById('drawerOverlay');
  const list = document.getElementById('message-list');

  if (!appShell || !sidebar || !sidebarToggle || !drawer || !drawerToggle || !list) {
    return;
  }

  const mqDesktop = window.matchMedia('(min-width: 1280px)');
  const mqReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ── Tab registry ─────────────────────────────────────────────
  const tabs = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('.drawer-tabs [role="tab"]')));
  const tabByPanelId = new Map();
  tabs.forEach((tab) => {
    const panelId = tab.getAttribute('aria-controls');
    if (panelId) {
      tabByPanelId.set(panelId, tab);
    }
  });
  let currentTab = tabs.length ? tabs[0] : null;

  const subscribers = new Set();

  function notify() {
    const payload = {
      open: body.dataset.drawer === 'open',
      tab: currentTab ? currentTab.getAttribute('aria-controls') : '',
    };
    subscribers.forEach((cb) => {
      try {
        cb(payload);
      } catch (error) {
        console.error('[app-shell] subscriber error', error);
      }
    });
  }

  function visibleTabs() {
    return tabs.filter((tab) => !tab.hidden);
  }

  function activateTab(tab, { focus = true, notifyModules = true } = {}) {
    if (!tab || tab.hidden) {
      return;
    }
    currentTab = tab;
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      const panelId = t.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        panel.hidden = !on;
      }
    });
    if (focus) {
      tab.focus();
    }
    if (notifyModules) {
      notify();
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (body.dataset.drawer !== 'open') {
        setDrawer(true, { tab });
      } else {
        activateTab(tab, { focus: false });
      }
    });
  });

  const tabList = /** @type {HTMLElement | null} */ (document.querySelector('.drawer-tabs'));
  if (tabList) {
    tabList.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      const available = visibleTabs();
      const i = available.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (i < 0) {
        return;
      }
      let j = null;
      if (event.key === 'ArrowRight') j = (i + 1) % available.length;
      else if (event.key === 'ArrowLeft') j = (i - 1 + available.length) % available.length;
      else if (event.key === 'Home') j = 0;
      else if (event.key === 'End') j = available.length - 1;
      if (j !== null) {
        event.preventDefault();
        activateTab(available[j]);
      }
    });
  }

  // ── Drawer state machine (mock v4 contract) ──────────────────
  let lastDrawerFocus = null;

  function setDrawer(open, { tab = null } = {}) {
    if (open && tab) {
      activateTab(tab, { focus: false, notifyModules: false });
    }
    body.dataset.drawer = open ? 'open' : 'closed';
    drawer.inert = !open;
    drawer.setAttribute('aria-hidden', String(!open));
    appShell.inert = open;
    drawerToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      lastDrawerFocus = document.activeElement;
      if (drawerClose) {
        drawerClose.focus();
      }
      notify();
    } else {
      if (lastDrawerFocus && typeof lastDrawerFocus.focus === 'function') {
        lastDrawerFocus.focus();
      }
      lastDrawerFocus = null;
      notify();
      // 嵌套 overlay 退场后重放底层 sidebar 的 inert/焦点 handoff（v4 铁律）
      setSidebar(body.dataset.sidebar === 'open');
    }
  }

  drawerToggle.addEventListener('click', () => {
    if (body.dataset.drawer === 'open') {
      setDrawer(false);
    } else {
      setDrawer(true, { tab: currentTab });
    }
  });
  if (drawerClose) {
    drawerClose.addEventListener('click', () => setDrawer(false));
  }
  if (drawerOverlay) {
    drawerOverlay.addEventListener('click', () => setDrawer(false));
  }

  // ── Focus trap（可见性实测过滤，mock v4） ────────────────────
  function visibleFocusables(root) {
    return Array.from(root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
  }

  function trapTab(root, event) {
    const focusables = visibleFocusables(root);
    if (!focusables.length) {
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      last.focus();
      event.preventDefault();
    } else if (!event.shiftKey && document.activeElement === last) {
      first.focus();
      event.preventDefault();
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (body.dataset.drawer === 'open') {
        setDrawer(false);
      } else if (body.dataset.sidebar === 'open' && !mqDesktop.matches) {
        setSidebar(false, { user: true });
      }
    }
    if (event.key === 'Tab') {
      if (body.dataset.drawer === 'open') {
        trapTab(drawer, event);
      } else if (body.dataset.sidebar === 'open' && !mqDesktop.matches) {
        trapTab(sidebar, event);
      }
    }
  });

  // ── Sidebar state machine（v4：先快照后写入，断点重入焦点接管） ──
  let sidebarUserChoice = null;
  let lastSidebarFocus = null;

  function setSidebar(open, { user = false } = {}) {
    if (user) {
      sidebarUserChoice = open ? 'open' : 'closed';
    }
    const wasOpen = body.dataset.sidebar === 'open';
    const prevFocus = document.activeElement;
    const prevWasAlreadyInert = !!(prevFocus && prevFocus.closest && prevFocus.closest('[inert]'));
    const focusOutsideSidebar = !prevFocus || !sidebar.contains(prevFocus);
    const safeRestoreTarget =
      prevFocus && prevFocus !== document.body && !prevWasAlreadyInert
        ? prevFocus
        : sidebarToggle;
    body.dataset.sidebar = open ? 'open' : 'closed';
    sidebarToggle.setAttribute('aria-expanded', String(open));
    sidebarToggle.setAttribute('aria-label', open ? '收起会话栏' : '打开会话栏');
    sidebar.inert = !open;
    sidebar.setAttribute('aria-hidden', String(!open));
    if (!mqDesktop.matches) {
      if (rail) rail.inert = open;
      if (main) main.inert = open;
      if (body.dataset.drawer !== 'open') {
        if (open && (!wasOpen || focusOutsideSidebar)) {
          lastSidebarFocus = safeRestoreTarget;
          if (sidebarClose) {
            sidebarClose.focus();
          }
        } else if (!open && wasOpen) {
          const target = lastSidebarFocus || sidebarToggle;
          if (target && typeof target.focus === 'function') {
            target.focus();
          }
          lastSidebarFocus = null;
        }
      }
    } else {
      if (rail) rail.inert = false;
      if (main) main.inert = false;
      if (!open && sidebar.contains(document.activeElement)) {
        sidebarToggle.focus();
      }
    }
  }

  sidebarToggle.addEventListener('click', () => setSidebar(body.dataset.sidebar !== 'open', { user: true }));
  if (sidebarClose) {
    sidebarClose.addEventListener('click', () => setSidebar(false, { user: true }));
  }

  function syncSidebarMedia() {
    if (sidebarUserChoice) {
      setSidebar(sidebarUserChoice === 'open');
      return;
    }
    setSidebar(mqDesktop.matches);
  }
  mqDesktop.addEventListener('change', syncSidebarMedia);

  // ── 滚动锚定 + 新消息 pill（mock v4 契约） ───────────────────
  let pill = null;
  let pinnedToBottom = true;

  function nearBottom() {
    return list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
  }

  function scrollToBottom(smooth = true) {
    // 'auto' 会回退到 CSS scroll-behavior: smooth；强制即时必须用 'instant'
    const behavior = smooth && !mqReducedMotion.matches ? 'smooth' : 'instant';
    list.scrollTo({ top: list.scrollHeight, behavior });
  }

  function clearPill() {
    if (pill) {
      pill.remove();
      pill = null;
    }
  }

  function showPill() {
    if (pill) {
      return;
    }
    pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'new-msg-pill';
    pill.textContent = '↓ 新消息';
    pill.addEventListener('click', () => {
      scrollToBottom();
      clearPill();
    });
    list.appendChild(pill);
  }

  list.addEventListener('scroll', () => {
    pinnedToBottom = nearBottom();
    if (pill && pinnedToBottom) {
      clearPill();
    }
  });

  const mutationObserver = new MutationObserver((mutations) => {
    const addedNodes = mutations.some((m) => m.addedNodes.length > 0);
    if (!addedNodes) {
      return;
    }
    if (pinnedToBottom) {
      scrollToBottom(false);
    } else if (pill === null || !list.contains(pill)) {
      // 忽略 pill 自身插入引起的 mutation
      const onlyPill = mutations.every((m) =>
        Array.from(m.addedNodes).every((node) => node === pill)
      );
      if (!onlyPill) {
        showPill();
      }
    }
  });
  mutationObserver.observe(list, { childList: true, subtree: true });

  // ── Composer 自动增高（max 160px，mock 契约） ────────────────
  const composerInput = document.getElementById('composer-input');
  if (composerInput) {
    composerInput.addEventListener('input', () => {
      composerInput.style.height = 'auto';
      composerInput.style.height = Math.min(composerInput.scrollHeight, 160) + 'px';
    });
  }

  // ── Rail 设置入口 ────────────────────────────────────────────
  const railSettings = document.getElementById('rail-settings-button');
  if (railSettings) {
    railSettings.addEventListener('click', () => {
      setDrawer(true, { tab: tabByPanelId.get('panel-settings') || null });
    });
  }

  // ── 条件 tab：游戏（卧底/狼人杀卡片可见性驱动） ──────────────
  const gameCards = [document.getElementById('undercover-game-card'), document.getElementById('werewolf-game-card')].filter(Boolean);
  function syncGameTabVisibility() {
    const anyVisible = gameCards.some((card) => card && !card.classList.contains('hidden'));
    shellApi.setTabVisible('panel-game', anyVisible);
  }
  gameCards.forEach((card) => {
    new MutationObserver(syncGameTabVisibility).observe(card, { attributes: true, attributeFilter: ['class'] });
  });

  // ── 对外 API（panel 模块接线） ───────────────────────────────
  const shellApi = {
    openTab(panelId) {
      const tab = tabByPanelId.get(panelId);
      if (!tab) {
        return;
      }
      if (body.dataset.drawer === 'open') {
        activateTab(tab, { focus: false });
      } else {
        setDrawer(true, { tab });
      }
    },
    releaseTab(panelId) {
      const activeId = currentTab ? currentTab.getAttribute('aria-controls') : '';
      if (body.dataset.drawer === 'open' && activeId === panelId) {
        setDrawer(false);
      }
    },
    closeDrawer() {
      setDrawer(false);
    },
    isDrawerOpen() {
      return body.dataset.drawer === 'open';
    },
    activeTab() {
      return currentTab ? currentTab.getAttribute('aria-controls') : '';
    },
    onChange(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    setTabVisible(panelId, visible, { count = 0 } = {}) {
      const tab = tabByPanelId.get(panelId);
      if (!tab) {
        return;
      }
      tab.hidden = !visible;
      const baseLabel = tab.dataset.baseLabel || tab.textContent.replace(/\s*\d+$/, '');
      tab.dataset.baseLabel = baseLabel;
      tab.textContent = count > 1 ? `${baseLabel} ${count}` : baseLabel;
      if (!visible && currentTab === tab) {
        const fallback = visibleTabs()[0] || null;
        if (fallback && body.dataset.drawer === 'open') {
          activateTab(fallback, { focus: false });
        }
      }
    },
    scrollToBottom,
  };
  window.caffShell = shellApi;

  // ── 初始化 ───────────────────────────────────────────────────
  activateTab(currentTab, { focus: false, notifyModules: false });
  syncSidebarMedia();
  syncGameTabVisibility();
  pinnedToBottom = true;
  scrollToBottom(false);
})();
