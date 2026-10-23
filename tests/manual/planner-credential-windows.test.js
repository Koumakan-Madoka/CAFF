// Opt-in local Windows check; never part of default server tests. Requires the
// Goal's authorization for an exclusive LOCALAPPDATA/CAFF/planner-tests child.
// Run after build: node tests/manual/planner-credential-windows.test.js --run
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createPlannerCredential, buildWindowsAclInvocation, runWindowsAcl, validateWindowsAclSnapshot } = require('../../build/server/domain/security/planner-credential');
const { authenticateApiRequest } = require('../../build/server/http/planner-authentication');

const enabled = process.platform === 'win32' && process.argv.includes('--run');
test('local Windows protected SID descriptors exclude CodexSandboxUsers and authenticate an isolated HTTP request', { skip: !enabled }, async (t) => {
  assert.ok(process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA));
  const base = path.join(process.env.LOCALAPPDATA, 'CAFF', 'planner-tests');
  // No ACL changes to this shared parent; the credential helper creates only
  // our unique child with a protected owner/SYSTEM DACL from the outset.
  fs.mkdirSync(base, { recursive: true });
  const root = path.join(base, randomUUID());
  assert.equal(fs.existsSync(root), false);
  const file = path.join(root, '凭证 with space.json');
  const logs = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credential = createPlannerCredential({ env: { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT,
    CAFF_PLANNER_CREDENTIAL_FILE: file, CAFF_PLANNER_NAME: 'Isolated Test Planner' },
    host: '127.0.0.1', getPort: () => 12345, log: entry => logs.push(entry) });
  credential.initialize();
  // Do not include the credential or arbitrary helper output in assertion text.
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
  // Foundation-stage HTTP harness. M2's milestone evidence must additionally
  // exercise this provider through the fully wired CAFF application.
  const server = http.createServer((req, res) => {
    try { res.end(JSON.stringify(authenticateApiRequest(req, '/api/planner/test', credential))); }
    catch (error) { res.statusCode = error.statusCode || 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/planner/test`;
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).kind, 'planner');
  const rejected = await fetch(url, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
  assert.equal(rejected.status, 401);
  assert.equal(JSON.stringify(logs).includes(token), false);
  credential.disable();
  const report = { method: 'fresh filesystem SID/numeric ACE inspection; protected owner/SYSTEM-only DACL; HTTP auth harness',
    directory: descriptor.directory, file: descriptor.file, excludedGroupSid: groupSid,
    httpStatus: response.status, invalidHttpStatus: rejected.status,
    sandboxAccountReadProbe: 'not available; no account switching attempted' };
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-planner-windows-check-'));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.info('Sanitized ACL/HTTP report: ' + path.join(output, 'result.json'));
});
