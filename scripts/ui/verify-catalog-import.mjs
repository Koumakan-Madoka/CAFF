// F004 AC-7 目录导入浏览器验收（真实浏览器，桌面 + 移动 + 快照不可用）。
// 用法:
//   node scripts/ui/verify-catalog-import.mjs
// 环境变量:
//   CAFF_CATALOG_ACCEPT_OUT       证据输出目录（默认 .tmp/ui-catalog-import）
//   CAFF_CATALOG_ACCEPT_FIXTURE   外部 fixture 覆盖（默认 repo-owned 测试夹具；使用时记录其 SHA-256）
//   GIT_HEAD                      覆盖自动解析的 git HEAD
// 退出码: 0 全绿 / 1 有 FAIL / 2 缺少 repo-owned playwright-core

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const OUT = process.env.CAFF_CATALOG_ACCEPT_OUT || path.join(ROOT_DIR, '.tmp', 'ui-catalog-import');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const REPO_FIXTURE = path.join(ROOT_DIR, 'tests', 'fixtures', 'f004-models-dev-catalog.acceptance.json');
const ACCEPT_FIXTURE = process.env.CAFF_CATALOG_ACCEPT_FIXTURE
  ? path.resolve(process.env.CAFF_CATALOG_ACCEPT_FIXTURE)
  : REPO_FIXTURE;
const fixtureBuffer = fs.readFileSync(ACCEPT_FIXTURE);
const fixtureInfo = {
  path: ACCEPT_FIXTURE,
  repoOwned: ACCEPT_FIXTURE === REPO_FIXTURE,
  sha256: crypto.createHash('sha256').update(fixtureBuffer).digest('hex'),
};

function resolveGitHead() {
  if (process.env.GIT_HEAD) return process.env.GIT_HEAD;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`无法解析 git HEAD：${result.stderr || result.error}`);
    process.exit(1);
  }
  return result.stdout.trim();
}
const gitHead = resolveGitHead();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
};

const pathnameOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
};
const isBenignFavicon404 = (entry) => pathnameOf(entry.url) === '/favicon.ico' && entry.text.includes('404');
const isExpectedCatalog503 = (entry) => pathnameOf(entry.url) === '/api/model-catalog'
  && /^Failed to load resource: the server responded with a status of 503/.test(entry.text);

async function findFreePort() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const candidate = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(candidate)));
    });
  });
  if (port === 3003 || port === 3004 || port === 6399) {
    return findFreePort();
  }
  return port;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
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
      if (response.ok) return;
    } catch {
      // not bound yet
    }
    await delay(100);
  }
  throw new Error(`isolated app did not become ready\n${logs.stderr}\n${logs.stdout}`);
}

async function startIsolatedApp({ withCatalogCache }) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-f004-accept-'));
  if (withCatalogCache) {
    fs.copyFileSync(ACCEPT_FIXTURE, path.join(agentDir, 'models-dev-catalog.json'));
  }
  const port = await findFreePort();
  const logs = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'build', 'lib', 'app-server.js')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { logs.stdout += chunk; });
  child.stderr.on('data', (chunk) => { logs.stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}/`;
  await waitForServer(baseUrl, child, logs);
  return { child, baseUrl, agentDir, logs };
}

async function newTrackedPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  page.consoleErrors = [];
  page.pageErrors = [];
  page.notFound = [];
  page.on('console', (msg) => { if (msg.type() === 'error') page.consoleErrors.push({ text: msg.text(), url: msg.location().url || '' }); });
  page.on('pageerror', (err) => page.pageErrors.push(String(err)));
  page.on('response', (res) => { if (res.status() === 404) page.notFound.push(res.url()); });
  return page;
}

async function openCatalogImport(page, baseUrl) {
  await page.goto(`${baseUrl}personas.html`, { waitUntil: 'domcontentloaded' });
  const tab = page.locator('#show-provider-management');
  await tab.waitFor({ state: 'visible', timeout: 15000 });
  await tab.click();
  const button = page.locator('#import-from-catalog');
  await button.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById('import-from-catalog').disabled, null, { timeout: 15000 });
  await button.click();
}

let browser = null;
let appA = null;
let appB = null;
let exitCode = 1;

try {
  appA = await startIsolatedApp({ withCatalogCache: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  // ---------- 桌面场景 ----------
  const desktop = await newTrackedPage(browser, { width: 1440, height: 900 });

  await openCatalogImport(desktop, appA.baseUrl);
  await desktop.waitForSelector('.catalog-provider-row', { timeout: 15000 });
  const providerCount = await desktop.locator('.catalog-provider-row').count();
  const catalogCardText = await desktop.locator('.management-card', { has: desktop.locator('#catalog-import-search') }).textContent();
  ok('desktop: catalog list renders providers with provenance', providerCount === 2 && /vendored/.test(catalogCardText || '') && /models\.dev/.test(catalogCardText || ''),
    `providers=${providerCount} provenance=${/vendored/.test(catalogCardText || '')}`);
  await desktop.screenshot({ path: path.join(SHOTS, '01-desktop-catalog-list.png'), fullPage: true });

  // UI-1 修复：model-only 搜索（按模型 id）
  await desktop.fill('#catalog-import-search', 'gpt-5');
  await desktop.waitForTimeout(200);
  const openaiRow = desktop.locator('[data-catalog-provider="openai"]');
  const mysteryRow = desktop.locator('[data-catalog-provider="mystery"]');
  const openaiExpanded = await openaiRow.locator('[data-catalog-open-provider]').getAttribute('aria-expanded');
  const openaiModelVisible = await openaiRow.locator('[data-catalog-open-model="gpt-5"]').isVisible();
  const mysteryHidden = await mysteryRow.evaluate((el) => el.classList.contains('hidden'));
  ok('desktop: model-only id search keeps provider reachable (UI-1)', openaiExpanded === 'true' && openaiModelVisible && mysteryHidden,
    `openaiExpanded=${openaiExpanded} modelVisible=${openaiModelVisible} mysteryHidden=${mysteryHidden}`);
  await desktop.screenshot({ path: path.join(SHOTS, '02-desktop-model-only-search.png'), fullPage: true });

  // UI-1 修复：model-only 搜索（按模型 name）
  await desktop.fill('#catalog-import-search', 'Manual Model');
  await desktop.waitForTimeout(200);
  const mysteryExpanded = await mysteryRow.locator('[data-catalog-open-provider]').getAttribute('aria-expanded');
  const manualModelVisible = await mysteryRow.locator('[data-catalog-open-model="m-1"]').isVisible();
  const openaiHidden = await openaiRow.evaluate((el) => el.classList.contains('hidden'));
  ok('desktop: model-only name search expands matching provider (UI-1)', mysteryExpanded === 'true' && manualModelVisible && openaiHidden,
    `mysteryExpanded=${mysteryExpanded} manualVisible=${manualModelVisible} openaiHidden=${openaiHidden}`);
  await desktop.screenshot({ path: path.join(SHOTS, '03-desktop-model-name-search.png'), fullPage: true });

  // metadata / runtime 分区（AC-7）
  await desktop.fill('#catalog-import-search', '');
  await desktop.waitForTimeout(200);
  await openaiRow.locator('[data-catalog-open-provider]').click();
  await openaiRow.locator('[data-catalog-open-model="gpt-5"]').click();
  await desktop.waitForSelector('#catalog-import-metadata', { timeout: 15000 });
  await desktop.waitForSelector('#catalog-import-controls', { timeout: 15000 });
  const metadataText = await desktop.locator('#catalog-import-metadata').textContent();
  const controlsText = await desktop.locator('#catalog-import-controls').textContent();
  const metadataReadonlyCount = await desktop.locator('#catalog-import-metadata input[readonly]').count();
  const metadataCovers = ['目录参考价', '上下文上限', '模态', 'reasoning 选项', 'OPENAI_API_KEY', '来源：'].every((s) => metadataText.includes(s));
  const controlsClean = !controlsText.includes('目录参考价') && !controlsText.includes('每 M token');
  const confirmEnabled = await desktop.locator('#catalog-import-confirm').isEnabled();
  ok('desktop: catalog metadata and runtime controls render in separate sections (AC-7)',
    metadataCovers && controlsClean && metadataReadonlyCount >= 3 && confirmEnabled,
    `metadataCovers=${metadataCovers} controlsClean=${controlsClean} readonly=${metadataReadonlyCount} confirmEnabled=${confirmEnabled}`);
  await desktop.screenshot({ path: path.join(SHOTS, '04-desktop-metadata-runtime-split.png'), fullPage: true });

  // 完整导入闭环
  await desktop.locator('#catalog-import-confirm').click();
  await desktop.waitForSelector('#provider-id', { timeout: 15000 });
  await desktop.waitForTimeout(500);
  const providersResponse = await fetch(`${appA.baseUrl}api/model-providers`);
  const providersPayload = await providersResponse.json();
  const imported = (providersPayload.providers || []).find((p) => p.id === 'openai');
  const importedModel = imported && (imported.models || []).find((m) => m.id === 'gpt-5');
  const modelsJsonPath = path.join(appA.agentDir, 'models.json');
  const modelsJson = fs.existsSync(modelsJsonPath) ? JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8')) : null;
  ok('desktop: explicit confirm imports provider through persistence path',
    Boolean(imported && importedModel && imported.api === 'openai-responses' && modelsJson),
    `imported=${JSON.stringify(imported && { id: imported.id, api: imported.api, models: (imported.models || []).map((m) => m.id) })} modelsJson=${Boolean(modelsJson)}`);
  await desktop.screenshot({ path: path.join(SHOTS, '05-desktop-import-complete.png'), fullPage: true });

  // manual fail-closed（AC-3）
  await openCatalogImport(desktop, appA.baseUrl);
  await desktop.waitForSelector('.catalog-provider-row', { timeout: 15000 });
  await mysteryRow.locator('[data-catalog-open-provider]').click();
  await mysteryRow.locator('[data-catalog-open-model="m-1"]').click();
  await desktop.waitForSelector('#catalog-import-manual', { timeout: 15000 });
  const manualConfirmDisabled = await desktop.locator('#catalog-import-confirm').isDisabled();
  const manualText = await desktop.locator('#catalog-import-manual').textContent();
  ok('desktop: manual-configuration model fails closed with no import action (AC-3)',
    manualConfirmDisabled && /需手工配置/.test(manualText),
    `confirmDisabled=${manualConfirmDisabled}`);
  await desktop.screenshot({ path: path.join(SHOTS, '06-desktop-manual-fail-closed.png'), fullPage: true });

  const desktopRealConsole = desktop.consoleErrors.filter((entry) => !isBenignFavicon404(entry));
  const desktopRealNotFound = desktop.notFound.filter((url) => pathnameOf(url) !== '/favicon.ico');
  ok('desktop: no console/page errors or missing resources', desktopRealConsole.length === 0 && desktop.pageErrors.length === 0 && desktopRealNotFound.length === 0,
    `console=${JSON.stringify(desktopRealConsole)} page=${JSON.stringify(desktop.pageErrors)} 404=${JSON.stringify(desktopRealNotFound)} (favicon benign: console=${desktop.consoleErrors.length - desktopRealConsole.length} 404=${desktop.notFound.length - desktopRealNotFound.length})`);
  await desktop.close();

  // ---------- 移动场景 ----------
  const mobile = await newTrackedPage(browser, { width: 390, height: 844 });
  await openCatalogImport(mobile, appA.baseUrl);
  await mobile.waitForSelector('.catalog-provider-row', { timeout: 15000 });
  await mobile.fill('#catalog-import-search', 'gpt-5');
  await mobile.waitForTimeout(200);
  const mobileExpanded = await mobile.locator('[data-catalog-provider="openai"] [data-catalog-open-provider]').getAttribute('aria-expanded');
  await mobile.locator('[data-catalog-provider="openai"] [data-catalog-open-model="gpt-5"]').click();
  await mobile.waitForSelector('#catalog-import-metadata', { timeout: 15000 });
  await mobile.waitForSelector('#catalog-import-controls', { timeout: 15000 });
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  ok('mobile: catalog import usable at 390px (search + metadata/controls)', mobileExpanded === 'true' && !mobileOverflow,
    `expanded=${mobileExpanded} horizontalOverflow=${mobileOverflow}`);
  await mobile.screenshot({ path: path.join(SHOTS, '07-mobile-catalog-metadata.png'), fullPage: true });
  const mobileRealConsole = mobile.consoleErrors.filter((entry) => !isBenignFavicon404(entry));
  const mobileRealNotFound = mobile.notFound.filter((url) => pathnameOf(url) !== '/favicon.ico');
  ok('mobile: no console/page errors or missing resources', mobileRealConsole.length === 0 && mobile.pageErrors.length === 0 && mobileRealNotFound.length === 0,
    `console=${JSON.stringify(mobileRealConsole)} page=${JSON.stringify(mobile.pageErrors)} 404=${JSON.stringify(mobileRealNotFound)}`);
  await mobile.close();

  // ---------- 快照不可用 503 ----------
  appB = await startIsolatedApp({ withCatalogCache: false });
  const unavailableResponse = await fetch(`${appB.baseUrl}api/model-catalog`);
  const unavailablePayload = await unavailableResponse.json().catch(() => ({}));
  const unavailableCode = unavailablePayload && unavailablePayload.issues && unavailablePayload.issues[0] && unavailablePayload.issues[0].code;
  ok('api: missing snapshot returns 503 catalog_source_unavailable',
    unavailableResponse.status === 503 && unavailableCode === 'catalog_source_unavailable',
    `status=${unavailableResponse.status} code=${unavailableCode}`);

  const unavailablePage = await newTrackedPage(browser, { width: 1440, height: 900 });
  await openCatalogImport(unavailablePage, appB.baseUrl);
  await unavailablePage.waitForSelector('#catalog-import-unavailable', { timeout: 15000 });
  const unavailableText = await unavailablePage.locator('#catalog-import-unavailable').textContent();
  ok('desktop: snapshot unavailable renders honest empty state without import actions',
    /目录快照未就位/.test(unavailableText) && (await unavailablePage.locator('#catalog-import-confirm').count()) === 0,
    `text=${unavailableText.trim().slice(0, 40)}...`);
  await unavailablePage.screenshot({ path: path.join(SHOTS, '08-desktop-snapshot-unavailable.png'), fullPage: true });
  const unexpectedConsole = unavailablePage.consoleErrors.filter((entry) => !isExpectedCatalog503(entry) && !isBenignFavicon404(entry));
  const allowlistedConsole = unavailablePage.consoleErrors.filter((entry) => isExpectedCatalog503(entry));
  const unavailableRealNotFound = unavailablePage.notFound.filter((url) => pathnameOf(url) !== '/favicon.ico');
  ok('desktop: snapshot unavailable surfaces no unexpected console/page errors (503 resource error allowlisted)',
    unexpectedConsole.length === 0 && unavailablePage.pageErrors.length === 0 && unavailableRealNotFound.length === 0,
    `unexpectedConsole=${JSON.stringify(unexpectedConsole)} allowlisted=${JSON.stringify(allowlistedConsole)} page=${JSON.stringify(unavailablePage.pageErrors)} 404=${JSON.stringify(unavailableRealNotFound)}`);
  await unavailablePage.close();

  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (appA) await stopChild(appA.child);
  if (appB) await stopChild(appB.child);
}

const summary = {
  feature: 'F004',
  head: gitHead,
  fixture: fixtureInfo,
  out: SHOTS,
  results,
};
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
console.log(`evidence written to ${SHOTS}`);
process.exit(exitCode);
