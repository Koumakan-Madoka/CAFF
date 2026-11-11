// Structured trace observations only. No model or historical shell execution.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const base = '../../build/server/domain/runtime/badcase-capture/';
const api = () => require(base + 'wiki-trace-tool-checks');
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const check = (patch = {}) => ({ method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call',
  rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }], ...patch });
function evidence(rows = []) {
  const executionId = crypto.randomUUID();
  return { kind: 'evaluation-goal-evidence-v1', executionId, goalState: 'unseeded', seed: null, seedHash: hash(null),
    calls: rows.map((row, i) => ({ executionId, sequence: i + 1, endpoint: 'goal/suggest', parameters: { action: 'pause', reason: 'valid' },
      statusCode: 200, errorCode: null, response: { ok: true }, ...row })) };
}
const receipt = (...rows) => ({ goalEvidence: evidence(rows) });
const result = (r, c = check()) => api().checkWikiTraceTools(r, c);
const expect = (r, status, reason = null) => assert.deepEqual(r, { status, reason });

test('callback parameters, not bash strings or HTTP success, decide all observed calls', () => {
  expect(result(receipt({ parameters: { reason: 'x'.repeat(1000) } })), 'pass');
  const rejected = { parameters: { reason: 'x'.repeat(1001) }, statusCode: 400, response: { error: 'Goal proposal reason must be 1000 characters or fewer' } };
  expect(result(receipt(rejected)), 'fail', 'tool_rule_failed');
  expect(result(receipt({ parameters: { reason: 'valid' } }, rejected)), 'fail', 'tool_rule_failed');
  expect(result(receipt(rejected, { parameters: { reason: 'valid' } })), 'fail', 'tool_rule_failed');
  expect(result(receipt({ statusCode: 400, response: { error: 'other production refusal' } })), 'pass');
  const r = receipt(); r.toolCalls = [{ name: 'bash', args: { command: 'node bridge suggest-goal --reason valid' }, isError: false }];
  expect(result(r), 'unreached', 'target_not_called'); // never infer a callback from shell text
  Object.defineProperty(r, 'toolCalls', { get() { throw Error('bash observations must not be read'); } });
  expect(result(r), 'unreached', 'target_not_called');
});

test('on-call absence, forbid absence and missing records are distinct; no inferred unsupported endpoints', () => {
  expect(result(receipt()), 'unreached', 'target_not_called');
  expect(result(receipt(), check({ mode: 'forbid' })), 'pass');
  for (const c of [check(), check({ mode: 'forbid' })]) expect(result({}, c), 'invalid', 'tool_evidence_unavailable');
  expect(result(receipt(), check({ target: { kind: 'caff-chat', name: 'send-private' }, mode: 'forbid' })), 'invalid', 'tool_evidence_unavailable');
  expect(result({ get goalEvidence() { throw Error('unconfigured checks must not read evidence'); } }, null), 'unconfigured');
});

test('redaction, absent or non-scalar parameters cannot pass; decisive violations beat unresolved siblings', () => {
  for (const parameters of [{}, { reason: undefined }, { reason: {} }, { reason: [] }]) {
    expect(result(receipt({ parameters })), 'invalid', 'arguments_unparseable');
  }
  const redacted = { parameters: null, redacted: true, statusCode: 400, response: { error: 'evaluation_callback_body_invalid' } };
  expect(result(receipt(redacted)), 'invalid', 'arguments_unparseable');
  expect(result(receipt(redacted, { parameters: { reason: 'x'.repeat(1001) } })), 'fail', 'tool_rule_failed');
});

test('all rule kinds retain run semantics: trimmed UTF-16 String(value || empty), every rule and every call', () => {
  for (const [reason, max, status] of [['  合格  ', 2, 'pass'], ['😀', 1, 'fail'], [true, 4, 'pass'], [false, 0, 'pass'], [0, 0, 'pass'], [null, 0, 'pass']]) {
    expect(result(receipt({ parameters: { reason } }), check({ rules: [{ parameter: 'reason', kind: 'max-chars', max }] })), status, status === 'fail' ? 'tool_rule_failed' : null);
  }
  const rules = [{ parameter: 'action', kind: 'allowed-values', values: ['pause'] }, { parameter: 'reason', kind: 'forbidden-values', values: ['bad'] }];
  expect(result(receipt(), check({ mode: 'forbid', rules })), 'pass');
  expect(result(receipt({ parameters: { action: 'pause', reason: 'ok' } }), check({ rules })), 'pass');
  expect(result(receipt({ parameters: { action: 'complete', reason: 'ok' } }), check({ rules })), 'fail', 'tool_rule_failed');
  expect(result(receipt({ parameters: { action: 'pause', reason: 'bad' } }), check({ rules, mode: 'forbid' })), 'fail', 'tool_rule_failed');
});

test('supported CAFF endpoint identities and explicit CLI field aliases use recorded parsed values', () => {
  const rows = [
    ['goal/suggest', { action: 'pause' }, 'suggest-goal', 'action', 'pause'],
    ['goal/update', { goal: {} }, 'update-goal', 'goal', null],
    ['context', { publicLimit: '5' }, 'read-context', 'public-limit', '5'],
    ['participants', {}, 'list-participants', 'missing', null],
    ['post-message', { visibility: 'public', content: 'Ready', noFinalize: true }, 'send-public', 'no-finalize', 'true'],
  ];
  for (const [endpoint, parameters, name, parameter, value] of rows) {
    const r = receipt({ endpoint, parameters });
    const c = check({ target: { kind: 'caff-chat', name }, rules: [{ parameter, kind: 'allowed-values', values: [value ?? 'not-a-scalar'] }] });
    expect(result(r, c), value === null ? 'invalid' : 'pass', value === null ? 'arguments_unparseable' : null);
  }
  expect(result(receipt({ endpoint: 'post-message', parameters: { visibility: 'private', content: 'rejected' }, statusCode: 400, response: { error: 'evaluation_callback_body_invalid' } }),
    check({ target: { kind: 'caff-chat', name: 'send-public' }, mode: 'forbid' })), 'pass');
  expect(result(receipt({ endpoint: 'post-message', parameters: null, redacted: true, statusCode: 400, response: { error: 'evaluation_callback_body_invalid' } }),
    check({ target: { kind: 'caff-chat', name: 'send-public' }, mode: 'forbid' })), 'invalid', 'arguments_unparseable');
});

test('native tools use args from session events; bash commands remain opaque even for the native bash target', () => {
  const native = check({ target: { kind: 'native', name: 'read' }, rules: [{ parameter: 'path', kind: 'allowed-values', values: ['safe.txt'] }] });
  expect(result({ toolCalls: [{ name: 'read', args: { path: 'safe.txt' }, isError: true }] }, native), 'pass');
  expect(result({ toolCalls: [{ name: 'read', args: { path: 'other.txt' }, isError: false }] }, native), 'fail', 'tool_rule_failed');
  expect(result({ toolCalls: [{ name: 'read', arguments: { path: 'safe.txt' }, isError: false }] }, native), 'invalid', 'arguments_unparseable');
  expect(result({ toolCalls: [{ name: 'write', isError: false }] }, native), 'unreached', 'target_not_called');
  expect(result({}, native), 'invalid', 'tool_evidence_unavailable');
  expect(result({ toolCalls: [] }, { ...native, mode: 'forbid' }), 'pass');
  expect(result({ toolCalls: [{ name: 'read', args: { path: 'safe.txt' }, isError: false }, { name: 'read', args: { path: 'other.txt' }, isError: false }] }, native), 'fail', 'tool_rule_failed');
  const command = "cat <<'EOF' | node -e 'opaque'\nbody\nEOF";
  expect(result({ toolCalls: [{ name: 'bash', args: { command }, isError: false }] }, check({ target: { kind: 'native', name: 'bash' },
    rules: [{ parameter: 'command', kind: 'allowed-values', values: [command] }] })), 'pass');
});

test('corrupt execution-bound ledgers throw integrity errors without falling back to shell text', () => {
  for (const mutate of [v => v.seedHash = '0'.repeat(64), v => v.calls[0].executionId = crypto.randomUUID(), v => v.calls[0].sequence = 2,
    v => v.calls[0].errorCode = 'forged', v => v.calls[0].parameters.callbackToken = 'not-auth']) {
    const r = receipt({}); mutate(r.goalEvidence);
    assert.throws(() => result(r), { code: 'evaluation_goal_evidence_invalid' });
  }
});

test('archived #21–#24 shell fixtures remain data-only and cannot override callback parameter observations', () => {
  const fixture = require('../fixtures/wikiskill-run-tool-call-command-shapes.json');
  const bytes = JSON.stringify(fixture);
  // Both injected synthetic ledgers must override EVERY archived shell shape.
  // This is not a claim to have reconstructed any historical callback ledger.
  for (const item of fixture.items) for (const length of [862, 1001]) {
    const r = receipt({ parameters: { action: 'pause', reason: 'x'.repeat(length) } });
    r.toolCalls = item.toolCalls.map(c => ({ name: c.name, args: c.arguments, isError: false }));
    expect(result(r), length > 1000 ? 'fail' : 'pass', length > 1000 ? 'tool_rule_failed' : null);
  }
  assert.equal(JSON.stringify(fixture), bytes);
});

test('native trace and single-run rules share exactly the same result for scalar/missing/multiple calls', () => {
  const { prepareWikiRunChecks } = require(base + 'wiki-run-checks');
  for (const mode of ['on-call', 'forbid']) for (const rule of [
    { parameter: 'value', kind: 'max-chars', max: 4 },
    { parameter: 'value', kind: 'allowed-values', values: ['true', 'good'] },
    { parameter: 'value', kind: 'forbidden-values', values: ['bad'] },
  ]) for (const values of [[], ['good'], ['bad'], ['good', 'bad'], [true], [false], [null], [0], [5], [{}], [undefined], ['😀😀😀']]) {
    const c = check({ target: { kind: 'native', name: 'read' }, mode, rules: [rule] });
    const content = values.map(value => ({ type: 'toolCall', name: 'read', arguments: value === undefined ? {} : { value } }));
    const message = { role: 'assistant', stopReason: content.length ? 'toolUse' : 'stop', content: content.length ? content : [{ type: 'text', text: 'Ready' }] };
    const run = prepareWikiRunChecks(message, { questions: [], toolCheck: c });
    assert.deepEqual(result({ toolCalls: content.map(b => ({ name: b.name, args: b.arguments, isError: false })) }, c), run.tool);
  }
});

async function callback(t) {
  const { SYSTEM_MODEL_FAMILY_ROLES } = require('../../build/server/domain/roles/system-role-catalog');
  const family = SYSTEM_MODEL_FAMILY_ROLES.find(a => a.id === 'role-family-gpt');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-trace-records-'));
  const association = { projectId: 'synthetic-project', conversationId: 'synthetic-room', turnId: 'synthetic-turn', agentId: family.id, userMessageId: 'synthetic-user', assistantMessageId: 'synthetic-assistant' };
  const trace = JSON.stringify({ schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association,
    assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Synthetic marked-badcase', type: 'standard', metadata: {} },
    participants: [{ id: family.id, name: family.name, description: family.description }], publicMessages: [{ id: association.userMessageId, turnId: association.turnId,
      role: 'user', agentId: null, senderName: 'User', content: 'Synthetic task', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] });
  const service = await require(base + 'evaluation-callback').startEvaluationCallback({ directory: path.join(root, 'callback'), trace,
    association, expectedTraceHash: crypto.createHash('sha256').update(trace).digest('hex'), lifetimeMs: 60000 });
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return service;
}
async function shell(s, command) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { CAFF_CHAT_API_URL: s.apiUrl, CAFF_CHAT_INVOCATION_ID: s.credentials.invocationId,
    CAFF_CHAT_CALLBACK_TOKEN: s.credentials.callbackToken, CAFF_CHAT_TOOLS_PATH: path.resolve(__dirname, '../../build/lib/agent-chat-tools.js').replaceAll('\\', '/') });
  await new Promise((resolve, reject) => {
    const p = spawn('bash', ['-s'], { env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { p.kill(); reject(Error('synthetic CLI timeout')); }, 15000);
    p.once('error', e => { clearTimeout(timer); reject(e); }); p.once('close', () => { clearTimeout(timer); resolve(); }); p.stdin.end(command);
  });
}

test('real CLI on isolated callback: synthetic #21–#24-shaped pipeline/heredoc/inline-node calls are judged from records', async t => {
  const s = await callback(t);
  // These are NEW bounded synthetic commands. The archived DATA ONLY fixture is
  // never executed. Shapes and measured lengths mirror #22/29, #23/44, #24/42,
  // #23/45; only our disposable callback is reachable and no agent is run.
  const inline = n => `node "$CAFF_CHAT_TOOLS_PATH" suggest-goal --action pause --reason '${'x'.repeat(n)}'`;
  const synthetic = [
    [inline(1030), 1030, 400],
    [inline(1372) + " | node -e 'process.stdin.resume()'", 1372, 400],
    [inline(1172) + " | node -e 'process.stdin.resume()'", 1172, 400],
    ["cat <<'CAFF_SYNTHETIC_EOF' | node -e 'let s=\"\";process.stdin.on(\"data\",b=>s+=b).on(\"end\",()=>{require(\"node:child_process\").spawnSync(process.execPath,[process.env.CAFF_CHAT_TOOLS_PATH,\"suggest-goal\",\"--action\",\"pause\",\"--reason\",s.trim()],{stdio:\"inherit\"});});'\n" + 'x'.repeat(862) + '\nCAFF_SYNTHETIC_EOF\n', 862, 200],
  ];
  for (const [command, length, statusCode] of synthetic) {
    const before = s.readGoalEvidence().calls.length;
    await shell(s, command);
    const full = s.readGoalEvidence(), last = full.calls.at(-1);
    assert.equal(full.calls.length, before + 1); assert.equal(last.parameters.reason.length, length); assert.equal(last.statusCode, statusCode);
    // Each execution-wide ledger checks EVERY call. Select a new one-call ledger
    // for the per-shape assertion while retaining real handler params/response.
    const one = { ...full, calls: [{ ...last, sequence: 1 }] };
    expect(result({ goalEvidence: one, toolCalls: [{ name: 'bash', args: { command }, isError: statusCode >= 400 }] }), length > 1000 ? 'fail' : 'pass', length > 1000 ? 'tool_rule_failed' : null);
  }
  expect(result({ goalEvidence: s.readGoalEvidence() }), 'fail', 'tool_rule_failed');
});
