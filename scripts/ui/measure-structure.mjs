// CAFF-UI-M4 V3 structural measurement (real browser, isolated app).
// Measures computed geometry against the V3 design-gate contract
// (feature-discussions/2026-07-29-caff-ui-m4-design/v3-structure/README.md):
//   1. assistant medium/long rows span >= ~95% of the column (transcript form)
//   2. assistant rows have no card shell (transparent background, no radius,
//      no card padding beyond the agent-color attribution bar)
//   3. user messages are right-aligned bubbles, width <= 75% of the column,
//      and a medium user message is wider than the V1 effective cap (405px @1440)
//   4. visible message cards per screen >= the V2 baseline (9 @1440x820)
// Usage:
//   node scripts/ui/measure-structure.mjs --tag before --out <json> --shots <dir>
// Defaults: --tag after, out/shots under v3-structure/.

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('repo-owned playwright-core 未安装：请先运行 npm install');
  process.exit(2);
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_ID = randomUUID().slice(0, 8);
const TITLE_PREFIX = `STRUCT-${RUN_ID}`;
const EVIDENCE_DIR = path.join(ROOT_DIR, 'feature-discussions', '2026-07-29-caff-ui-m4-design', 'v3-structure');

function flagValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

const TAG = flagValue('tag', 'after');
const OUT_PATH = path.resolve(flagValue('out', path.join(EVIDENCE_DIR, `${TAG}-measurements.json`)));
const SHOTS_DIR = path.resolve(flagValue('shots', path.join(EVIDENCE_DIR, TAG)));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `caff-structure-${RUN_ID}-`));
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
      PI_SQLITE_PATH: path.join(tempDir, 'structure.sqlite'),
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

async function createConversation(baseUrl, title) {
  const response = await fetch(`${baseUrl}api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, type: 'standard' }),
  });
  if (!response.ok) {
    throw new Error(`failed to create structure conversation: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  return payload.conversation;
}

async function deleteConversation(baseUrl, conversationId) {
  await fetch(`${baseUrl}api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }).catch(() => {});
}

// Deterministic evidence set: assistant short/medium/long + user short/medium,
// same conversation, same content, same order for before/after runs.
const EVIDENCE_MESSAGES = [
  { role: 'assistant', kind: 'medium', text: '这条是中等长度的回复：消息区独立滚动，标题、主要操作与 composer 始终留在视口内，用来检验典型消息的实际几何。' },
  { role: 'user', kind: 'short', text: '继续核对滚动位置。' },
  { role: 'assistant', kind: 'long', text: '这条是长回复，用来检验 transcript 形态是否真正占满整列。第一条要点：内容按文档流排布，不再被气泡壳包住；第二条要点：归属标识交给左侧细条或 meta 行，而不是厚重的卡片 chrome；第三条要点：宽度必须接近列宽，第一眼就能看出和旧版气泡的差异，长文本应当在更宽的行内换行，而不是挤在一个收窄的块里反复折行。' },
  { role: 'assistant', kind: 'short', text: '收到。' },
  { role: 'user', kind: 'medium', text: '把这条用户消息写得稍长一些，用来确认右对齐气泡在自然内容下不会被人工收窄，宽度应当超过旧版 405px 的实效上限。' },
  { role: 'assistant', kind: 'medium', text: '第二条中等回复：核对 meta 行是否紧凑贴在内容上方，hover 才露出导出与上下文操作。' },
  { role: 'assistant', kind: 'failed', text: '这条回复失败了：网络超时，请重试。' },
  { role: 'user', kind: 'short', text: '再试一次。' },
  { role: 'assistant', kind: 'medium', text: '第三条中等回复：单屏消息密度应当不低于 V2 基线，同内容下第一眼更宽更紧凑。' },
  { role: 'assistant', kind: 'long', text: '又一条长回复，重复确认长文本在 transcript 形态下的行宽。视觉上它应当像一段文档而不是一张卡片：没有背景块、没有大圆角、没有沉重的 padding，只有一条细细的归属色条和紧凑的 meta 行。这样 operator 在 1440 桌面上扫一眼，就能明确说出新旧结构的差别，而不是靠量测脚本才发现 token 变了。' },
  { role: 'user', kind: 'short', text: '好的，继续。' },
  { role: 'assistant', kind: 'medium', text: '第四条中等回复：补齐一屏的密度样本，让可见消息数可以稳定统计。' },
];

async function renderEvidenceConversation(page) {
  await page.evaluate((messages) => {
    const list = document.getElementById('message-list');
    const fragment = document.createDocumentFragment();
    messages.forEach((message, index) => {
      const isUser = message.role === 'user';
      const card = document.createElement('article');
      card.className = `message-card ${message.role}${message.kind === 'failed' ? ' failed' : ''}`;
      card.dataset.messageId = `struct-${index}`;
      card.dataset.evidenceKind = message.kind;
      if (!isUser) {
        card.style.setProperty('--agent-color', '#2a9d8f');
      }
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const sender = document.createElement('span');
      sender.className = 'message-sender';
      const senderLabel = document.createElement('span');
      senderLabel.className = 'message-sender-label';
      senderLabel.textContent = isUser ? 'You' : '砚砚';
      sender.appendChild(senderLabel);
      const time = document.createElement('span');
      time.className = 'message-time';
      time.textContent = `14:${String(index).padStart(2, '0')}`;
      meta.append(sender, time);
      const body = document.createElement('div');
      body.className = 'message-body';
      const paragraph = document.createElement('p');
      paragraph.textContent = message.text;
      body.appendChild(paragraph);
      card.append(meta, body);
      fragment.appendChild(card);
    });
    list.replaceChildren(fragment);
    list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    list.dispatchEvent(new Event('scroll'));
  }, EVIDENCE_MESSAGES);
  await page.waitForTimeout(250);
}

async function measureViewport(page, viewport, label) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const list = document.getElementById('message-list');
    list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    list.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(150);
  return page.evaluate((tag) => {
    const round = (n) => Math.round(n * 10) / 10;
    const list = document.getElementById('message-list');
    const listRect = list.getBoundingClientRect();
    const listStyle = getComputedStyle(list);
    const columnWidth = round(listRect.width - parseFloat(listStyle.paddingLeft) - parseFloat(listStyle.paddingRight));
    const cards = Array.from(list.querySelectorAll(':scope > .message-card'));
    const cardInfo = (card) => {
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const s = getComputedStyle(card);
      return {
        kind: card.dataset.evidenceKind || '',
        role: card.classList.contains('user') ? 'user' : 'assistant',
        width: round(r.width),
        height: round(r.height),
        left: round(r.left),
        right: round(r.right),
        backgroundColor: s.backgroundColor,
        backgroundImage: s.backgroundImage,
        borderRadius: s.borderRadius,
        borderLeftWidth: s.borderLeftWidth,
        padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
        paddingX: round(parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)),
        paddingY: round(parseFloat(s.paddingTop) + parseFloat(s.paddingBottom)),
        widthRatio: round(r.width / (columnWidth || r.width) * 1000) / 1000,
      };
    };
    const pick = (role, kind) => cardInfo(cards.find((c) =>
      (role === 'user' ? c.classList.contains('user') : !c.classList.contains('user')) &&
      (c.dataset.evidenceKind || '') === kind));
    const visible = cards.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > listRect.top && r.top < listRect.bottom;
    }).length;
    return {
      viewport: tag,
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      columnWidth,
      listRight: round(listRect.right - parseFloat(listStyle.paddingRight)),
      assistantMedium: pick('assistant', 'medium'),
      assistantLong: pick('assistant', 'long'),
      assistantShort: pick('assistant', 'short'),
      userShort: pick('user', 'short'),
      userMedium: pick('user', 'medium'),
      failedCard: pick('assistant', 'failed'),
      visibleMessageCards: visible,
      totalMessageCards: cards.length,
    };
  }, label);
}

function evaluateContract(measurements) {
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });
  for (const scenario of measurements.scenarios) {
    const tag = scenario.viewport;
    const col = scenario.columnWidth;
    const transparent = (value) => value === 'rgba(0, 0, 0, 0)' || value === 'transparent';
    const noRadius = (value) => !value || value === '0px' || value.split(' ').every((part) => part === '0px');
    for (const [key, label] of [['assistantMedium', 'assistant 中'], ['assistantLong', 'assistant 长']]) {
      const card = scenario[key];
      if (!card) {
        push(`${tag}:${key}-width`, false, 'card missing');
        continue;
      }
      push(`${tag}:${key}-width`, card.widthRatio >= 0.95, `${label}消息行宽 ${card.width}px / 列 ${col}px = ${(card.widthRatio * 100).toFixed(1)}%（契约 ≥95%）`);
      push(`${tag}:${key}-shell`, transparent(card.backgroundColor) && card.backgroundImage === 'none' && noRadius(card.borderRadius) && card.paddingY <= 8,
        `${label}消息壳 bg=${card.backgroundColor} img=${card.backgroundImage} radius=${card.borderRadius} paddingY=${card.paddingY}px`);
    }
    // Scrollbar-gutter reserves ~15px inside the column; use the full-width
    // transcript rows as the right-edge reference instead of the list rect.
    const columnRight = Math.max(
      scenario.assistantMedium ? scenario.assistantMedium.right : 0,
      scenario.assistantLong ? scenario.assistantLong.right : 0,
    );
    if (scenario.userShort) {
      const rightGap = Math.abs(scenario.userShort.right - columnRight);
      push(`${tag}:user-short-align`, rightGap <= 2, `user 短消息右缘距全宽行右缘 ${rightGap.toFixed(1)}px（契约 ≤2px）`);
      push(`${tag}:user-short-cap`, scenario.userShort.widthRatio <= 0.75, `user 短消息宽占比 ${(scenario.userShort.widthRatio * 100).toFixed(1)}%（契约 ≤75%）`);
    }
    if (tag.startsWith('desktop') && scenario.userMedium) {
      push(`${tag}:user-medium-width`, scenario.userMedium.width > 405, `user 中消息宽 ${scenario.userMedium.width}px（契约 > V1 实效 405px）`);
    }
    // Density contract is desktop-scoped (V2 baseline 9 @1440x820, 6 @375x800).
    const densityBaseline = tag.startsWith('desktop') ? 9 : 6;
    push(`${tag}:density`, scenario.visibleMessageCards >= densityBaseline, `单屏可见消息 ${scenario.visibleMessageCards}（契约 ≥ V2 基线 ${densityBaseline}）`);
  }
  return checks;
}

let managedApp = null;
let browser = null;
let conversationId = '';
let exitCode = 1;

try {
  managedApp = await startIsolatedApp();
  const conversation = await createConversation(managedApp.baseUrl, `${TITLE_PREFIX}-ROOM`);
  conversationId = conversation.id;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
  await page.goto(`${managedApp.baseUrl}?conversation=${encodeURIComponent(conversationId)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const pill = document.getElementById('runtime-pill');
    return pill && !pill.textContent.includes('正在连接');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  await renderEvidenceConversation(page);

  const measurements = {
    runId: RUN_ID,
    tag: TAG,
    measuredAt: new Date().toISOString(),
    scenarios: [],
  };

  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  for (const [viewport, label, shotName] of [
    [{ width: 1440, height: 820 }, 'desktop-1440x820', 'ui-1440.png'],
    [{ width: 375, height: 800 }, 'mobile-375x800', 'ui-375.png'],
  ]) {
    measurements.scenarios.push(await measureViewport(page, viewport, label));
    await page.screenshot({ path: path.join(SHOTS_DIR, shotName) });
  }

  measurements.contract = evaluateContract(measurements);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify(measurements, null, 2));
  console.log(`\nwrote ${OUT_PATH}`);
  console.log(`screenshots in ${SHOTS_DIR}`);
  exitCode = 0;
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
  if (managedApp) {
    if (conversationId) {
      await deleteConversation(managedApp.baseUrl, conversationId);
    }
    await stopChild(managedApp.child);
    fs.rmSync(managedApp.tempDir, { recursive: true, force: true });
  }
}

process.exitCode = exitCode;
