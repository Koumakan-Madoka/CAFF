// CAFF AppShell UI 契约验证（真实浏览器）。
// 用法:
//   node scripts/verify-ui.mjs
// 环境变量:
//   CAFF_VERIFY_APP  显式本地目标（仅 loopback）；未设置时自起隔离服务
//   CAFF_VERIFY_OUT  证据输出目录（默认 <os.tmpdir>/caff-ui-verify/<run-id>）
// 退出码: 0 全绿 / 1 有 FAIL / 2 缺少 repo-owned playwright-core

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyManagementPages } from './ui/verify-management-pages.mjs';
import { verifyThemeIcons } from './ui/verify-theme-icons.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('repo-owned playwright-core 未安装：请先运行 npm install');
  process.exit(2);
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = randomUUID().slice(0, 8);
const TITLE_PREFIX = `UI-VERIFY-${RUN_ID}`;
const OUT = process.env.CAFF_VERIFY_OUT || path.join(os.tmpdir(), 'caff-ui-verify', RUN_ID);
const MANAGEMENT_SCREENSHOT = 'ui-v2-1440-management.png';
fs.mkdirSync(OUT, { recursive: true });
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertLoopbackTarget(value) {
  const target = new URL('/', value);
  if (!['http:', 'https:'].includes(target.protocol) || !LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) {
    throw new Error(`CAFF_VERIFY_APP must target a loopback HTTP(S) app, received: ${target.href}`);
  }
  return target.href;
}

async function findFreePort() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const candidate = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(candidate));
    });
  });
  if (port === 3003 || port === 3004 || port === 6399) {
    return findFreePort();
  }
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) {
    const forced = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await Promise.race([forced, delay(3000)]);
  }
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`isolated app exited (${child.exitCode})\n${logs.stderr}\n${logs.stdout}`);
    }
    try {
      const response = await fetch(`${baseUrl}api/bootstrap`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server has not bound the port yet.
    }
    await delay(100);
  }
  throw new Error(`isolated app did not become ready\n${logs.stderr}\n${logs.stdout}`);
}

async function startIsolatedApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `caff-ui-${RUN_ID}-`));
  const port = await findFreePort();
  const logs = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['build/lib/app-server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CAFF_DISABLE_ENV_LOCAL: '1',
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: tempDir,
      PI_SQLITE_PATH: path.join(tempDir, 'ui-verification.sqlite'),
      FEISHU_APP_ID: '',
      FEISHU_APP_SECRET: '',
      FEISHU_CONNECTION_MODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { logs.stdout = `${logs.stdout}${chunk}`.slice(-8000); });
  child.stderr.on('data', (chunk) => { logs.stderr = `${logs.stderr}${chunk}`.slice(-8000); });
  const baseUrl = `http://127.0.0.1:${port}/`;
  try {
    await waitForServer(baseUrl, child, logs);
    return { child, tempDir, baseUrl, logs };
  } catch (error) {
    await stopChild(child);
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function createVerificationConversation(baseUrl, title) {
  const response = await fetch(`${baseUrl}api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, type: 'standard' }),
  });
  if (!response.ok) {
    throw new Error(`failed to create verification conversation: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  return payload.conversation;
}

async function deleteVerificationConversation(baseUrl, conversationId) {
  const response = await fetch(`${baseUrl}api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
  return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 240) };
}

async function verificationResidue(baseUrl) {
  const response = await fetch(`${baseUrl}api/conversations`);
  if (!response.ok) {
    throw new Error(`failed to list verification conversations: ${response.status}`);
  }
  const payload = await response.json();
  return (Array.isArray(payload.conversations) ? payload.conversations : [])
    .filter((conversation) => String(conversation && conversation.title || '').startsWith(TITLE_PREFIX));
}

async function emergencyCleanupRun(baseUrl) {
  const residue = await verificationResidue(baseUrl);
  const deletions = [];
  for (const conversation of residue) {
    deletions.push(await deleteVerificationConversation(baseUrl, conversation.id));
  }
  const failed = deletions.filter((item) => !item.ok);
  const remaining = await verificationResidue(baseUrl);
  if (failed.length > 0 || remaining.length > 0) {
    throw new Error(`verification cleanup failed: ${JSON.stringify({ failed, remaining })}`);
  }
  return { deleted: deletions.length };
}

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
};

let APP = '';
let browser = null;
let managedApp = null;
let baselineConversationId = '';
let exitCode = 1;

try {
  if (process.env.CAFF_VERIFY_APP) {
    APP = assertLoopbackTarget(process.env.CAFF_VERIFY_APP);
  } else {
    managedApp = await startIsolatedApp();
    APP = managedApp.baseUrl;
  }
  const baselineConversation = await createVerificationConversation(APP, `${TITLE_PREFIX}-BASE`);
  baselineConversationId = baselineConversation.id;
  browser = await chromium.launch({ channel: 'msedge', headless: true });

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

let injectedMessageSequence = 0;
async function injectMessages(page, count) {
  const ids = Array.from({ length: count }, () => `${TITLE_PREFIX}-MSG-${++injectedMessageSequence}`);
  await page.evaluate((messageIds) => {
    const list = document.getElementById('message-list');
    messageIds.forEach((id, index) => {
      const el = document.createElement('div');
      el.className = 'message-card assistant';
      el.dataset.messageId = id;
      el.innerHTML = `<div class="message-body"><p>contract test message ${index} - padding the scroll area.</p></div>`;
      list.appendChild(el);
    });
  }, ids);
  await page.waitForTimeout(400);
}

async function renderEvidenceConversation(page, count = 28) {
  const ids = Array.from({ length: count }, () => `${TITLE_PREFIX}-EVIDENCE-${++injectedMessageSequence}`);
  await page.evaluate((messageIds) => {
    const list = document.getElementById('message-list');
    const fragment = document.createDocumentFragment();
    messageIds.forEach((id, index) => {
      const isUser = index % 4 === 1;
      const card = document.createElement('article');
      card.className = `message-card ${isUser ? 'user' : 'assistant'}`;
      card.dataset.messageId = id;
      if (!isUser) {
        card.style.setProperty('--agent-color', index % 3 === 0 ? '#2a9d8f' : '#ef7d57');
      }
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const sender = document.createElement('span');
      sender.className = 'message-sender';
      sender.textContent = isUser ? '你' : (index % 3 === 0 ? '砚砚' : '烁烁');
      const time = document.createElement('span');
      time.className = 'message-time';
      time.textContent = `14:${String(index).padStart(2, '0')}`;
      meta.append(sender, time);
      const body = document.createElement('div');
      body.className = 'message-body';
      const paragraph = document.createElement('p');
      paragraph.textContent = isUser
        ? `第 ${index + 1} 条：继续核对长会话中的滚动位置与输入框可达性。`
        : `第 ${index + 1} 条回复：消息区独立滚动，标题、主要操作与 composer 始终留在视口内。`;
      body.appendChild(paragraph);
      if (!isUser && index % 6 === 0) {
        const trace = document.createElement('button');
        trace.type = 'button';
        trace.className = 'message-tool-trace-toggle';
        trace.textContent = '▸ 2 次工具调用';
        body.appendChild(trace);
      }
      card.append(meta, body);
      fragment.appendChild(card);
    });
    list.replaceChildren(fragment);
  }, ids);
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const list = document.getElementById('message-list');
    list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    list.dispatchEvent(new Event('scroll'));
    document.getElementById('new-message-pill').hidden = true;
    const toast = document.getElementById('toast');
    if (toast) toast.classList.add('hidden');
  });
  await page.waitForTimeout(150);
}

async function captureWalkthroughVideo() {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
  });
  const evidencePage = await context.newPage();
  const video = evidencePage.video();
  try {
    await evidencePage.goto(APP, { waitUntil: 'load' });
    await waitAppReady(evidencePage);
    await renderEvidenceConversation(evidencePage);
    await evidencePage.waitForTimeout(1500);
    await evidencePage.evaluate(() => {
      const list = document.getElementById('message-list');
      list.scrollTo({ top: 0, behavior: 'instant' });
      list.dispatchEvent(new Event('scroll'));
    });
    await injectMessages(evidencePage, 2);
    await evidencePage.waitForTimeout(1700);
    await evidencePage.click('#new-message-pill');
    await evidencePage.waitForTimeout(1700);
    await evidencePage.click('#drawerToggle');
    await evidencePage.waitForTimeout(1400);
    await evidencePage.click('#tab-goal');
    await evidencePage.waitForTimeout(1500);
    await evidencePage.click('#tab-context');
    await evidencePage.waitForTimeout(1400);
    await evidencePage.keyboard.press('Escape');
    await evidencePage.waitForTimeout(700);
    await evidencePage.setViewportSize({ width: 375, height: 800 });
    await evidencePage.waitForTimeout(1600);
    await evidencePage.click('#sidebarToggle');
    await evidencePage.waitForTimeout(1800);
    await evidencePage.keyboard.press('Escape');
    await evidencePage.waitForTimeout(700);
  } finally {
    await context.close();
  }
  if (!video) {
    throw new Error('Playwright did not create a walkthrough video');
  }
  const sourcePath = await video.path();
  const targetPath = path.join(OUT, 'ui-v2-walkthrough.webm');
  if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
    fs.renameSync(sourcePath, targetPath);
  }
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
  const sampleCard = l.querySelector(':scope > .message-card');
  const sampleBody = sampleCard ? sampleCard.querySelector('.message-body') : null;
  const cardRect = sampleCard ? sampleCard.getBoundingClientRect() : null;
  const bodyRect = sampleBody ? sampleBody.getBoundingClientRect() : null;
  return {
    scrollH: l.scrollHeight, clientH: l.clientHeight,
    docScrollH: document.documentElement.scrollHeight, vh: innerHeight,
    headerVisible: header.top >= 0 && header.bottom <= innerHeight,
    composerVisible: composer.top >= 0 && composer.bottom <= innerHeight,
    bodyContained: Boolean(cardRect && bodyRect && bodyRect.top >= cardRect.top && bodyRect.bottom <= cardRect.bottom + 1),
  };
});
ok('A4 message list real overflow + message body remains visible', scroll.scrollH > scroll.clientH + 200 && scroll.bodyContained, JSON.stringify(scroll));
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
  return pill ? { shown: !pill.hidden, h: pill.getBoundingClientRect().height, outsideList: !document.getElementById('message-list').contains(pill) } : { shown: false };
});
ok('A7 off-bottom new-message pill shown outside renderer, >=44px', pillState.shown && pillState.h >= 44 && pillState.outsideList, JSON.stringify(pillState));
await page.evaluate(() => {
  const list = document.getElementById('message-list');
  list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
  list.dispatchEvent(new Event('scroll'));
});
await page.waitForTimeout(1000);
const pillGone = await page.evaluate(() => document.querySelector('.new-msg-pill').hidden);
ok('A8 manual scroll to bottom auto-clears pill', pillGone === true, `gone=${pillGone}`);

await page.evaluate(() => {
  const list = document.getElementById('message-list');
  list.scrollTo({ top: 0, behavior: 'instant' });
  list.dispatchEvent(new Event('scroll'));
});
await injectMessages(page, 1);
const beforeReplacementPill = await page.evaluate(() => !document.querySelector('.new-msg-pill').hidden);
await page.evaluate(() => {
  const list = document.getElementById('message-list');
  const replacements = Array.from(list.querySelectorAll(':scope > .message-card'))
    .map((card) => card.cloneNode(true));
  list.replaceChildren(...replacements);
});
await page.waitForTimeout(200);
const replacementPill = await page.evaluate(() => {
  const list = document.getElementById('message-list');
  const pill = document.querySelector('.new-msg-pill');
  return { shown: !pill.hidden, outsideList: !list.contains(pill) };
});
ok('A9 renderer replacement preserves shell-owned new-message pill', beforeReplacementPill && replacementPill.shown && replacementPill.outsideList, JSON.stringify({ beforeReplacementPill, ...replacementPill }));

await page.evaluate(() => {
  const list = document.getElementById('message-list');
  list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
  list.dispatchEvent(new Event('scroll'));
});
await page.waitForTimeout(150);
await page.evaluate(() => {
  const list = document.getElementById('message-list');
  list.scrollTo({ top: 0, behavior: 'instant' });
  list.dispatchEvent(new Event('scroll'));
  const card = list.querySelector('.message-card');
  const trace = document.createElement('div');
  trace.className = 'message-tool-trace';
  trace.textContent = 'trace expanded';
  card.appendChild(trace);
});
await page.waitForTimeout(200);
const tracePill = await page.evaluate(() => document.querySelector('.new-msg-pill').hidden);
ok('A10 tool-trace subtree mutation does not create new-message signal', tracePill === true, `hidden=${tracePill}`);

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
for (let i = 0; i < 20; i += 1) {
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
const order = ['rail-link', 'theme-toggle', 'rail-settings-button', 'sidebarToggle', 'refresh-button', 'drawerToggle', 'message-list', 'composer-input'];
let cursor = -1;
let seqOk = true;
for (const token of order) {
  const idx = rotStr.indexOf(token, cursor + 1);
  if (idx < 0) { seqOk = false; break; }
  cursor = idx;
}
ok('D1 focus order rail->theme->sidebarToggle->drawerToggle->messageList->composer (cyclic)', seqOk, rotStr);

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
const caseTitlePrefix = `${TITLE_PREFIX}-CASE`;
try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const sidebarState = await page.evaluate(() => document.body.dataset.sidebar);
  if (sidebarState !== 'open') {
    await page.click('#sidebarToggle');
    await page.waitForTimeout(300);
  }
  for (const title of [`${caseTitlePrefix}-A`, `${caseTitlePrefix}-B`]) {
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
    ok('K2 keyboard Enter on conversation button switches room', String(switched.title || '').includes(`${caseTitlePrefix}-B`) || String(switched.activeBtn || '').includes(`${caseTitlePrefix}-B`), JSON.stringify(switched));
  } else {
    ok('K2 keyboard Enter on conversation button switches room', false, `only ${createdIds.length} temp rooms created`);
  }

  const composerClear = await page.evaluate(async () => {
    const input = document.getElementById('composer-input');
    const form = document.getElementById('composer-form');
    input.value = 'x'.repeat(1400);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = input.getBoundingClientRect().height;
    input.value = '/goal';
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 180));
    return { before, after: input.getBoundingClientRect().height, value: input.value };
  });
  ok('K3 successful programmatic clear collapses composer height', composerClear.before >= 150 && composerClear.after <= 60 && composerClear.value === '', JSON.stringify(composerClear));

  const composerRestore = await page.evaluate(async () => {
    const input = document.getElementById('composer-input');
    const form = document.getElementById('composer-form');
    const originalFetch = window.fetch;
    window.fetch = (resource, init = {}) => {
      const url = typeof resource === 'string' ? resource : resource.url;
      if (/\/api\/conversations\/[^/]+\/messages$/.test(url) && String(init.method || 'GET').toUpperCase() === 'POST') {
        return Promise.reject(new Error('UI_VERIFY_EXPECTED_FAILURE'));
      }
      return originalFetch(resource, init);
    };
    try {
      input.value = 'y'.repeat(1400);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const before = input.getBoundingClientRect().height;
      form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 280));
      const result = { before, after: input.getBoundingClientRect().height, valueLength: input.value.length };
      window.caffShell.setComposerValue('');
      return result;
    } finally {
      window.fetch = originalFetch;
    }
  });
  ok('K4 failed send restore re-expands composer height', composerRestore.before >= 150 && composerRestore.after >= 150 && composerRestore.valueLength === 1400, JSON.stringify(composerRestore));
} finally {
  const cleanupResults = [];
  for (const id of createdIds) {
    const cleanup = await page.evaluate(async (cid) => {
      const response = await fetch(`/api/conversations/${encodeURIComponent(cid)}`, { method: 'DELETE' });
      return { id: cid, ok: response.ok, status: response.status, body: (await response.text()).slice(0, 240) };
    }, id);
    cleanupResults.push(cleanup);
  }
  await page.waitForTimeout(400);
  ok('K5 temporary conversation DELETE requests all succeed', cleanupResults.length === createdIds.length && cleanupResults.every((item) => item.ok), JSON.stringify(cleanupResults));
  const caseResidue = await page.evaluate(async (prefix) => {
    const response = await fetch('/api/conversations');
    const payload = await response.json();
    return (Array.isArray(payload.conversations) ? payload.conversations : [])
      .filter((conversation) => String(conversation && conversation.title || '').startsWith(prefix));
  }, caseTitlePrefix);
  ok('K6 temporary conversation cleanup leaves zero residue', caseResidue.length === 0, JSON.stringify(caseResidue));
}

// J. runtime health
const runtimePill = await page.evaluate(() => document.getElementById('runtime-pill').textContent);
ok('J1 runtime pill updated (not connecting)', !runtimePill.includes('正在连接'), runtimePill.slice(0, 60));
ok('J2 no pageerror', page.pageErrors.length === 0 && page2.pageErrors.length === 0, JSON.stringify([...page.pageErrors, ...page2.pageErrors]).slice(0, 300));
const realConsoleErrors = page.consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('404'));
ok('J3 no console error', realConsoleErrors.length === 0, JSON.stringify({ errors: realConsoleErrors.slice(0, 5), bad: page.badResponses.slice(0, 8) }).slice(0, 500));
ok('J4 404 resource identified (expect favicon only)', page.notFound.every((u) => u.includes('favicon')), JSON.stringify(page.notFound));

await verifyManagementPages({
  browser,
  baseUrl: APP,
  ok,
  outputDir: OUT,
  screenshotName: MANAGEMENT_SCREENSHOT,
});

await verifyThemeIcons({
  browser,
  baseUrl: APP,
  ok,
});

// evidence screenshots
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => window.CaffTheme?.setTheme('light'));
await page.waitForTimeout(400);
await renderEvidenceConversation(page);
if (await page.evaluate(() => document.body.dataset.sidebar !== 'open')) {
  await page.click('#sidebarToggle');
  await page.waitForTimeout(350);
}
await page.screenshot({ path: path.join(OUT, 'ui-v2-1440-long.png') });
await page.click('#sidebarClose');
await page.waitForTimeout(350);
await page.setViewportSize({ width: 375, height: 800 });
await page.evaluate(() => window.CaffTheme?.setTheme('dark'));
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'ui-v2-375.png') });
await captureWalkthroughVideo();

const baselineDeletion = await deleteVerificationConversation(APP, baselineConversationId);
ok('N1 baseline verification conversation DELETE succeeds', baselineDeletion.ok, JSON.stringify(baselineDeletion));
if (baselineDeletion.ok) {
  baselineConversationId = '';
}
const finalResidue = await verificationResidue(APP);
ok('N2 verification run leaves zero verification conversations', finalResidue.length === 0, JSON.stringify(finalResidue));

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== ${passed}/${results.length} PASS ===`);
fs.writeFileSync(path.join(OUT, 'ui-v2-results.json'), JSON.stringify({ runId: RUN_ID, passed, total: results.length, results }, null, 2));
exitCode = passed === results.length ? 0 : 1;
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  if (managedApp) {
    console.error(managedApp.logs.stderr);
    console.error(managedApp.logs.stdout);
  }
  exitCode = 1;
} finally {
  if (browser) {
    await browser.close().catch(() => {});
  }
  if (APP) {
    try {
      const cleanup = await emergencyCleanupRun(APP);
      baselineConversationId = '';
      if (cleanup.deleted > 0) {
        console.error(`emergency cleanup removed ${cleanup.deleted} run-owned conversation(s)`);
      }
    } catch (error) {
      console.error(error && error.stack ? error.stack : error);
      exitCode = 1;
    }
  }
  if (managedApp) {
    await stopChild(managedApp.child);
    fs.rmSync(managedApp.tempDir, { recursive: true, force: true });
  }
}

process.exitCode = exitCode;
