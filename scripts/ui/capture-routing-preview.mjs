// 路由预显示功能的 UI 证据采集（真实浏览器，隔离实例）。
// 用法:
//   node scripts/ui/capture-routing-preview.mjs
// 环境变量:
//   CAFF_ROUTING_EVIDENCE_OUT  证据输出目录（默认 <repo>/.tmp/ui-evidence/routing-preview/<run-id>）
// 产物: 发送前预览提示条截图（默认目标 / mention 目标）+ 发送后消息路由标注截图。
// 退出码: 0 成功 / 1 失败 / 2 缺少 repo-owned playwright-core

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

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUN_ID = randomUUID().slice(0, 8);
const OUT = process.env.CAFF_ROUTING_EVIDENCE_OUT
  || path.join(ROOT_DIR, '.tmp', 'ui-evidence', 'routing-preview', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });

const ROLE_ALPHA = 'ui-verify-routing-alpha';
const ROLE_BETA = 'ui-verify-routing-beta';
const EVIDENCE_PROVIDER = 'routing-evidence';
const EVIDENCE_MODEL = 'echo-1';

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

async function startIsolatedApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `caff-routing-evidence-${RUN_ID}-`));
  const port = await findFreePort();
  const logs = { stdout: '', stderr: '' };
  // Seed a locally resolvable (but unreachable) model so evidence roles pass the
  // participant availability check; agent execution then fails fast against the
  // dead baseUrl, which is irrelevant to the routing annotation under test.
  fs.writeFileSync(path.join(tempDir, 'models.json'), JSON.stringify({
    providers: {
      [EVIDENCE_PROVIDER]: {
        name: 'Routing Evidence Provider',
        api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/routing-evidence',
        models: [{ id: EVIDENCE_MODEL, name: 'Routing Evidence Echo' }],
      },
    },
  }));
  const child = spawn(process.execPath, ['build/lib/app-server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CAFF_DISABLE_ENV_LOCAL: '1',
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: tempDir,
      PI_SQLITE_PATH: path.join(tempDir, 'routing-evidence.sqlite'),
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
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}api/health`);
      if (response.ok) {
        return { child, tempDir, baseUrl, logs };
      }
    } catch {
      // retry until deadline
    }
    if (Date.now() > deadline) {
      await stopChild(child);
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`isolated app did not become healthy\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
    }
    await delay(250);
  }
}

async function ensureRole(baseUrl, id, name) {
  const listResponse = await fetch(`${baseUrl}api/agents`);
  if (!listResponse.ok) {
    throw new Error(`failed to list roles: ${listResponse.status}`);
  }
  const directory = await listResponse.json();
  const roles = Array.isArray(directory.agents) ? directory.agents : [];
  if (roles.some((role) => role && role.id === id)) {
    return id;
  }
  const response = await fetch(`${baseUrl}api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      name,
      description: 'Isolated routing-preview evidence role.',
      provider: EVIDENCE_PROVIDER,
      model: EVIDENCE_MODEL,
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to create role ${id}: ${response.status} ${await response.text()}`);
  }
  return id;
}

async function main() {
  const app = await startIsolatedApp();
  const evidence = { baseUrl: app.baseUrl, shots: [], texts: {} };
  let browser = null;
  let conversationId = '';
  try {
    await ensureRole(app.baseUrl, ROLE_ALPHA, 'AlphaEvidence');
    await ensureRole(app.baseUrl, ROLE_BETA, 'BetaEvidence');
    const { projectScopeId, modeId } = await resolveVerificationRoomContext(app.baseUrl);
    const createResponse = await fetch(`${app.baseUrl}api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `UI-EVIDENCE-routing-${RUN_ID}`,
        projectScopeId,
        modeId,
        participants: [
          { agentId: ROLE_ALPHA, modelProfileId: null, conversationSkillIds: [] },
          { agentId: ROLE_BETA, modelProfileId: null, conversationSkillIds: [] },
        ],
      }),
    });
    if (!createResponse.ok) {
      throw new Error(`failed to create evidence conversation: ${createResponse.status} ${await createResponse.text()}`);
    }
    conversationId = (await createResponse.json()).conversation.id;

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(app.baseUrl, { waitUntil: 'load' });
    await page.locator(`button.conversation-item[data-id="${conversationId}"]`).click();
    await page.locator('#composer-input').click();

    // 1. 无 mention 草稿 → 预览默认首位参与者
    await page.keyboard.type('please compare these options', { delay: 10 });
    await page.waitForFunction(() => {
      const bar = document.getElementById('composer-routing-preview');
      return bar && !bar.classList.contains('hidden') && bar.textContent.includes('将唤醒');
    }, { timeout: 10000 });
    evidence.texts.previewDefault = await page.locator('#composer-routing-preview').textContent();
    const shot1 = path.join(OUT, '01-preview-default-first.png');
    await page.screenshot({ path: shot1 });
    evidence.shots.push(shot1);

    // 2. 改为 mention 草稿 → 预览 mention 命中目标
    await page.locator('#composer-input').press('Control+a');
    await page.keyboard.type('@BetaEvidence please take this', { delay: 10 });
    await page.waitForFunction(() => {
      const bar = document.getElementById('composer-routing-preview');
      return bar && !bar.classList.contains('hidden') && bar.textContent.includes('BetaEvidence');
    }, { timeout: 10000 });
    evidence.texts.previewMention = await page.locator('#composer-routing-preview').textContent();
    const shot2 = path.join(OUT, '02-preview-mention.png');
    await page.screenshot({ path: shot2 });
    evidence.shots.push(shot2);

    // 3. 发送 → 用户消息渲染落盘的路由标注（角色无模型绑定，turn 会失败，但标注来自
    //    metadata.routing，与 agent 执行结果无关）。
    await page.locator('#send-button').click();
    // 等待执行时路由落盘并广播后，标注从「预计路由」翻转为「已路由」终态。
    await page.waitForFunction(() => {
      const badge = document.querySelector('.message-routing-annotation');
      return badge && badge.textContent.includes('已路由') && badge.textContent.includes('BetaEvidence');
    }, { timeout: 20000 });
    evidence.texts.annotation = await page.locator('.message-routing-annotation').first().textContent();
    const shot3 = path.join(OUT, '03-sent-message-annotation.png');
    await page.screenshot({ path: shot3 });
    evidence.shots.push(shot3);

    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (browser) {
      await browser.close();
    }
    if (conversationId) {
      await fetch(`${app.baseUrl}api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' }).catch(() => {});
    }
    await stopChild(app.child);
    fs.rmSync(app.tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
