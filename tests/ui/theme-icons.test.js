// CAFF UI Milestone 3 contracts: theme lifecycle, repository-owned SVG icons,
// and the restrained light/dark application chrome.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const PAGE_FILES = ['index.html', 'personas.html', 'skills.html', 'projects.html', 'metrics.html'];
const THEME_JS_PATH = path.join(ROOT, 'public', 'shared', 'theme.js');
const ICONS_JS_PATH = path.join(ROOT, 'public', 'shared', 'icons.js');
const ICON_SPRITE_PATH = path.join(ROOT, 'public', 'assets', 'icons.svg');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readPage(name) {
  return read(path.join('public', name));
}

function requireFile(filePath, label) {
  assert.equal(fs.existsSync(filePath), true, `${label} must exist`);
  return fs.readFileSync(filePath, 'utf8');
}

function installMatchMedia(window, initialDark) {
  let matches = initialDark;
  const listeners = new Set();
  const media = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener);
    },
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    dispatch(nextDark) {
      matches = nextDark;
      const event = { matches, media: this.media };
      listeners.forEach((listener) => listener(event));
      if (typeof this.onchange === 'function') this.onchange(event);
    },
  };
  window.matchMedia = (query) => {
    assert.equal(query, '(prefers-color-scheme: dark)');
    return media;
  };
  return media;
}

function bootTheme({ stored, systemDark = false, denyStorage = false } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><button data-theme-toggle><svg><use></use></svg></button></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' },
  );
  const { window } = dom;
  const media = installMatchMedia(window, systemDark);

  if (denyStorage) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new window.DOMException('denied', 'SecurityError');
      },
    });
  } else if (stored !== undefined) {
    window.localStorage.setItem('caff:theme', stored);
  }

  const source = requireFile(THEME_JS_PATH, 'public/shared/theme.js');
  window.eval(source);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { dom, window, document: window.document, media };
}

test('all five routes bootstrap theme before CSS and expose one accessible toggle', () => {
  for (const pageName of PAGE_FILES) {
    const dom = new JSDOM(readPage(pageName));
    const { document } = dom.window;
    const headChildren = [...document.head.children];
    const themeScriptIndex = headChildren.findIndex(
      (node) => node.tagName === 'SCRIPT' && node.getAttribute('src') === '/shared/theme.js',
    );
    const stylesheetIndex = headChildren.findIndex(
      (node) => node.tagName === 'LINK' && node.getAttribute('href') === '/styles.css',
    );

    assert.ok(themeScriptIndex >= 0, `${pageName} must load /shared/theme.js`);
    assert.ok(themeScriptIndex < stylesheetIndex, `${pageName} must bootstrap theme before stylesheet parsing`);

    const toggles = document.querySelectorAll('button[data-theme-toggle]');
    assert.equal(toggles.length, 1, `${pageName} must expose exactly one theme toggle`);
    const toggle = toggles[0];
    assert.equal(toggle.getAttribute('type'), 'button');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.ok(toggle.querySelector('svg.app-icon use'), `${pageName} theme toggle must use the SVG sprite`);
  }
});

test('theme toggle occupies the terminal interactive rail slot on every route', () => {
  for (const pageName of PAGE_FILES) {
    const dom = new JSDOM(readPage(pageName));
    const { document } = dom.window;
    const rail = document.querySelector('.rail');
    const toggle = rail?.querySelector('button[data-theme-toggle]');
    const controls = [...(rail?.children || [])].filter((node) => node.matches('a, button'));

    assert.ok(toggle, `${pageName} must expose its theme toggle inside the rail`);
    assert.equal(
      controls.at(-1),
      toggle,
      `${pageName} theme toggle must remain the final interactive rail control`,
    );
  }
});

test('chat and management rails share stable desktop and mobile terminal layout rules', () => {
  const css = read('public/styles.css');

  assert.match(
    css,
    /body\.chat-app \.rail \.spacer,\s*body\.management-app \.rail \.spacer\s*\{\s*flex:\s*1;\s*\}/,
    'desktop rails must share the same flexible spacer',
  );
  assert.match(
    css,
    /body\.chat-app \.rail \.spacer,\s*body\.management-app \.rail \.spacer\s*\{\s*display:\s*none;\s*\}/,
    'mobile rails must hide both spacers',
  );
  assert.match(
    css,
    /body\.chat-app \.rail\s*\{[^}]*justify-content:\s*space-between;/,
    'the chat mobile rail must anchor its first and last controls',
  );
  assert.match(
    css,
    /body\.management-app \.rail\s*\{[^}]*justify-content:\s*space-between;/,
    'management mobile rails must anchor their first and last controls',
  );
  assert.doesNotMatch(
    css,
    /body\.(?:chat|management)-app \.rail\s*\{[^}]*justify-content:\s*space-around;/,
    'rail positions must not depend on route-specific child counts',
  );
});

test('browser verifier locks theme toggle terminal offsets and switch stability', () => {
  const verifier = read('scripts/ui/verify-theme-icons.mjs');

  assert.match(verifier, /Math\.abs\(snapshot\.toggle\.bottomGap\s*-\s*12\)\s*<=\s*1/);
  assert.match(verifier, /Math\.abs\(state\.toggleRightGap\s*-\s*8\)\s*<=\s*1/);
  assert.match(verifier, /Math\.abs\(after\.x\s*-\s*before\.x\)\s*<=\s*0\.5/);
  assert.match(verifier, /Math\.abs\(after\.y\s*-\s*before\.y\)\s*<=\s*0\.5/);
});

test('theme bootstrap honors explicit preference and valid values only', () => {
  const explicit = bootTheme({ stored: 'dark', systemDark: false });
  assert.equal(explicit.document.documentElement.dataset.theme, 'dark');
  assert.equal(explicit.window.CaffTheme.hasExplicitPreference(), true);

  const invalid = bootTheme({ stored: 'sepia', systemDark: false });
  assert.equal(invalid.document.documentElement.dataset.theme, 'light');
  assert.equal(invalid.window.CaffTheme.hasExplicitPreference(), false);
});

test('system theme remains a projection until the user makes an explicit choice', () => {
  const { window, document, media } = bootTheme({ systemDark: true });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(window.CaffTheme.hasExplicitPreference(), false);

  media.dispatch(false);
  assert.equal(document.documentElement.dataset.theme, 'light', 'system-owned state must follow media changes');

  window.CaffTheme.setTheme('dark');
  assert.equal(window.localStorage.getItem('caff:theme'), 'dark');
  assert.equal(window.CaffTheme.hasExplicitPreference(), true);
  media.dispatch(false);
  assert.equal(document.documentElement.dataset.theme, 'dark', 'explicit state must ignore later media changes');
});

test('theme toggle synchronizes controls and survives denied storage', () => {
  const normal = bootTheme({ systemDark: false });
  const toggle = normal.document.querySelector('[data-theme-toggle]');
  normal.window.CaffTheme.toggle();
  assert.equal(normal.document.documentElement.dataset.theme, 'dark');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.match(toggle.getAttribute('aria-label'), /浅色/);
  assert.match(toggle.querySelector('use').getAttribute('href'), /#icon-sun$/);

  const denied = bootTheme({ systemDark: false, denyStorage: true });
  assert.doesNotThrow(() => denied.window.CaffTheme.toggle());
  assert.equal(denied.document.documentElement.dataset.theme, 'dark');
});

test('storage events synchronize explicit preference across tabs and removal returns to system', () => {
  const { window, document } = bootTheme({ systemDark: false });
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'caff:theme', newValue: 'dark' }));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(window.CaffTheme.hasExplicitPreference(), true);

  window.dispatchEvent(new window.StorageEvent('storage', { key: 'caff:theme', newValue: null }));
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(window.CaffTheme.hasExplicitPreference(), false);
});

test('repository-owned sprite is complete and the dynamic icon helper is fail-fast', () => {
  const sprite = requireFile(ICON_SPRITE_PATH, 'public/assets/icons.svg');
  const required = [
    'chat',
    'users',
    'puzzle',
    'folder',
    'bar-chart',
    'settings',
    'sun',
    'moon',
    'menu',
    'x',
    'refresh',
    'panel-right',
    'arrow-down',
    'archive',
    'file-text',
    'chevron-down',
  ];
  required.forEach((name) => assert.match(sprite, new RegExp(`<symbol\\s+id="icon-${name}"`)));

  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const source = requireFile(ICONS_JS_PATH, 'public/shared/icons.js');
  dom.window.eval(source);
  const icon = dom.window.CaffIcons.create('archive', { className: 'app-icon digest-icon' });
  assert.equal(icon.localName, 'svg');
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(icon.getAttribute('class'), 'app-icon digest-icon');
  assert.equal(icon.querySelector('use').getAttribute('href'), '/assets/icons.svg#icon-archive');
  assert.throws(() => dom.window.CaffIcons.create('not-real'), /Unknown CAFF icon/);
});

test('the static server serves SVG sprites with an image MIME type', () => {
  const staticFileSource = read('server/http/static-file.ts');
  assert.match(staticFileSource, /ext\s*===\s*['"]\.svg['"][\s\S]*?image\/svg\+xml/);
});

test('application chrome uses SVG symbols and contains no emoji-style icon text', () => {
  const forbidden = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|[☰✕⟳↓▾]/u;
  for (const pageName of PAGE_FILES) {
    const dom = new JSDOM(readPage(pageName));
    const { document } = dom.window;
    const chrome = [
      ...document.querySelectorAll(
        '.rail, .management-header, .chat-header, .sidebar-head, .drawer-head, .new-msg-pill',
      ),
    ];
    const text = chrome.map((node) => node.textContent || '').join(' ');
    assert.doesNotMatch(text, forbidden, `${pageName} application chrome must not contain emoji/Unicode icons`);

    document.querySelectorAll('.rail-link').forEach((link) => {
      const use = link.querySelector('svg.app-icon use');
      assert.ok(use, `${pageName} rail links must use the shared SVG sprite`);
      assert.match(use.getAttribute('href'), /^\/assets\/icons\.svg#icon-/);
    });
  }

  assert.doesNotMatch(read('public/chat/conversation-digest-panel.js'), /📦|📝/u);
  assert.doesNotMatch(read('public/chat/conversation-settings.js'), /caret\.textContent\s*=\s*['"]▾['"]/u);
});

test('CSS defines two flat semantic themes and restrained geometry', () => {
  const css = read('public/styles.css');
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /color-scheme:\s*light/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /--caff-radius-sm:\s*6px/);
  assert.match(css, /--caff-radius-md:\s*8px/);
  assert.match(css, /--caff-radius-lg:\s*10px/);
  assert.match(css, /--caff-radius-xl:\s*12px/);
  assert.match(css, /CAFF UI Milestone 3/);
  assert.match(css, /body\.chat-app \.context-drawer[\s\S]*?backdrop-filter:\s*none/);
  assert.match(css, /\.app-icon\s*\{[\s\S]*?stroke:\s*currentColor/);
});

test('participant cards consume theme tokens and avoid legacy pill geometry', () => {
  const css = read('public/styles.css');
  const rule = css.match(/body\.chat-app \.agent-chip\s*\{([\s\S]*?)\}/)?.[1] || '';

  assert.notEqual(rule, '', 'chat participant cards need an explicit M3 theme-consumer rule');
  assert.match(rule, /border-radius:\s*var\(--caff-radius-(?:md|lg)\)/);
  assert.match(rule, /background:\s*var\(--caff-surface-elevated\)/);
  assert.match(rule, /border:\s*1px solid var\(--caff-border\)/);
  assert.match(rule, /color:\s*var\(--caff-text\)/);
  assert.doesNotMatch(rule, /999px|rgba\(255\s*,\s*255\s*,\s*255/);
});

test('model-family management surfaces consume semantic light and dark theme tokens', () => {
  const css = read('public/styles.css');
  const start = css.indexOf('/* ---- Model-family role and provider management ---- */');
  const end = css.indexOf('@media (max-width: 1023px)', start);
  assert.ok(start >= 0 && end > start, 'model-family management CSS region must exist');
  const region = css.slice(start, end);

  assert.match(region, /\.management-list-row\s*\{[\s\S]*?background:\s*var\(--caff-surface-elevated\)/);
  assert.match(region, /\.provider-source-note,[\s\S]*?\.management-card,[\s\S]*?background:\s*var\(--caff-surface\)/);
  assert.match(region, /\.runtime-profile\s*\{[\s\S]*?background:\s*var\(--caff-surface-sunk\)/);
  assert.match(region, /\.skill-option\s*\{[\s\S]*?background:\s*var\(--caff-surface-sunk\)/);
  assert.match(region, /\.provider-model-row\s*\{[\s\S]*?background:\s*var\(--caff-surface-sunk\)/);
  assert.doesNotMatch(
    region,
    /background:\s*(?:#fff(?:fff)?\b|#fff9ee\b|#fff6f5\b|rgba\(243\s*,\s*237\s*,\s*227)/,
    'management surfaces must not bypass theme tokens with light-only backgrounds',
  );

  const verifier = read('scripts/ui/verify-theme-icons.mjs');
  assert.match(verifier, /managementSurfaceBackgrounds/);
  assert.match(verifier, /sampleManagementSurfaceBackgrounds/);
  assert.match(verifier, /page\.click\('#show-provider-management'\)/);
  assert.match(verifier, /page\.click\('#add-provider'\)/);
  assert.match(verifier, /page\.click\('#add-provider-model'\)/);
  assert.match(verifier, /page\.click\('#remove-provider'\)/);
  assert.match(verifier, /dark\.managementSurfaceBackgrounds\.every/);
});

test('the browser gate includes the two-theme route verifier', () => {
  const runner = read('scripts/verify-ui.mjs');
  const verifier = requireFile(
    path.join(ROOT, 'scripts', 'ui', 'verify-theme-icons.mjs'),
    'scripts/ui/verify-theme-icons.mjs',
  );
  assert.match(runner, /verifyThemeIcons/);
  assert.match(runner, /await\s+verifyThemeIcons\s*\(/);
  assert.match(verifier, /\['light',\s*'dark'\]/);
  PAGE_FILES.forEach((pageName) => assert.match(verifier, new RegExp(pageName.replace('.', '\\.'))));
  assert.match(verifier, /contrast/i);
  assert.match(verifier, /assets\/icons\.svg/);
});

test('the browser verifier enforces the exact 44px theme target contract', () => {
  const verifier = read('scripts/ui/verify-theme-icons.mjs');

  assert.doesNotMatch(verifier, />=\s*43\.5/);
  assert.match(verifier, /snapshot\.toggle\.width\s*>=\s*44/);
  assert.match(verifier, /snapshot\.toggle\.height\s*>=\s*44/);
  assert.match(verifier, /state\.toggleSize\s*>=\s*44/);
});

test('package gates include the new shared helpers and M3 contract suite', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.check, /public\/shared\/theme\.js/);
  assert.match(pkg.scripts.check, /public\/shared\/icons\.js/);
  assert.match(pkg.scripts['test:fast'], /tests\/ui\/theme-icons\.test\.js/);
});
