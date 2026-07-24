// CAFF AppShell UI 契约验证（真实浏览器）。
// 用法:
//   node scripts/verify-ui.mjs
// 环境变量:
//   CAFF_VERIFY_APP  目标地址（默认 http://localhost:3210/）
//   CAFF_VERIFY_OUT  证据输出目录（默认 <os.tmpdir>/caff-ui-verify）
//   PLAYWRIGHT_CORE_DIR  额外 playwright-core 解析目录（可选）
// 退出码: 0 全绿 / 1 有 FAIL / 2 缺少 playwright-core

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  const alt = process.env.PLAYWRIGHT_CORE_DIR;
  if (alt) {
    const req = createRequire(path.join(alt, 'package.json'));
    ({ chromium } = req('playwright-core'));
  } else {
    console.error('playwright-core 未安装：npm i --no-save playwright-core，或设置 PLAYWRIGHT_CORE_DIR');
    process.exit(2);
  }
}

const APP = process.env.CAFF_VERIFY_APP || 'http://localhost:3210/';
const OUT = process.env.CAFF_VERIFY_OUT || path.join(os.tmpdir(), 'caff-ui-verify');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function newTrackedPage(viewport, extra = {}) {
  const page = await browser.newPage({ viewport, ...extra });
  page.consoleErrors = [];
  page.pageErrors = [];
  page.notFound = [];
  page.badResponses = [];
  page.on('console', (msg) => { if (msg.type() === 'error') page.consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => page.pageErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() === 404) page.notFound.push(res.url());
    if (res.status() >= 400 && !res.url().includes('favicon')) page.badResponses.push(`${res.status()} ${res.url()}`);
  });
  return page;
}

async function waitAppReady(page) {
  await page.waitForFunction(() => {
    const pill = document.getElementById('runtime-pill');
    return pill && !pill.textContent.includes('正在连接');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function injectMessages(page, count) {
  await page.evaluate((n) => {
    const list = document.getElementById('message-list');
    for (let i = 0; i < n; i += 1) {
      const el = document.createElement('div');
      el.className = 'message-card assistant';
      el.innerHTML = `<div class="message-body"><p>contract test message ${i} - padding the scroll area.</p></div>`;
      list.appendChild(el);
    }
  }, count);
  await page.waitForTimeout(400);
}

// A. 1440 desktop: fixed viewport + independent scroll
let page = await newTrackedPage({ width: 1440, height: 900 });
await page.goto(APP, { waitUntil: 'load' });
await waitAppReady(page);

const boot = await page.evaluate(() => ({
  bodyOverflow: getComputedStyle(document.body).overflow,
  shellH: document.getElementById('appShell').getBoundingClientRect().height,
  vh: innerHeight,
  docScrollH: document.documentElement.scrollHeight,
  sidebarW: document.getElementById('sidebar').getBoundingClientRect().width,
  role: document.getElementById('message-list').getAttribute('role'),
  live: document.getElementById('message-list').getAttribute('aria-live'),
  tabindex: document.getElementById('message-list').tabIndex,
}));
ok('A1 body overflow hidden + app-shell=100dvh', boot.bodyOverflow === 'hidden' && Math.abs(boot.shellH - boot.vh) < 2 && boot.docScrollH <= boot.vh + 1, JSON.stringify(boot));
ok('A2 desktop sidebar default open 280px', boot.sidebarW === 280, `w=${boot.sidebarW}`);
ok('A3 message-list semantics role=log/aria-live/tabindex=0', boot.role === 'log' && boot.live === 'polite' && boot.tabindex === 0, JSON.stringify(boot));

await injectMessages(page, 60);
const scroll = await page.evaluate(() => {
  const l = document.getElementById('message-list');
  const header = document.querySelector('.chat-header').getBoundingClientRect();
  const composer = document.getElementById('composer-form').getBoundingClientRect();
  return {
    scrollH: l.scrollHeight, clientH: l.clientHeight,
    docScrollH: document.documentElement.scrollHeight, vh: innerHeight,
    headerVisible: header.top >= 0 && header.bottom <= innerHeight,
    composerVisible: composer.top >= 0 && composer.bottom <= innerHeight,
  };
});
ok('A4 message list real overflow', scroll.scrollH > scroll.clientH + 200, `scrollH=${scroll.scrollH} clientH=${scroll.clientH}`);
ok('A5 long chat does not grow document + header/composer reachable', scroll.docScrollH <= scroll.vh + 1 && scroll.headerVisible && scroll.composerVisible, JSON.stringify(scroll));

const pinned = await page.evaluate(() => {
  const l = document.getElementById('message-list');
  return l.scrollTop + l.clientHeight >= l.scrollHeight - 80;
});
ok('A6 pinned-to-bottom auto-follow on new messages', pinned === true, `pinned=${pinned}`);

await page.evaluate(() => { document.getElementById('message-list').scrollTop = 0; });
await page.waitForTimeout(200);
await injectMessages(page, 5);
const pillState = await page.evaluate(() => {
  const pill = document.querySelector('.new-msg-pill');
  return pill ? { shown: true, h: pill.getBoundingClientRect().height } : { shown: false };
});
ok('A7 off-bottom new-message pill shown, >=44px', pillState.shown && pillState.h >= 44, JSON.stringify(pillState));
await page.evaluate(() => { document.getElementById('message-list').scrollTop = document.getElementById('message-list').scrollHeight; });
await page.waitForTimeout(1000);
const pillGone = await page.evaluate(() => !document.querySelector('.new-msg-pill'));
ok('A8 manual scroll to bottom auto-clears pill', pillGone === true, `gone=${pillGone}`);

// B. desktop sidebar collapse/reopen
await page.click('#sidebarClose');
await page.waitForTimeout(400);
const sbClosed = await page.evaluate(() => ({
  w: document.getElementById('sidebar').getBoundingClientRect().width,
  inert: document.getElementById('sidebar').inert,
  ah: document.getElementById('sidebar').getAttribute('aria-hidden'),
}));
ok('B1 desktop sidebar collapse 280->0 + inert/aria-hidden', sbClosed.w === 0 && sbClosed.inert === true && sbClosed.ah === 'true', JSON.stringify(sbClosed));
await page.click('#sidebarToggle');
await page.waitForTimeout(400);
const sbOpen = await page.evaluate(() => ({
  w: document.getElementById('sidebar').getBoundingClientRect().width,
  inert: document.getElementById('sidebar').inert,
  ah: document.getElementById('sidebar').getAttribute('aria-hidden'),
}));
ok('B2 desktop sidebar reopen 0->280 + attrs reset', sbOpen.w === 280 && sbOpen.inert === false && sbOpen.ah === 'false', JSON.stringify(sbOpen));

// C. drawer modal + focus trap + tabs
await page.click('#drawerToggle');
await page.waitForTimeout(350);
const drawerOpen = await page.evaluate(() => ({
  shellInert: document.getElementById('appShell').inert,
  drawerInert: document.getElementById('contextDrawer').inert,
  drawerAH: document.getElementById('contextDrawer').getAttribute('aria-hidden'),
  focus: document.activeElement.id,
  expanded: document.getElementById('drawerToggle').getAttribute('aria-expanded'),
  role: document.getElementById('contextDrawer').getAttribute('role'),
  modal: document.getElementById('contextDrawer').getAttribute('aria-modal'),
}));
ok('C1 drawer open = true modal (app-shell inert) + focus to close btn', drawerOpen.shellInert === true && drawerOpen.drawerInert === false && drawerOpen.drawerAH === 'false' && drawerOpen.focus === 'drawerClose', JSON.stringify(drawerOpen));
ok('C2 drawer semantics role=dialog/aria-modal/aria-expanded', drawerOpen.role === 'dialog' && drawerOpen.modal === 'true' && drawerOpen.expanded === 'true', JSON.stringify(drawerOpen));

await page.click('#tab-goal');
await page.waitForTimeout(150);
const tabClick = await page.evaluate(() => ({
  selected: document.getElementById('tab-goal').getAttribute('aria-selected'),
  goalHidden: document.getElementById('session-goal-drawer').hidden,
  partHidden: document.getElementById('panel-participants').hidden,
  gameTabHidden: document.getElementById('tab-game').hidden,
  draftsTabHidden: document.getElementById('tab-drafts').hidden,
}));
ok('C3 tab click switches panel for real', tabClick.selected === 'true' && tabClick.goalHidden === false && tabClick.partHidden === true, JSON.stringify(tabClick));
ok('C4 conditional tabs hidden initially (game/drafts)', tabClick.gameTabHidden === true && tabClick.draftsTabHidden === true, JSON.stringify(tabClick));

// C10/C11: goal controller started without legacy chrome + shell 焦点所有权
const goalStarted = await page.evaluate(async () => {
  const calls = [];
  const originalFetch = window.fetch;
  window.fetch = (...args) => {
    calls.push(String(args[0]));
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  const form = document.getElementById('session-goal-form');
  const ev = new Event('submit', { cancelable: true, bubbles: true });
  form.dispatchEvent(ev);
  await new Promise((resolve) => setTimeout(resolve, 80));
  window.fetch = originalFetch;
  return {
    prevented: ev.defaultPrevented,
    goalCall: calls.some((url) => url.includes('/goal')),
  };
});
ok('C10 goal controller started: form submit bound + goal command attempted', goalStarted.prevented === true && goalStarted.goalCall === true, JSON.stringify(goalStarted));
await page.evaluate(() => window.caffShell.openTab('session-goal-drawer'));
await page.waitForTimeout(80);
const goalFocus = await page.evaluate(() => ({
  active: document.activeElement && document.activeElement.id,
  tab: window.caffShell.activeTab(),
}));
ok('C11 fromShell open keeps shell focus ownership (no steal into objective)', goalFocus.tab === 'session-goal-drawer' && goalFocus.active !== 'session-goal-objective', JSON.stringify(goalFocus));

await page.focus('#tab-goal');
await page.keyboard.press('ArrowRight');
const rove = await page.evaluate(() => ({ focus: document.activeElement.id, sel: document.activeElement.getAttribute('aria-selected'), memHidden: document.getElementById('summary-memory-drawer').hidden }));
ok('C5 ArrowRight roving + panel sync', rove.focus === 'tab-memory' && rove.sel === 'true' && rove.memHidden === false, JSON.stringify(rove));
await page.keyboard.press('End');
const endKey = await page.evaluate(() => document.activeElement.id);
ok('C6 End jumps to last visible tab (skips hidden)', endKey === 'tab-context', endKey);

await page.focus('#drawerClose');
await page.keyboard.press('Shift+Tab');
const wrapBack = await page.evaluate(() => {
  const el = document.activeElement;
  return { id: el.id, inDrawer: document.getElementById('contextDrawer').contains(el), visible: el.getClientRects().length > 0 };
});
ok('C7 trap: Shift+Tab wraps first->last (visible, in drawer)', wrapBack.inDrawer && wrapBack.visible && wrapBack.id !== 'drawerClose', JSON.stringify(wrapBack));
await page.keyboard.press('Tab');
const wrapFwd = await page.evaluate(() => document.activeElement.id);
ok('C8 trap: Tab wraps last->drawerClose', wrapFwd === 'drawerClose', wrapFwd);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const escDrawer = await page.evaluate(() => ({
  ds: document.body.dataset.drawer,
  shellInert: document.getElementById('appShell').inert,
  drawerInert: document.getElementById('contextDrawer').inert,
  focus: document.activeElement.id,
}));
ok('C9 Escape closes drawer + inert reset + focus returned', escDrawer.ds === 'closed' && escDrawer.shellInert === false && escDrawer.drawerInert === true && escDrawer.focus === 'drawerToggle', JSON.stringify(escDrawer));

// L. 条件 tab 消失状态机（open + closed 两态，真实浏览器焦点）
await page.evaluate(() => {
  window.caffShell.setTabVisible('panel-game', true);
  window.caffShell.openTab('panel-game');
  document.getElementById('tab-game').focus();
  window.caffShell.setTabVisible('panel-game', false);
});
const hideOpen = await page.evaluate(() => ({
  active: document.activeElement && document.activeElement.id,
  activeTab: window.caffShell.activeTab(),
  gamePanelHidden: document.getElementById('panel-game').hidden,
  participantsSelected: document.getElementById('tab-participants').getAttribute('aria-selected'),
}));
ok('L1 hide active tab while drawer OPEN: focus migrates to fallback tab', hideOpen.active === 'tab-participants' && hideOpen.activeTab === 'panel-participants' && hideOpen.gamePanelHidden === true && hideOpen.participantsSelected === 'true', JSON.stringify(hideOpen));

await page.evaluate(() => {
  window.caffShell.closeDrawer();
  window.caffShell.setTabVisible('panel-game', true);
  window.caffShell.openTab('panel-game');
  window.caffShell.closeDrawer();
  window.caffShell.setTabVisible('panel-game', false);
  document.getElementById('drawerToggle').click();
});
await page.waitForTimeout(250);
const hideClosed = await page.evaluate(() => {
  const visibleSelected = Array.from(document.querySelectorAll('.drawer-tabs [role="tab"]'))
    .filter((t) => !t.hidden && t.getAttribute('aria-selected') === 'true');
  return {
    activeTab: window.caffShell.activeTab(),
    gameTabHidden: document.getElementById('tab-game').hidden,
    gamePanelHidden: document.getElementById('panel-game').hidden,
    visibleSelectedCount: visibleSelected.length,
    drawerOpen: document.body.dataset.drawer,
  };
});
ok('L2 hide current tab while drawer CLOSED: reopen has exactly one visible selected tab', hideClosed.activeTab !== 'panel-game' && hideClosed.gamePanelHidden === true && hideClosed.visibleSelectedCount === 1, JSON.stringify(hideClosed));
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// D. keyboard focus order (desktop, sidebar closed)
const sidebarNow = await page.evaluate(() => document.body.dataset.sidebar);
if (sidebarNow === 'open') {
  await page.click('#sidebarClose');
  await page.waitForTimeout(350);
}
const tabSeq = [];
await page.evaluate(() => { document.body.focus(); });
for (let i = 0; i < 14; i += 1) {
  await page.keyboard.press('Tab');
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    return el.id || el.className || el.tagName;
  });
  tabSeq.push(info);
}
const normalized = [...tabSeq];
const railIdx = normalized.findIndex((s) => s === 'rail-link');
const rotated = railIdx > 0 ? [...normalized.slice(railIdx), ...normalized.slice(0, railIdx)] : normalized;
const rotStr = rotated.join(' > ');
const order = ['rail-link', 'rail-settings-button', 'sidebarToggle', 'refresh-button', 'drawerToggle', 'message-list', 'composer-input'];
let cursor = -1;
let seqOk = true;
for (const token of order) {
  const idx = rotStr.indexOf(token, cursor + 1);
  if (idx < 0) { seqOk = false; break; }
  cursor = idx;
}
ok('D1 focus order rail->sidebarToggle->drawerToggle->messageList->composer (cyclic)', seqOk, rotStr);

// E. 全量触控目标 >=44px（含注入的 tool-trace toggle / compact-icon-button）
await page.evaluate(() => {
  const card = document.createElement('div');
  card.className = 'message-card assistant';
  card.innerHTML = '<div class="message-body"><button class="message-tool-trace-toggle" type="button">工具链路</button>'
    + '<button class="primary-button compact-icon-button" type="button">重试</button></div>';
  document.getElementById('message-list').appendChild(card);
});
await page.waitForTimeout(150);
const touch = await page.evaluate(() => {
  const picks = [
    ...document.querySelectorAll('.rail-link, .rail-button'),
    document.getElementById('sidebarToggle'),
    document.getElementById('drawerToggle'),
    document.getElementById('refresh-button'),
    document.getElementById('send-button'),
    document.getElementById('stop-button'),
    ...document.querySelectorAll('.drawer-tabs [role=tab]:not([hidden])'),
    ...document.querySelectorAll('.message-tool-trace-toggle, .compact-icon-button'),
    ...document.querySelectorAll('.option-card label'),
  ].filter(Boolean).filter((el) => el.getClientRects().length > 0);
  return picks.map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id || el.getAttribute('aria-label') || el.className, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  });
});
const touchBad = touch.filter((t) => t.w < 44 || t.h < 44);
ok('E1 all touch targets >=44px (rail/header/tabs/send/stop/tool-trace/retry/option-card)', touchBad.length === 0, touchBad.length ? JSON.stringify(touchBad) : `${touch.length} targets ok`);

// F. breakpoint reentry (desktop->narrow focus takeover)
await page.click('#sidebarToggle');
await page.waitForTimeout(300);
await page.click('#composer-input');
await page.setViewportSize({ width: 820, height: 900 });
await page.waitForTimeout(450);
const reentry = await page.evaluate(() => ({
  ds: document.body.dataset.sidebar,
  sidebarW: document.getElementById('sidebar').getBoundingClientRect().width,
  railInert: document.querySelector('.rail').inert,
  mainInert: document.querySelector('.main').inert,
  focus: document.activeElement.id,
}));
ok('F1 reentry: persistent open stays open, becomes modal', reentry.ds === 'open' && reentry.sidebarW === 280 && reentry.railInert === true && reentry.mainInert === true, JSON.stringify(reentry));
ok('F2 reentry: focus in background -> taken into sidebarClose', reentry.focus === 'sidebarClose', `focus=${reentry.focus}`);

// G. narrow sidebar modal (820)
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const escSidebar = await page.evaluate(() => ({
  ds: document.body.dataset.sidebar,
  railInert: document.querySelector('.rail').inert,
  mainInert: document.querySelector('.main').inert,
  focus: document.activeElement.id,
}));
ok('G1 narrow Escape closes sidebar + bg restored + focus to snapshot target (composer)', escSidebar.ds === 'closed' && escSidebar.railInert === false && escSidebar.mainInert === false && escSidebar.focus === 'composer-input', JSON.stringify(escSidebar));

await page.click('#sidebarToggle');
await page.waitForTimeout(350);
const narrowOpen = await page.evaluate(() => ({
  focus: document.activeElement.id,
  railInert: document.querySelector('.rail').inert,
  mainInert: document.querySelector('.main').inert,
}));
ok('G2 narrow open = modal: focus into sidebarClose + bg inert', narrowOpen.focus === 'sidebarClose' && narrowOpen.railInert === true && narrowOpen.mainInert === true, JSON.stringify(narrowOpen));

const trail = [];
for (let i = 0; i < 10; i += 1) {
  await page.keyboard.press('Tab');
  const inSidebar = await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement));
  trail.push(inSidebar);
}
ok('G3 narrow sidebar Tab x10 zero escape', trail.every(Boolean), JSON.stringify(trail));

// H. mobile 375
await page.setViewportSize({ width: 375, height: 800 });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const mobile = await page.evaluate(() => {
  const rail = document.querySelector('.rail').getBoundingClientRect();
  const composer = document.getElementById('composer-form').getBoundingClientRect();
  return {
    railH: Math.round(rail.height), railTop: Math.round(rail.top), vh: innerHeight,
    composerVisible: composer.bottom <= innerHeight,
  };
});
ok('H1 375: rail bottom bar 56px + composer reachable', mobile.railH === 56 && mobile.railTop === mobile.vh - 56 && mobile.composerVisible, JSON.stringify(mobile));
await page.click('#drawerToggle');
await page.waitForTimeout(350);
const drawerW = await page.evaluate(() => Math.round(document.getElementById('contextDrawer').getBoundingClientRect().width));
ok('H2 375: drawer full-sheet 100vw', drawerW === 375, `w=${drawerW}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// M. 窄档 header 溢出：状态文本不得覆盖操作按钮（375 + 320）
async function headerOverlapCheck(width) {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(350);
  return page.evaluate(() => {
    const texts = ['.titles', '.status-line', '#runtime-pill', '#conversation-meta', '.chat-header h2']
      .map((sel) => document.querySelector(sel))
      .filter((el) => el && el.getClientRects().length > 0)
      .map((el) => ({ sel: el.id || el.className || el.tagName, r: el.getBoundingClientRect() }));
    const buttons = ['#sidebarToggle', '#refresh-button', '#drawerToggle']
      .map((sel) => ({ sel, r: document.getElementById(sel.slice(1)).getBoundingClientRect() }));
    const overlaps = [];
    for (const t of texts) {
      for (const b of buttons) {
        const ox = Math.min(t.r.right, b.r.right) - Math.max(t.r.left, b.r.left);
        const oy = Math.min(t.r.bottom, b.r.bottom) - Math.max(t.r.top, b.r.top);
        if (ox > 1 && oy > 1) {
          overlaps.push({ text: t.sel, button: b.sel, ox: Math.round(ox * 10) / 10 });
        }
      }
    }
    return overlaps;
  });
}
const ov375 = await headerOverlapCheck(375);
ok('M1 375 header: status text does not overlap action buttons', ov375.length === 0, JSON.stringify(ov375));
const ov320 = await headerOverlapCheck(320);
ok('M2 320 header: status text does not overlap action buttons', ov320.length === 0, JSON.stringify(ov320));

// I. reduced-motion
const page2 = await newTrackedPage({ width: 1440, height: 900 }, { reducedMotion: 'reduce' });
await page2.goto(APP, { waitUntil: 'load' });
await page2.waitForTimeout(800);
const rm = await page2.evaluate(() => ({
  mq: matchMedia('(prefers-reduced-motion: reduce)').matches,
  sidebarTransition: getComputedStyle(document.getElementById('sidebar')).transitionDuration,
  scrollBehavior: getComputedStyle(document.getElementById('message-list')).scrollBehavior,
}));
ok('I1 reduced-motion: transitions off + smooth scroll off', rm.mq === true && rm.sidebarTransition === '0s' && rm.scrollBehavior === 'auto', JSON.stringify(rm));

// K. 会话列表语义 + 键盘切换（真实创建临时会话，结束后清理）
const createdIds = [];
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const sidebarState = await page.evaluate(() => document.body.dataset.sidebar);
  if (sidebarState !== 'open') {
    await page.click('#sidebarToggle');
    await page.waitForTimeout(300);
  }
  for (const title of ['UI-VERIFY-A', 'UI-VERIFY-B']) {
    await page.fill('#new-conversation-title', title);
    await page.click('#new-conversation-form button[type="submit"]');
    await page.waitForTimeout(700);
    const id = await page.evaluate((t) => {
      const btn = Array.from(document.querySelectorAll('#conversation-list .conversation-item'))
        .find((el) => el.textContent.includes(t));
      return btn ? btn.dataset.id : null;
    }, title);
    if (id) createdIds.push(id);
  }
  const listSemantics = await page.evaluate(() => {
    const list = document.getElementById('conversation-list');
    const li = list.querySelector('li');
    const btn = li ? li.querySelector('button.conversation-item') : null;
    return {
      tag: list.tagName,
      liCount: list.querySelectorAll('li').length,
      hasButton: Boolean(btn),
      focusable: btn ? btn.tabIndex : -1,
    };
  });
  ok('K1 conversation list ul>li>button semantics', listSemantics.tag === 'UL' && listSemantics.liCount >= 2 && listSemantics.hasButton && listSemantics.focusable === 0, JSON.stringify(listSemantics));

  if (createdIds.length >= 2) {
    await page.evaluate((id) => {
      document.querySelector(`#conversation-list .conversation-item[data-id="${id}"]`).click();
    }, createdIds[0]);
    await page.waitForTimeout(600);
    await page.evaluate((id) => {
      document.querySelector(`#conversation-list .conversation-item[data-id="${id}"]`).focus();
    }, createdIds[1]);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const switched = await page.evaluate(() => ({
      title: document.getElementById('conversation-title-display').textContent,
      activeBtn: document.querySelector('#conversation-list .conversation-item.active')
        && document.querySelector('#conversation-list .conversation-item.active').textContent.slice(0, 12),
    }));
    ok('K2 keyboard Enter on conversation button switches room', /UI-VERIFY-B/.test(switched.title || '') || /UI-VERIFY-B/.test(switched.activeBtn || ''), JSON.stringify(switched));
  } else {
    ok('K2 keyboard Enter on conversation button switches room', false, `only ${createdIds.length} temp rooms created`);
  }
} finally {
  for (const id of createdIds) {
    await page.evaluate(async (cid) => {
      await fetch(`/api/conversations/${cid}`, { method: 'DELETE' }).catch(() => {});
    }, id);
  }
  await page.waitForTimeout(400);
}

// J. runtime health
const runtimePill = await page.evaluate(() => document.getElementById('runtime-pill').textContent);
ok('J1 runtime pill updated (not connecting)', !runtimePill.includes('正在连接'), runtimePill.slice(0, 60));
ok('J2 no pageerror', page.pageErrors.length === 0 && page2.pageErrors.length === 0, JSON.stringify([...page.pageErrors, ...page2.pageErrors]).slice(0, 300));
const realConsoleErrors = page.consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('404'));
ok('J3 no console error', realConsoleErrors.length === 0, JSON.stringify({ errors: realConsoleErrors.slice(0, 5), bad: page.badResponses.slice(0, 8) }).slice(0, 500));
ok('J4 404 resource identified (expect favicon only)', page.notFound.every((u) => u.includes('favicon')), JSON.stringify(page.notFound));

// evidence screenshots
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'ui-v2-1440-long.png') });
await page.click('#drawerToggle');
await page.waitForTimeout(350);
await page.click('#tab-goal');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(OUT, 'ui-v2-1440-drawer-goal.png') });
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 820, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'ui-v2-820.png') });
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'ui-v2-375.png') });

await browser.close();

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== ${passed}/${results.length} PASS ===`);
fs.writeFileSync(path.join(OUT, 'ui-v2-results.json'), JSON.stringify({ passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
