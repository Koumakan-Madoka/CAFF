// CAFF-UI-M4 V2 density measurement (real browser, isolated app).
// Measures the chat experience layout so V2 numbers are evidence-based, not guessed.
// Usage:
//   node scripts/ui/measure-density.mjs --out <path-to-json>
// Default out: feature-discussions/2026-07-29-caff-ui-m4-design/v2-density/before-measurements.json

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveVerificationRoomContext } from './room-fixture.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('repo-owned playwright-core 未安装：请先运行 npm install');
  process.exit(2);
}

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_ID = randomUUID().slice(0, 8);
const TITLE_PREFIX = `DENSITY-${RUN_ID}`;
const VERIFICATION_ROLE_ID = 'ui-verification-role';
const outFlag = process.argv.indexOf('--out');
const OUT_PATH = outFlag > -1
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(ROOT_DIR, 'feature-discussions', '2026-07-29-caff-ui-m4-design', 'v2-density', 'before-measurements.json');

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `caff-density-${RUN_ID}-`));
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
      PI_SQLITE_PATH: path.join(tempDir, 'density.sqlite'),
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

async function ensureVerificationRole(baseUrl) {
  const listResponse = await fetch(`${baseUrl}api/agents`);
  if (!listResponse.ok) {
    throw new Error(`failed to list roles: ${listResponse.status}`);
  }
  const directory = await listResponse.json();
  const existing = (Array.isArray(directory.agents) ? directory.agents : []).find(
    (role) => role && role.id === VERIFICATION_ROLE_ID
  );
  if (existing) return existing.id;
  const response = await fetch(`${baseUrl}api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: VERIFICATION_ROLE_ID,
      name: 'UI 验证角色',
      description: 'Isolated UI verification role (no model binding, always available).',
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to create verification role: ${response.status} ${await response.text()}`);
  }
  return VERIFICATION_ROLE_ID;
}

async function createConversation(baseUrl, title) {
  const roleId = await ensureVerificationRole(baseUrl);
  const { projectScopeId, modeId } = await resolveVerificationRoomContext(baseUrl);
  const response = await fetch(`${baseUrl}api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      projectScopeId,
      modeId,
      participants: [{ agentId: roleId, modelProfileId: null, conversationSkillIds: [] }],
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to create density conversation: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  return payload.conversation;
}

async function deleteConversation(baseUrl, conversationId) {
  await fetch(`${baseUrl}api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }).catch(() => {});
}

let messageSequence = 0;
async function renderEvidenceConversation(page, count = 28) {
  const ids = Array.from({ length: count }, () => `${TITLE_PREFIX}-${++messageSequence}`);
  await page.evaluate((messageIds) => {
    const list = document.getElementById('message-list');
    const fragment = document.createDocumentFragment();
    messageIds.forEach((id, index) => {
      const isUser = index % 4 === 1;
      const card = document.createElement('article');
      card.className = `message-card ${isUser ? 'user' : 'assistant'}`;
      card.dataset.messageId = id;
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const sender = document.createElement('span');
      sender.className = 'message-sender';
      sender.textContent = isUser ? '你' : '砚砚';
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
      card.append(meta, body);
      fragment.appendChild(card);
    });
    list.replaceChildren(fragment);
    list.scrollTo({ top: list.scrollHeight, behavior: 'instant' });
    list.dispatchEvent(new Event('scroll'));
  }, ids);
  await page.waitForTimeout(250);
}

async function measureViewport(page, viewport, label) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(350);
  return page.evaluate((tag) => {
    const round = (n) => Math.round(n * 10) / 10;
    const list = document.getElementById('message-list');
    const listRect = list.getBoundingClientRect();
    const listStyle = getComputedStyle(list);
    const cards = Array.from(list.querySelectorAll(':scope > .message-card'));
    const assistant = cards.find((c) => c.classList.contains('assistant'));
    const user = cards.find((c) => c.classList.contains('user'));
    const cardInfo = (card) => {
      if (!card) return null;
      const r = card.getBoundingClientRect();
      const s = getComputedStyle(card);
      return {
        width: round(r.width),
        height: round(r.height),
        left: round(r.left),
        paddingX: round(parseFloat(s.paddingLeft) + parseFloat(s.paddingRight)),
        paddingY: round(parseFloat(s.paddingTop) + parseFloat(s.paddingBottom)),
        maxWidth: s.maxWidth,
      };
    };
    let gap = null;
    for (let i = 1; i < cards.length; i += 1) {
      const prev = cards[i - 1].getBoundingClientRect();
      const curr = cards[i].getBoundingClientRect();
      const candidate = curr.top - prev.bottom;
      if (candidate >= 0) {
        gap = round(candidate);
        break;
      }
    }
    const header = document.querySelector('.chat-header');
    const composer = document.getElementById('composer-form');
    const visible = cards.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.bottom > listRect.top && r.top < listRect.bottom;
    }).length;
    return {
      viewport: tag,
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      messageList: {
        width: round(listRect.width),
        height: round(listRect.height),
        paddingX: round(parseFloat(listStyle.paddingLeft) + parseFloat(listStyle.paddingRight)),
        paddingY: round(parseFloat(listStyle.paddingTop) + parseFloat(listStyle.paddingBottom)),
        columnGap: listStyle.columnGap,
      },
      cardGap: gap,
      assistantCard: cardInfo(assistant),
      userCard: cardInfo(user),
      headerHeight: header ? round(header.getBoundingClientRect().height) : null,
      composerHeight: composer ? round(composer.getBoundingClientRect().height) : null,
      visibleMessageCards: visible,
      totalMessageCards: cards.length,
    };
  }, label);
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
    measuredAt: new Date().toISOString(),
    scenarios: [],
  };
  measurements.scenarios.push(await measureViewport(page, { width: 1440, height: 820 }, 'desktop-1440x820'));
  measurements.scenarios.push(await measureViewport(page, { width: 375, height: 800 }, 'mobile-375x800'));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify(measurements, null, 2));
  console.log(`\nwrote ${OUT_PATH}`);
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
