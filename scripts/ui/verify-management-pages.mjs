import fs from 'node:fs';
import path from 'node:path';

const MANAGEMENT_PAGES = [
  { key: 'personas', route: '/personas.html' },
  { key: 'skills', route: '/skills.html' },
  { key: 'projects', route: '/projects.html' },
  { key: 'metrics', route: '/metrics.html' },
];

function trackPage(page) {
  const diagnostics = { consoleErrors: [], pageErrors: [], badResponses: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') {
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

async function openManagementPage(browser, baseUrl, route, viewport) {
  const page = await browser.newPage({ viewport });
  const diagnostics = trackPage(page);
  await page.goto(new URL(route, baseUrl).href, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(250);
  return { page, diagnostics };
}

async function readLayout(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('.management-shell');
    const content = document.querySelector('.management-content');
    const index = document.querySelector('.management-index');
    const detail = Array.from(document.querySelectorAll('.management-detail'))
      .find((element) => getComputedStyle(element).display !== 'none');
    const rail = document.querySelector('.rail');
    const refresh = document.getElementById('refresh-button');
    const title = document.querySelector('.management-title');
    const activeLinks = Array.from(document.querySelectorAll('.rail-link[aria-current="page"]'));
    const indexRect = index && index.getBoundingClientRect();
    const detailRect = detail && detail.getBoundingClientRect();
    const railRect = rail && rail.getBoundingClientRect();
    const titleRect = title && title.getBoundingClientRect();
    const refreshRect = refresh && refresh.getBoundingClientRect();
    const targetSelector = [
      'button',
      'a[href]',
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      'select',
      'textarea',
      'label:has(input[type="checkbox"])',
      'label:has(input[type="radio"])',
    ].join(',');
    const undersizedTargets = Array.from(document.querySelectorAll(targetSelector))
      .filter((element) => getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${element.className || ''}`,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      })
      .filter((target) => target.width < 43.5 || target.height < 43.5);

    return {
      page: document.body.dataset.page,
      bodyOverflow: getComputedStyle(document.body).overflow,
      shellHeight: shell ? shell.getBoundingClientRect().height : 0,
      viewportHeight: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      activeHref: activeLinks.length === 1 ? activeLinks[0].getAttribute('href') : '',
      activeCount: activeLinks.length,
      indexOverflow: index ? getComputedStyle(index).overflowY : '',
      detailOverflow: detail ? getComputedStyle(detail).overflowY : '',
      contentOverflow: content ? getComputedStyle(content).overflowY : '',
      panesSideBySide: Boolean(indexRect && detailRect && indexRect.right <= detailRect.left + 1),
      panesStacked: Boolean(indexRect && detailRect && detailRect.top >= indexRect.bottom - 1),
      panesContained: Boolean(indexRect && detailRect && indexRect.top >= 0 && detailRect.bottom <= innerHeight + 1),
      railBottom: railRect ? Math.round(railRect.bottom) : 0,
      railHeight: railRect ? Math.round(railRect.height) : 0,
      headerOverlap: Boolean(
        titleRect && refreshRect
        && Math.min(titleRect.right, refreshRect.right) - Math.max(titleRect.left, refreshRect.left) > 1
        && Math.min(titleRect.bottom, refreshRect.bottom) - Math.max(titleRect.top, refreshRect.top) > 1
      ),
      undersizedTargets,
    };
  });
}

async function readMetricsDateFilterLayout(page) {
  return page.evaluate(() => {
    const form = document.getElementById('filter-form');
    const since = document.getElementById('since-input');
    const until = document.getElementById('until-input');
    if (!form || !since || !until) {
      return { available: false };
    }

    const formRect = form.getBoundingClientRect();
    const sinceRect = since.getBoundingClientRect();
    const untilRect = until.getBoundingClientRect();
    const overlaps = Math.min(sinceRect.right, untilRect.right) - Math.max(sinceRect.left, untilRect.left) > 1
      && Math.min(sinceRect.bottom, untilRect.bottom) - Math.max(sinceRect.top, untilRect.top) > 1;
    const contained = [sinceRect, untilRect].every((rect) => (
      rect.left >= formRect.left - 1
      && rect.right <= formRect.right + 1
    ));
    const pickerTargetIds = [sinceRect, untilRect].map((rect) => {
      const target = document.elementFromPoint(rect.right - 12, rect.top + (rect.height / 2));
      return target && target.id;
    });

    return {
      available: true,
      overlaps,
      contained,
      pickerTargetsReachable: pickerTargetIds[0] === 'since-input' && pickerTargetIds[1] === 'until-input',
      pickerTargetIds,
      formWidth: Math.round(formRect.width * 10) / 10,
      since: {
        left: Math.round(sinceRect.left * 10) / 10,
        right: Math.round(sinceRect.right * 10) / 10,
        width: Math.round(sinceRect.width * 10) / 10,
      },
      until: {
        left: Math.round(untilRect.left * 10) / 10,
        right: Math.round(untilRect.right * 10) / 10,
        width: Math.round(untilRect.width * 10) / 10,
      },
    };
  });
}

function layoutIsContained(layout) {
  return layout.bodyOverflow === 'hidden'
    && Math.abs(layout.shellHeight - layout.viewportHeight) < 2
    && layout.documentWidth <= layout.viewportWidth + 1
    && layout.documentHeight <= layout.viewportHeight + 1;
}

function diagnosticsAreClean(diagnostics) {
  return diagnostics.consoleErrors.length === 0
    && diagnostics.pageErrors.length === 0
    && diagnostics.badResponses.length === 0;
}

export async function verifyManagementPages({ browser, baseUrl, ok, outputDir, screenshotName }) {
  const pages = [];
  try {
    for (const definition of MANAGEMENT_PAGES) {
      const tracked = await openManagementPage(browser, baseUrl, definition.route, { width: 1440, height: 900 });
      pages.push(tracked.page);
      const layout = await readLayout(tracked.page);
      ok(
        `P-${definition.key} fixed shell + route + bounded panes`,
        layout.page === definition.key
          && layout.activeCount === 1
          && layout.activeHref === definition.route
          && layoutIsContained(layout)
          && layout.panesSideBySide
          && layout.panesContained
          && layout.indexOverflow === 'auto'
          && layout.detailOverflow === 'auto',
        JSON.stringify(layout),
      );
      ok(
        `P-${definition.key} visible targets >=44px + clean runtime`,
        layout.undersizedTargets.length === 0 && diagnosticsAreClean(tracked.diagnostics),
        JSON.stringify({ undersized: layout.undersizedTargets, diagnostics: tracked.diagnostics }),
      );
    }

    const metrics = await openManagementPage(browser, baseUrl, '/metrics.html', { width: 1440, height: 900 });
    pages.push(metrics.page);
    for (const width of [1440, 820, 375]) {
      await metrics.page.setViewportSize({ width, height: 900 });
      await metrics.page.waitForTimeout(200);
      const dateFilter = await readMetricsDateFilterLayout(metrics.page);
      ok(
        `P-metrics ${width} date controls are contained, non-overlapping, and reachable`,
        dateFilter.available
          && dateFilter.contained
          && !dateFilter.overlaps
          && dateFilter.pickerTargetsReachable,
        JSON.stringify(dateFilter),
      );
    }

    const keyboard = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    pages.push(keyboard);
    const keyboardDiagnostics = trackPage(keyboard);
    await keyboard.route('**/api/bootstrap', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agents: [
            { id: 'verify-a', name: '验证人格 A', description: '键盘测试', roleKind: 'custom', modelProfiles: [], skills: [] },
            { id: 'verify-b', name: '验证人格 B', description: '键盘测试', roleKind: 'custom', modelProfiles: [], skills: [] },
          ],
          skills: [],
          modelOptions: [],
          localAdmin: { modelProviders: { enabled: false } },
        }),
      });
    });
    await keyboard.goto(new URL('/personas.html', baseUrl).href, { waitUntil: 'load' });
    await keyboard.waitForSelector('#custom-role-list li:nth-child(2) > button');
    await keyboard.locator('#custom-role-list li:nth-child(2) > button').focus();
    await keyboard.keyboard.press('Enter');
    await keyboard.waitForFunction(() => document.querySelector('#custom-role-list button[data-id="verify-b"]')?.classList.contains('active'));
    const keyboardState = await keyboard.evaluate(() => ({
      listTag: document.getElementById('custom-role-list')?.tagName,
      rowTag: document.querySelector('#custom-role-list > li')?.tagName,
      buttonTag: document.querySelector('#custom-role-list > li > button')?.tagName,
      activeId: document.querySelector('#custom-role-list .agent-list-item.active')?.dataset.id,
      title: document.getElementById('role-name')?.value,
    }));
    ok(
      'P-keyboard native list button Enter selects a management item',
      keyboardState.listTag === 'UL'
        && keyboardState.rowTag === 'LI'
        && keyboardState.buttonTag === 'BUTTON'
        && keyboardState.activeId === 'verify-b'
        && String(keyboardState.title || '').includes('验证人格 B')
        && diagnosticsAreClean(keyboardDiagnostics),
      JSON.stringify({ keyboardState, diagnostics: keyboardDiagnostics }),
    );

    const rowChrome = await keyboard.evaluate(() => Array.from(document.querySelectorAll('#custom-role-list > li')).map((li) => {
      const button = li.querySelector(':scope > button');
      const buttonRect = button ? button.getBoundingClientRect() : null;
      return {
        liHasRowClass: li.classList.contains('management-list-row'),
        buttonHasRowClass: Boolean(button && button.classList.contains('management-list-row')),
        liHeight: Math.round(li.getBoundingClientRect().height),
        buttonHeight: buttonRect ? Math.round(buttonRect.height) : 0,
      };
    }));
    ok(
      'P-role-rows single card chrome: chrome-free li wrapper, button owns .management-list-row',
      rowChrome.length > 0
        && rowChrome.every((row) => !row.liHasRowClass
          && row.buttonHasRowClass
          && Math.abs(row.liHeight - row.buttonHeight) <= 1),
      JSON.stringify(rowChrome),
    );

    const tabletLayout = await readLayout(keyboard);
    await keyboard.setViewportSize({ width: 820, height: 900 });
    await keyboard.waitForTimeout(200);
    const tablet = await readLayout(keyboard);
    ok(
      'P-responsive 820 keeps bounded index/detail panes',
      layoutIsContained(tablet)
        && tablet.panesSideBySide
        && tablet.indexOverflow === 'auto'
        && tablet.detailOverflow === 'auto'
        && tablet.undersizedTargets.length === 0,
      JSON.stringify({ before: tabletLayout, after: tablet }),
    );

    await keyboard.setViewportSize({ width: 375, height: 800 });
    await keyboard.evaluate(() => { document.querySelector('.management-content').scrollTop = 0; });
    await keyboard.waitForTimeout(200);
    const mobile = await readLayout(keyboard);
    ok(
      'P-responsive 375 uses bottom rail + one internal scroll region',
      layoutIsContained(mobile)
        && mobile.railHeight === 56
        && mobile.railBottom === mobile.viewportHeight
        && mobile.panesStacked
        && mobile.contentOverflow === 'auto'
        && mobile.indexOverflow === 'visible'
        && mobile.detailOverflow === 'visible'
        && !mobile.headerOverlap
        && mobile.undersizedTargets.length === 0,
      JSON.stringify(mobile),
    );

    const empty = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    pages.push(empty);
    const emptyDiagnostics = trackPage(empty);
    await empty.route('**/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ projects: [], activeProjectId: '' }),
      });
    });
    await empty.goto(new URL('/projects.html', baseUrl).href, { waitUntil: 'load' });
    await empty.waitForSelector('#project-list .management-list-empty');
    const emptyState = await empty.evaluate(() => ({
      rowTag: document.querySelector('#project-list > .management-list-empty')?.tagName,
      text: document.querySelector('#project-list > .management-list-empty')?.textContent,
      activateDisabled: document.getElementById('set-active-button')?.disabled,
      deleteDisabled: document.getElementById('delete-project-button')?.disabled,
    }));
    ok(
      'P-empty projects renders semantic empty state and disables unavailable actions',
      emptyState.rowTag === 'LI'
        && String(emptyState.text || '').includes('还没有添加项目')
        && emptyState.activateDisabled === true
        && emptyState.deleteDisabled === true
        && diagnosticsAreClean(emptyDiagnostics),
      JSON.stringify({ emptyState, diagnostics: emptyDiagnostics }),
    );

    await keyboard.setViewportSize({ width: 1440, height: 900 });
    await keyboard.evaluate(() => { document.querySelector('.management-content').scrollTop = 0; });
    await keyboard.evaluate(() => window.CaffTheme?.setTheme('dark'));
    await keyboard.waitForTimeout(200);
    fs.mkdirSync(outputDir, { recursive: true });
    await keyboard.screenshot({ path: path.join(outputDir, screenshotName) });
  } finally {
    await Promise.all(pages.map((page) => page.close().catch(() => {})));
  }
}
