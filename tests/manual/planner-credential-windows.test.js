// Opt-in local Windows check; never part of default server tests. Requires the
// Goal's authorization for an exclusive LOCALAPPDATA/CAFF/planner-tests child.
// Run after build: node tests/manual/planner-credential-windows.test.js --run
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createServerApp } = require('../../build/server/app/create-server');
const { createPlannerCredential, buildWindowsAclInvocation, runWindowsAcl, validateWindowsAclSnapshot } = require('../../build/server/domain/security/planner-credential');
const { isolateExternalIntegrations } = require('../helpers/external-integrations');

const enabled = process.platform === 'win32' && process.argv.includes('--run');
test('local Windows protected SID descriptors exclude CodexSandboxUsers and authenticate an isolated CAFF instance', { skip: !enabled }, async (t) => {
  isolateExternalIntegrations();
  assert.ok(process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA));
  const base = path.join(process.env.LOCALAPPDATA, 'CAFF', 'planner-tests');
  // No ACL changes to this shared parent; only our unique child is created
  // with a protected owner/SYSTEM DACL from the outset.
  fs.mkdirSync(base, { recursive: true });
  const root = path.join(base, randomUUID());
  assert.equal(fs.existsSync(root), false);
  const file = path.join(root, '凭证 with space.json');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-local-instance-'));
  const logs = [];
  let app;
  t.after(async () => {
    try { if (app) await new Promise(resolve => app.close(resolve)); }
    finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(runtime, { recursive: true, force: true }); }
  });
  const credential = createPlannerCredential({ env: { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT,
    CAFF_PLANNER_CREDENTIAL_FILE: file, CAFF_PLANNER_NAME: 'Isolated Test Planner' },
    host: '127.0.0.1', getPort: () => app?.server.address()?.port || 0, log: entry => logs.push(entry) });
  app = createServerApp({ host: '127.0.0.1', port: 0, agentDir: runtime, sqlitePath: path.join(runtime, 'chat.sqlite'),
    projectDir: runtime, uploadsDir: path.join(runtime, 'uploads'), plannerCredential: credential,
    modelCatalog: { getOptions: () => [] }, executeConversationAgent: async () => { throw Error('No model execution expected'); } });
  await new Promise(resolve => app.start(resolve));
  // Do not include credentials or arbitrary helper output in assertion text.
  assert.equal(fs.existsSync(file), true, JSON.stringify(logs));
  const token = JSON.parse(fs.readFileSync(file, 'utf8')).token;
  const descriptor = runWindowsAcl({ operation: 'inspect', directory: root, targetPath: file }, process.env);
  validateWindowsAclSnapshot(descriptor.directory, descriptor.currentSid, true);
  validateWindowsAclSnapshot(descriptor.file, descriptor.currentSid, false);
  const groupScript = String.raw`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $g=New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, 'CodexSandboxUsers'); @{ sid=$g.Translate([System.Security.Principal.SecurityIdentifier]).Value } | ConvertTo-Json -Compress`;
  const powershell = buildWindowsAclInvocation({ operation: 'inspect', directory: root, targetPath: file }, process.env).file;
  const groupResult = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(groupScript, 'utf16le').toString('base64')],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  assert.equal(groupResult.status, 0, 'Local CodexSandboxUsers SID resolution failed');
  const groupSid = JSON.parse(groupResult.stdout.replace(/^\uFEFF/, '').trim()).sid;
  assert.match(groupSid, /^S-1-5-/);
  for (const value of [descriptor.directory, descriptor.file]) {
    assert.equal(value.rules.some(ace => ace.sid === groupSid), false);
    assert.equal(value.rules.every(ace => ace.sid === descriptor.currentSid || ace.sid === 'S-1-5-18'), true);
  }
  const url = `http://127.0.0.1:${app.server.address().port}/api/bootstrap`;
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(Array.isArray(JSON.parse(body).conversations), true);
  assert.equal(body.includes(token), false);
  const rejected = await fetch(url, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
  assert.equal(rejected.status, 401);
  assert.equal(JSON.stringify(logs).includes(token), false);
  const report = { method: 'fresh filesystem SID/numeric ACE inspection; protected owner/SYSTEM-only DACL; live CAFF bootstrap bearer authentication',
    directory: descriptor.directory, file: descriptor.file, excludedGroupSid: groupSid,
    httpStatus: response.status, invalidHttpStatus: rejected.status,
    sandboxAccountReadProbe: 'not available; no account switching attempted' };
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-windows-check-'));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.info('Sanitized ACL/CAFF HTTP report: ' + path.join(output, 'result.json'));
});
