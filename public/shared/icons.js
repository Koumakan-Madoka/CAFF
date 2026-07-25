(function initCaffIcons(global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SPRITE_URL = '/assets/icons.svg';
  const ICON_NAMES = new Set([
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
  ]);

  function create(name, options = {}) {
    if (!ICON_NAMES.has(name)) {
      throw new Error(`Unknown CAFF icon: ${name}`);
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', options.className || 'app-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `${SPRITE_URL}#icon-${name}`);
    svg.appendChild(use);
    return svg;
  }

  global.CaffIcons = Object.freeze({ create });
})(window);
