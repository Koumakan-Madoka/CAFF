const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const CLI = path.resolve(__dirname, '../../build/lib/caff.js');
const api = () => require('../../build/lib/planner-cli');
const ascii = value => JSON.stringify(value).replace(/[^\x20-\x7e]|['$`;&|<>()]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const attempt = '11111111-1111-4111-8111-111111111111';
const goal = { goalId: 'goal-test', revision: 3, owner: { agentId: 'owner-a', agentName: 'Owner' } };
const action = { action: 'pause', goalId: goal.goalId, goalRevision: goal.revision, reason: 'Synthetic only' };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-cli-test-')), token = randomBytes(32).toString('base64url'), requests = [];
  const credential = path.join(root, 'synthetic-credential.json');
  const writeCredential = value => fs.writeFileSync(credential, JSON.stringify({ version: 1, plannerId: 'local-planner', plannerName: 'Synthetic', token: value, issuedAt: new Date().toISOString() }), { mode: 0o600 });
  writeCredential(token);
  let response = null;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, body: body ? JSON.parse(body) : null, planner: req.headers['x-caff-principal'], auth: req.headers.authorization === 'Bearer ' + token });
    res.setHeader('Content-Type', 'application/json');
    if (response) { res.writeHead(response.status, response.headers || {}); res.end(JSON.stringify(response.body)); }
    else res.end(JSON.stringify(req.url.endsWith('/goal') && req.method === 'GET' ? { conversationId: 'room-a', goal } : { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
    CAFF_BASE_URL: `http://127.0.0.1:${server.address().port}`, CAFF_ROOM_ID: 'room-a', CAFF_PLANNER_CREDENTIAL_FILE: credential,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://proxy-sentinel.invalid', ALL_PROXY: 'bad proxy sentinel', CAFF_PLANNER_TOKEN: 'must-not-use', CAFF_CHAT_TOKEN: 'must-not-use' };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  async function run(args, extra = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.once('error', reject);
      child.stdin.end('stdin must never be used');
      child.once('exit', code => resolve({ code, stdout, stderr }));
    });
  }
  return { root, env, requests, credential, writeCredential, run, token, respond: value => { response = value; } };
}

test('CLI entry exists and canonical payload encoding round-trips Unicode/metacharacters without executable syntax', () => {
  assert.ok(fs.existsSync(CLI));
  const value = [{ sequence: 1, disposition: 'needs_user', reason: "Quotes '\"; $(x) `x` & | < > ( ) 中文 😀 \\" }];
  const encoded = api().encodePlannerJson(value);
  assert.match(encoded, /^[\x20-\x7e]+$/); assert.doesNotMatch(encoded, /['$`;|&<>()]/);
  assert.deepEqual(JSON.parse(encoded), value);
  assert.ok(encoded.includes('\\u0022') && encoded.includes('\\u005c'));
});

test('state, full Goal and bounded room attention use fixed paths, explicit planner intent and only the credential file', async t => {
  const f = await fixture(t);
  for (const [args, expected] of [[['state'], '/api/planner/conversations/room-a/state'], [['goal', 'read'], '/api/conversations/room-a/goal'], [['attention', 'read', '--after', '2', '--limit', '10'], '/api/planner/attention?conversationId=room-a&after=2&limit=10&status=unresolved']]) {
    const r = await f.run(args); assert.equal(r.code, 0, r.stderr); assert.equal(f.requests.at(-1).path, expected);
    assert.equal(f.requests.at(-1).planner, 'planner'); assert.equal(f.requests.at(-1).auth, true);
    assert.ok(!r.stdout.includes(f.token) && !r.stderr.includes(f.token));
  }
});

test('closed Goal actions retain preconditions, owner message checks full Goal, finish wraps decoded receipt as data', async t => {
  const f = await fixture(t);
  for (const a of [action, { ...action, action: 'dismiss-proposal', proposalId: 'prop-test' }, { ...action, action: 'set-owner', ownerAgentId: 'owner-b' }, { ...action, action: 'update-delivery', workItems: [{ id: 'w', status: 'done' }] }, { ...action, action: 'revise', decisions: { provisional: [{ id: 'p', statement: 'Synthetic', changeConditions: 'Test' }] } }]) {
    const r = await f.run(['goal', 'action', '--json', ascii(a)]); assert.equal(r.code, 0, r.stderr); assert.deepEqual(f.requests.at(-1).body, a);
  }
  const message = { goalId: goal.goalId, goalRevision: goal.revision, ownerAgentId: 'owner-a', content: 'Synthetic instruction', clientRequestId: 'message-1' };
  assert.equal((await f.run(['owner', 'message', '--json', ascii(message)])).code, 0);
  assert.equal(f.requests.at(-2).path, '/api/conversations/room-a/goal');
  assert.deepEqual(f.requests.at(-1).body, { content: 'Synthetic instruction\n\n@owner-a', clientRequestId: 'message-1' });
  const receipt = [{ sequence: 1, disposition: 'needs_user', reason: "User's approval; no $(shell) 中文" }];
  const r = await f.run(['wakeup', 'finish', '--attempt', attempt, '--json', ascii(receipt)]);
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests.at(-1).path, `/api/conversations/room-a/planner/wakeups/${attempt}/finish`);
  assert.deepEqual(f.requests.at(-1).body, { items: receipt });
});

test('bad commands, rooms, URL/credential overrides, schemas, duplicate keys/flags and oversized input fail before ANY HTTP or credential read', async t => {
  const f = await fixture(t);
  const invalid = [[], ['request', '--url', f.env.CAFF_BASE_URL], ['state', '--room', 'room-b'], ['state', '--room', 'room-a'], ['state', '--url', f.env.CAFF_BASE_URL], ['state', '--token', 'synthetic'], ['state', '--credential-file', f.credential], ['state', '--json', '{}'],
    ['attention', 'read', '--after', '-1'], ['attention', 'read', '--limit', '501'], ['attention', 'read', '--after', '0', '--after', '1'],
    ['goal', 'action', '--json', ascii({ ...action, goalRevision: '3' })], ['goal', 'action', '--json', ascii({ ...action, action: 'set' })], ['goal', 'action', '--json', ascii({ ...action, ruledBy: { kind: 'user' } })],
    ['goal', 'action', '--json', ascii({ ...action, supersedeProposal: true })], ['goal', 'action', '--json', ascii({ ...action, action: 'accept-proposal' })],
    ['goal', 'action', '--json', ascii({ ...action, reason: 'x'.repeat(17000) })], ['goal', 'action', '--json', '{"action":"pause","action":"pause"}'],
    ['goal', 'action', '--json', JSON.stringify({ ...action, reason: ';' })], ['goal', 'action', '--json', '{ "action": "pause" }'],
    ['goal', 'action', '--json', ascii({ ...action, reason: '\u0000' })], ['goal', 'action', '--json', ascii({ ...action, reason: '\ud800' })],
    ['owner', 'message', '--json', ascii({ goalId: goal.goalId, goalRevision: 3, ownerAgentId: 'owner-a', content: '@other routed', clientRequestId: 'm' })],
    ['wakeup', 'finish', '--attempt', '../room-b', '--json', '[]'], ['wakeup', 'finish', '--attempt', attempt, '--json', '[]'],
    ['wakeup', 'finish', '--attempt', attempt, '--json', ascii([{ sequence: 1, disposition: 'handled', reason: 'a' }, { sequence: 1, disposition: 'handled', reason: 'b' }])],
    ['wakeup', 'finish', '--attempt', attempt, '--json', ascii([{ sequence: 1, disposition: 'handled', reason: 'line\nbreak' }])],
  ];
  for (const args of invalid) {
    const r = await f.run(args, { CAFF_PLANNER_CREDENTIAL_FILE: path.join(f.root, 'missing') });
    assert.notEqual(r.code, 0, JSON.stringify(args)); assert.match(r.stderr, /caff_input_invalid|caff_payload_invalid|caff_payload_too_large/);
    assert.equal(f.requests.length, 0, JSON.stringify(args));
  }
});

test('bad or nonliteral instance URL, missing/unsafe room binding and absent/malformed file never use environment tokens', async t => {
  const f = await fixture(t);
  for (const base of ['http://evil.invalid:1234', 'http://127.1:1234', f.env.CAFF_BASE_URL + '/api', f.env.CAFF_BASE_URL + '?x=1', f.env.CAFF_BASE_URL.replace('http:', 'https:'), f.env.CAFF_BASE_URL.replace('http://', 'http://user:pass@')]) {
    const r = await f.run(['state'], { CAFF_BASE_URL: base }); assert.notEqual(r.code, 0); assert.match(r.stderr, /caff_binding_invalid/);
  }
  for (const room of ['', '../room-b', 'room-a?x=1']) assert.notEqual((await f.run(['state'], { CAFF_ROOM_ID: room })).code, 0);
  fs.unlinkSync(f.credential); assert.notEqual((await f.run(['state'])).code, 0);
  f.writeCredential('invalid'); assert.notEqual((await f.run(['state'])).code, 0);
  assert.equal(f.requests.length, 0);
});

test('401, conflicts and redirects are not replayed; no response/diagnostic can print bearer', async t => {
  const f = await fixture(t);
  for (const [status, body, headers] of [[401, { code: 'planner_credential_invalid', error: f.token }], [409, { code: 'goal_revision_conflict' }], [302, { error: f.token }, { Location: 'http://outside.invalid' }]]) {
    f.respond({ status, body, headers }); const before = f.requests.length;
    const r = await f.run(['goal', 'action', '--json', ascii(action)]); assert.notEqual(r.code, 0); assert.equal(f.requests.length, before + 1);
    assert.ok(!r.stdout.includes(f.token) && !r.stderr.includes(f.token));
  }
  f.respond({ status: 200, body: { text: f.token } });
  const r = await f.run(['state']); assert.equal(r.code, 0); assert.ok(!r.stdout.includes(f.token));
});

test('stale owner snapshot never posts a message, and finish HTTP wrapper has an independent budget', async t => {
  const f = await fixture(t); const m = { goalId: goal.goalId, goalRevision: 2, ownerAgentId: 'owner-a', content: 'Synthetic', clientRequestId: 'm' };
  const r = await f.run(['owner', 'message', '--json', ascii(m)]); assert.notEqual(r.code, 0); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
  const items = Array.from({ length: 30 }, (_, i) => ({ sequence: i + 1, disposition: 'no_action', reason: 'a'.repeat(500) }));
  items.at(-1).reason = 'a'.repeat(268);
  assert.equal(ascii(items).length, 16380); assert.ok(JSON.stringify({ items }).length > 16384);
  const before = f.requests.length;
  assert.notEqual((await f.run(['wakeup', 'finish', '--attempt', attempt, '--json', ascii(items)])).code, 0); assert.equal(f.requests.length, before);
});

test('canonical single-call Bash transport preserves escaped finish metacharacters as data with no sentinel side effects', async t => {
  const f = await fixture(t);
  const { buildPlannerWakeupCandidate } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
  const c = buildPlannerWakeupCandidate({ sessionId: attempt, appendPrompt: 'Synthetic' });
  const sentinel = path.join(f.root, 'must-not-exist');
  const receipt = [{ sequence: 1, disposition: 'needs_user', reason: "'\"; touch " + sentinel + '; $(touch ' + sentinel + ') `id` | & 中文 😀' }];
  const command = c.adapterPrefix + ` wakeup finish --attempt ${attempt} --json '` + api().encodePlannerJson(receipt) + "'";
  const child = spawn('bash', ['-c', command], { env: f.env, shell: false, stdio: ['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, stderr); assert.deepEqual(f.requests.at(-1).body, { items: receipt });
  assert.equal(f.requests.length, 1); assert.equal(fs.existsSync(sentinel), false);
});

test('candidate wakeup argv has an exact trusted prefix and closed tool set, but never claims verified policy', () => {
  const { buildPlannerWakeupCandidate } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
  const c = buildPlannerWakeupCandidate({ sessionId: attempt, appendPrompt: 'Synthetic policy', nodePath: process.execPath, adapterPath: CLI });
  assert.equal(c.verified, false); assert.ok(c.adapterPrefix.includes('build/lib/caff.js'));
  assert.deepEqual(c.args.slice(0, 7), ['-p', '--resume', attempt, '--verbose', '--output-format', 'stream-json', '--max-turns']);
  assert.equal(c.args[c.args.indexOf('--max-turns') + 1], '12');
  assert.equal(c.args[c.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
  assert.ok(c.args[c.args.indexOf('--allowedTools') + 1].includes(c.adapterPrefix));
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'PowerShell', 'Agent', 'Task', 'mcp__*']) assert.ok(c.args[c.args.indexOf('--disallowedTools') + 1].split(',').includes(tool));
  assert.ok(!c.args.includes('--dangerously-skip-permissions')); assert.ok(c.args.includes('--strict-mcp-config'));
  assert.throws(() => buildPlannerWakeupCandidate({ sessionId: attempt, appendPrompt: 'x', nodePath: "unsafe'path", adapterPath: CLI }));
});

test('fake print CLI receives the complete candidate argv and piped prompt without enabling any real wakeup', async t => {
  const f = await fixture(t);
  const { buildPlannerWakeupCandidate } = require('../../build/server/domain/runtime/embedded-planner-wakeup-command');
  const c = buildPlannerWakeupCandidate({ sessionId: attempt, appendPrompt: 'Synthetic policy' });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../fixtures/fake-planner-cli.cjs'), ...c.args], { env: f.env, cwd: f.root, shell: false, stdio: ['pipe','pipe','pipe'] });
  child.stdin.end('Synthetic bounded envelope');
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'fake-launch.json'))).argv, c.args);
  assert.equal(f.requests.length, 0);
});
