// @ts-check

(function initCaffTheme() {
  'use strict';

  const global = window;
  const document = global.document;
  const STORAGE_KEY = 'caff:theme';
  const DARK_QUERY = '(prefers-color-scheme: dark)';
  /** @typedef {'light' | 'dark'} Theme */
  const media = typeof global.matchMedia === 'function' ? global.matchMedia(DARK_QUERY) : null;

  let explicitTheme = readStoredTheme();
  let currentTheme = explicitTheme || systemTheme();

  /**
   * @param {unknown} value
   * @returns {value is Theme}
   */
  function isTheme(value) {
    return value === 'light' || value === 'dark';
  }

  /** @returns {Theme | null} */
  function readStoredTheme() {
    try {
      const value = global.localStorage.getItem(STORAGE_KEY);
      return isTheme(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** @param {Theme} theme */
  function persistTheme(theme) {
    try {
      global.localStorage.setItem(STORAGE_KEY, theme);
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {Theme} */
  function systemTheme() {
    return media && media.matches ? 'dark' : 'light';
  }

  /** @param {unknown} theme */
  function applyTheme(theme) {
    currentTheme = isTheme(theme) ? theme : 'light';
    document.documentElement.dataset.theme = currentTheme;
    document.documentElement.style.colorScheme = currentTheme;
    syncControls();
    return currentTheme;
  }

  function syncControls() {
    const isDark = currentTheme === 'dark';
    const nextLabel = isDark ? '切换为浅色主题' : '切换为深色主题';
    const iconName = isDark ? 'sun' : 'moon';

    const toggles = /** @type {NodeListOf<HTMLButtonElement>} */ (
      document.querySelectorAll('button[data-theme-toggle]')
    );
    toggles.forEach((toggle) => {
      toggle.setAttribute('aria-pressed', String(isDark));
      toggle.setAttribute('aria-label', nextLabel);
      toggle.setAttribute('title', nextLabel);
      if (!toggle.dataset.themeBound) {
        toggle.addEventListener('click', toggleTheme);
        toggle.dataset.themeBound = 'true';
      }
      const use = toggle.querySelector('use');
      if (use) {
        const href = `/assets/icons.svg#icon-${iconName}`;
        use.setAttribute('href', href);
        use.setAttribute('xlink:href', href);
      }
    });
  }

  /** @param {Theme} theme */
  function setTheme(theme) {
    if (!isTheme(theme)) {
      throw new TypeError(`Unsupported CAFF theme: ${String(theme)}`);
    }
    explicitTheme = theme;
    persistTheme(theme);
    return applyTheme(theme);
  }

  function toggleTheme() {
    return setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  }

  /** @param {MediaQueryListEvent | { matches: boolean } | null | undefined} event */
  function handleSystemChange(event) {
    if (!explicitTheme) {
      applyTheme(event && event.matches ? 'dark' : 'light');
    }
  }

  /** @param {StorageEvent} event */
  function handleStorage(event) {
    if (!event || event.key !== STORAGE_KEY) {
      return;
    }
    if (isTheme(event.newValue)) {
      explicitTheme = event.newValue;
      applyTheme(event.newValue);
      return;
    }
    if (event.newValue === null) {
      explicitTheme = null;
      applyTheme(systemTheme());
    }
  }

  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', handleSystemChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(handleSystemChange);
    }
  }
  global.addEventListener('storage', handleStorage);
  document.addEventListener('DOMContentLoaded', syncControls, { once: true });

  applyTheme(currentTheme);

  global.CaffTheme = Object.freeze({
    getTheme() {
      return currentTheme;
    },
    hasExplicitPreference() {
      return Boolean(explicitTheme);
    },
    setTheme,
    toggle: toggleTheme,
    syncControls,
  });
})();
