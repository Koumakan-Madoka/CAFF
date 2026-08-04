const THEMES = ['light', 'dark'];

const ROUTES = [
  { key: 'chat', file: 'index.html', route: '/', primary: '#send-button' },
  { key: 'personas', file: 'personas.html', route: '/personas.html', primary: '#new-agent-button' },
  { key: 'skills', file: 'skills.html', route: '/skills.html', primary: '#new-skill-button' },
  { key: 'projects', file: 'projects.html', route: '/projects.html', primary: '#new-project-form button[type="submit"]' },
  { key: 'metrics', file: 'metrics.html', route: '/metrics.html', primary: '#filter-form button[type="submit"]' },
];

function trackPage(page) {
  const diagnostics = { consoleErrors: [], pageErrors: [], badResponses: [] };
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) {
      diagnostics.consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('favicon')) {
      diagnostics.badResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  return diagnostics;
}

function parseRgb(value) {
  const match = String(value || '').match(/rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function relativeLuminance(color) {
  if (!color) return 0;
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground, background) {
  const fg = relativeLuminance(parseRgb(foreground));
  const bg = relativeLuminance(parseRgb(background));
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

function diagnosticsAreClean(diagnostics) {
  return diagnostics.consoleErrors.length === 0
    && diagnostics.pageErrors.length === 0
    && diagnostics.badResponses.length === 0;
}

async function openPage(browser, baseUrl, definition, theme, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((value) => localStorage.setItem('caff:theme', value), theme);
  const page = await context.newPage();
  const diagnostics = trackPage(page);
  await page.goto(new URL(definition.route, baseUrl).href, { waitUntil: 'load' });
  await page.waitForSelector('button[data-theme-toggle]');
  await page.waitForTimeout(250);
  return { context, page, diagnostics };
}

async function readThemeSnapshot(page, definition) {
  return page.evaluate(async ({ primarySelector }) => {
    const visible = (element) => Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none');
    const styleOf = (element) => element ? getComputedStyle(element) : null;
    const rail = document.querySelector('.rail');
    const toggle = document.querySelector('button[data-theme-toggle]');
    const railRect = rail ? rail.getBoundingClientRect() : null;
    const toggleRect = toggle ? toggle.getBoundingClientRect() : null;
    const input = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select')).find(visible);
    const primary = document.querySelector(primarySelector);
    const surface = document.querySelector('.chat-header, .management-header');
    const participantList = document.querySelector('#participant-list');
    const participantProbe = participantList ? document.createElement('div') : null;
    if (participantProbe && participantList) {
      participantProbe.className = 'agent-chip';
      participantProbe.textContent = 'Theme probe';
      participantList.appendChild(participantProbe);
    }
    const radii = Array.from(document.querySelectorAll([
      '.rail-link',
      '.rail-button',
      '.icon-btn',
      '.management-icon-button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      '.message-card',
      '.stack-card',
      '.agent-list-item',
      '.drawer-tabs button',
      '.new-msg-pill',
    ].join(',')))
      .filter(visible)
      .map((element) => Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0);
    const chrome = Array.from(document.querySelectorAll([
      '.rail',
      '.sidebar',
      '.chat-header',
      '.composer',
      '.context-drawer',
      '.management-header',
      '.management-index',
      '.management-detail',
    ].join(','))).filter(visible);
    const spriteResponse = await fetch('/assets/icons.svg');
    const spriteType = spriteResponse.headers.get('content-type') || '';
    await spriteResponse.arrayBuffer();

    const inputStyle = styleOf(input);
    const primaryStyle = styleOf(primary);
    const surfaceStyle = styleOf(surface);
    const bodyStyle = styleOf(document.body);
    const participantStyle = styleOf(participantProbe);
    const useHrefs = Array.from(document.querySelectorAll('svg.app-icon use')).map((use) => use.getAttribute('href') || '');

    return {
      theme: document.documentElement.dataset.theme,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      explicit: Boolean(window.CaffTheme && window.CaffTheme.hasExplicitPreference()),
      toggle: {
        count: document.querySelectorAll('button[data-theme-toggle]').length,
        x: toggleRect ? toggleRect.x : -1,
        y: toggleRect ? toggleRect.y : -1,
        width: toggleRect ? toggleRect.width : 0,
        height: toggleRect ? toggleRect.height : 0,
        bottomGap: railRect && toggleRect ? railRect.bottom - toggleRect.bottom : -1,
        pressed: toggle ? toggle.getAttribute('aria-pressed') : '',
        label: toggle ? toggle.getAttribute('aria-label') : '',
        icon: toggle ? toggle.querySelector('use')?.getAttribute('href') || '' : '',
      },
      iconUseCount: useHrefs.length,
      iconHrefsValid: useHrefs.length > 0 && useHrefs.every((href) => /^\/assets\/icons\.svg#icon-[a-z-]+$/.test(href)),
      sprite: { ok: spriteResponse.ok, status: spriteResponse.status, contentType: spriteType },
      containment: {
        width: document.documentElement.scrollWidth <= innerWidth + 1,
        height: document.documentElement.scrollHeight <= innerHeight + 1,
      },
      maxRadius: radii.length ? Math.max(...radii) : 0,
      chromeBackgroundImages: chrome.map((element) => getComputedStyle(element).backgroundImage),
      chromeBackdropFilters: chrome.map((element) => getComputedStyle(element).backdropFilter),
      colors: {
        bodyBackground: bodyStyle?.backgroundColor || '',
        bodyText: bodyStyle?.color || '',
        surfaceBackground: surfaceStyle?.backgroundColor || '',
        inputBackground: inputStyle?.backgroundColor || '',
        inputText: inputStyle?.color || '',
        primaryBackground: primaryStyle?.backgroundColor || '',
        primaryText: primaryStyle?.color || '',
      },
      participant: participantStyle ? {
        background: participantStyle.backgroundColor,
        text: participantStyle.color,
        borderRadius: Number.parseFloat(participantStyle.borderTopLeftRadius) || 0,
      } : null,
    };
  }, { primarySelector: definition.primary });
}

async function readResponsiveState(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('.rail');
    const toggle = document.querySelector('button[data-theme-toggle]');
    const railRect = rail?.getBoundingClientRect();
    const toggleRect = toggle?.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      widthContained: document.documentElement.scrollWidth <= innerWidth + 1,
      heightContained: document.documentElement.scrollHeight <= innerHeight + 1,
      railVisible: Boolean(railRect && railRect.width > 0 && railRect.height > 0),
      toggleSize: toggleRect ? Math.min(toggleRect.width, toggleRect.height) : 0,
      toggleBottomGap: railRect && toggleRect ? railRect.bottom - toggleRect.bottom : -1,
      toggleRightGap: railRect && toggleRect ? railRect.right - toggleRect.right : -1,
      icons: document.querySelectorAll('svg.app-icon use').length,
    };
  });
}

async function readTogglePosition(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('button[data-theme-toggle]')?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y } : null;
  });
}

export async function verifyThemeIcons({ browser, baseUrl, ok }) {
  const snapshots = new Map();

  for (const definition of ROUTES) {
    for (const theme of THEMES) {
      const opened = await openPage(browser, baseUrl, definition, theme, { width: 1440, height: 900 });
      try {
        const snapshot = await readThemeSnapshot(opened.page, definition);
        snapshots.set(`${definition.key}:${theme}`, snapshot);
        const expectedIcon = theme === 'dark' ? 'sun' : 'moon';
        const expectedLabel = theme === 'dark' ? '切换为浅色主题' : '切换为深色主题';
        ok(
          `Q-${definition.key}-${theme} theme + line icons + clean runtime`,
          snapshot.theme === theme
            && snapshot.colorScheme === theme
            && snapshot.explicit
            && snapshot.toggle.count === 1
            && snapshot.toggle.width >= 44
            && snapshot.toggle.height >= 44
            && Math.abs(snapshot.toggle.bottomGap - 12) <= 1
            && snapshot.toggle.pressed === String(theme === 'dark')
            && snapshot.toggle.label === expectedLabel
            && snapshot.toggle.icon.endsWith(`#icon-${expectedIcon}`)
            && snapshot.iconUseCount >= 7
            && snapshot.iconHrefsValid
            && snapshot.sprite.ok
            && snapshot.sprite.contentType.startsWith('image/svg+xml')
            && diagnosticsAreClean(opened.diagnostics),
          JSON.stringify({ snapshot, diagnostics: opened.diagnostics }),
        );

        const contrast = {
          body: contrastRatio(snapshot.colors.bodyText, snapshot.colors.bodyBackground),
          input: contrastRatio(snapshot.colors.inputText, snapshot.colors.inputBackground),
          primary: contrastRatio(snapshot.colors.primaryText, snapshot.colors.primaryBackground),
        };
        ok(
          `Q-${definition.key}-${theme} flat geometry + readable contrast`,
          snapshot.containment.width
            && snapshot.containment.height
            && snapshot.maxRadius <= 12.1
            && snapshot.chromeBackgroundImages.every((value) => value === 'none')
            && snapshot.chromeBackdropFilters.every((value) => value === 'none')
            && contrast.body >= 4.5
            && contrast.input >= 4.5
            && contrast.primary >= 4.5,
          JSON.stringify({ containment: snapshot.containment, maxRadius: snapshot.maxRadius, contrast, backgrounds: snapshot.chromeBackgroundImages, backdrops: snapshot.chromeBackdropFilters }),
        );

        const before = await readTogglePosition(opened.page);
        const toggledTheme = theme === 'dark' ? 'light' : 'dark';
        await opened.page.click('button[data-theme-toggle]');
        await opened.page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, toggledTheme);
        const after = await readTogglePosition(opened.page);
        ok(
          `Q-${definition.key}-${theme} switch keeps theme toggle fixed`,
          Boolean(before && after)
            && Math.abs(after.x - before.x) <= 0.5
            && Math.abs(after.y - before.y) <= 0.5
            && diagnosticsAreClean(opened.diagnostics),
          JSON.stringify({ before, after, diagnostics: opened.diagnostics }),
        );
      } finally {
        await opened.context.close();
      }
    }

    const light = snapshots.get(`${definition.key}:light`);
    const dark = snapshots.get(`${definition.key}:dark`);
    ok(
      `Q-${definition.key} light/dark tokens are materially distinct`,
      Boolean(light && dark)
        && light.colors.bodyBackground !== dark.colors.bodyBackground
        && light.colors.surfaceBackground !== dark.colors.surfaceBackground
        && light.colors.bodyText !== dark.colors.bodyText
        && (definition.key !== 'chat' || (
          light.participant
          && dark.participant
          && light.participant.background !== dark.participant.background
          && dark.participant.borderRadius <= 12.1
          && relativeLuminance(parseRgb(dark.participant.background)) < relativeLuminance(parseRgb(light.participant.background))
          && contrastRatio(dark.participant.text, dark.participant.background) >= 4.5
        )),
      JSON.stringify({ light: light?.colors, dark: dark?.colors, lightParticipant: light?.participant, darkParticipant: dark?.participant }),
    );
  }

  const systemContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await systemContext.newPage();
    const diagnostics = trackPage(page);
    await page.goto(new URL('/', baseUrl).href, { waitUntil: 'load' });
    await page.waitForSelector('button[data-theme-toggle]');
    const bootstrap = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      explicit: window.CaffTheme?.hasExplicitPreference(),
      stored: localStorage.getItem('caff:theme'),
    }));
    ok('Q-system dark boot is a non-persisted projection', bootstrap.theme === 'dark' && bootstrap.explicit === false && bootstrap.stored === null && diagnosticsAreClean(diagnostics), JSON.stringify({ bootstrap, diagnostics }));

    await page.click('button[data-theme-toggle]');
    await page.goto(new URL('/personas.html', baseUrl).href, { waitUntil: 'load' });
    const persisted = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      explicit: window.CaffTheme?.hasExplicitPreference(),
      stored: localStorage.getItem('caff:theme'),
    }));
    ok('Q-explicit toggle persists across routes', persisted.theme === 'light' && persisted.explicit === true && persisted.stored === 'light', JSON.stringify(persisted));
  } finally {
    await systemContext.close();
  }

  const invalidContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    await invalidContext.addInitScript(() => localStorage.setItem('caff:theme', 'sepia'));
    const page = await invalidContext.newPage();
    await page.goto(new URL('/skills.html', baseUrl).href, { waitUntil: 'load' });
    const invalid = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      explicit: window.CaffTheme?.hasExplicitPreference(),
    }));
    ok('Q-invalid stored theme recovers to system projection', invalid.theme === 'dark' && invalid.explicit === false, JSON.stringify(invalid));
  } finally {
    await invalidContext.close();
  }

  for (const definition of ROUTES) {
    for (const width of [820, 375]) {
      const opened = await openPage(browser, baseUrl, definition, 'dark', { width, height: 800 });
      try {
        const state = await readResponsiveState(opened.page);
        ok(
          `Q-${definition.key}-${width} dark responsive containment`,
          state.theme === 'dark'
            && state.widthContained
            && state.heightContained
            && state.railVisible
            && state.toggleSize >= 44
            && (width <= 767
              ? Math.abs(state.toggleRightGap - 8) <= 1
              : Math.abs(state.toggleBottomGap - 12) <= 1)
            && state.icons >= 7
            && diagnosticsAreClean(opened.diagnostics),
          JSON.stringify({ state, diagnostics: opened.diagnostics }),
        );
      } finally {
        await opened.context.close();
      }
    }
  }
}
