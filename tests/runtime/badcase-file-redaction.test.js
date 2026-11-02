const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { redactFileSecrets, containsSecretSentinel, SECRET_REDACTION_PLACEHOLDER } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const secret = 'sk-' + 'syntheticfixture123456789';

test('file redaction owns safe bytes, retains ordinary text, is deterministic and idempotent', () => {
  const input = Buffer.from('unchanged 中文\n');
  const safe = redactFileSecrets(input);
  assert.deepEqual(safe.content, input); assert.equal(safe.redactionCount, 0);
  assert.equal(safe.content.buffer.byteLength, input.length);
  input.fill(0); assert.equal(safe.content.toString(), 'unchanged 中文\n');
  const a = redactFileSecrets(Buffer.from('before ' + secret + ' after\n'));
  assert.equal(a.content.toString(), 'before ' + SECRET_REDACTION_PLACEHOLDER + ' after\n');
  assert.equal(a.redactionCount, 1); assert.equal(containsSecretSentinel(a.content), false);
  assert.deepEqual(redactFileSecrets(a.content).content, a.content);
  assert.equal(redactFileSecrets(a.content).redactionCount, 0);
});

test('redacts all token families and generic assignments, not their surrounding file', () => {
  for (const value of [secret, 'ghp_syntheticfixture12345', 'github_pat_syntheticfixture12345', 'xoxb-syntheticfixture12345']) {
    const result = redactFileSecrets(Buffer.from('prefix ' + value + ' suffix'));
    assert.equal(result.content.toString(), 'prefix ' + SECRET_REDACTION_PLACEHOLDER + ' suffix');
    assert.equal(containsSecretSentinel(result.content), false);
  }
  const input = 'API_KEY="opaque-value-12345";\npassword=another-value\naccess_token: \'opaque-value-67890\'\nnormal=keep\n';
  const result = redactFileSecrets(Buffer.from(input));
  assert.equal(result.content.toString(), 'API_KEY="' + SECRET_REDACTION_PLACEHOLDER + '";\npassword=' + SECRET_REDACTION_PLACEHOLDER + '\naccess_token: \'' + SECRET_REDACTION_PLACEHOLDER + '\'\nnormal=keep\n');
  assert.equal(result.redactionCount, 3); assert.equal(containsSecretSentinel(result.content), false);
});

test('private keys redact their whole body; truncated keys redact through EOF', () => {
  for (const kind of ['', 'RSA ', 'EC ', 'OPENSSH ', 'PGP ']) {
    const key = '-----BEGIN ' + kind + 'PRIVATE KEY-----\nSYNTHETIC_PRIVATE_BODY\n-----END ' + kind + 'PRIVATE KEY-----';
    const result = redactFileSecrets(Buffer.from('before\n' + key + '\nafter'));
    assert.equal(result.content.toString(), 'before\n' + SECRET_REDACTION_PLACEHOLDER + '\nafter');
  }
  assert.equal(redactFileSecrets(Buffer.from('prefix\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_BODY')).content.toString(), 'prefix\n' + SECRET_REDACTION_PLACEHOLDER);
});

test('binary and non-UTF8 bytes survive except matched high-confidence secrets', () => {
  const prefix = Buffer.from([255, 0, 128]), suffix = Buffer.from([0, 254]);
  const input = Buffer.concat([prefix, Buffer.from(secret), suffix]);
  const result = redactFileSecrets(input);
  assert.deepEqual(result.content, Buffer.concat([prefix, Buffer.from(SECRET_REDACTION_PLACEHOLDER), suffix]));
  assert.equal(result.redactionCount, 1); assert.equal(containsSecretSentinel(result.content), false);
  const binaryAssignment = Buffer.from('password=not-a-real-key\0');
  assert.deepEqual(redactFileSecrets(binaryAssignment).content, binaryAssignment, 'preserves existing binary high-confidence-only scan policy');
});

test('explicit known values are replaced literally even without a sentinel; no original hash or value in metadata', () => {
  const value = 'opaque.synthetic.known.value';
  const input = Buffer.from('prefix ' + value + ' suffix ' + value);
  const result = redactFileSecrets(input, [value]);
  assert.equal(result.content.toString(), 'prefix ' + SECRET_REDACTION_PLACEHOLDER + ' suffix ' + SECRET_REDACTION_PLACEHOLDER);
  assert.equal(result.redactionCount, 2);
  assert.deepEqual(Object.keys(result).sort(), ['content', 'redactionCount']);
  assert.equal(JSON.stringify(result).includes(value), false);
  const longer = secret + '.opaque-suffix';
  assert.equal(redactFileSecrets(Buffer.from(longer), [secret, longer]).content.toString(), SECRET_REDACTION_PLACEHOLDER,
    'whole known values precede token-shaped prefixes');
});

test('Linux collector stores and restores placeholders, not secrets, without treating redaction as missing input', { skip: require('../helpers/capture-capability').capSkip }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-file-redaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'source'); fs.mkdirSync(target);
  const original = Buffer.from('API_KEY=' + secret + '\nkeep=yes\n');
  fs.writeFileSync(path.join(target, 'settings.txt'), original);
  const service = require('../../build/server/domain/runtime/badcase-capture').createBadcaseCaptureService({ captureRoot: path.join(root, 'capture') });
  service.savePolicy('p', { status: 'enabled', authorizedDirs: [target], authorizedInputDirs: [] }); service.authorizeProject('p');
  const result = service.captureTurnCheckpoint({ projectId: 'p', targetDir: target, conversationId: 'c', turnId: 't', agentId: 'a',
    deliveryMode: 'fresh', prompt: 'Read settings.', controlledValues: {}, runConfig: { provider: 'test', model: 'test', promptVersion: 'v1' },
    harness: { serverVersion: 'test', skillSnapshots: [], configSnapshot: { piVersion: '0.85.1', deliveryMode: 'fresh', agentName: 'Test', agentPromptVersion: 'v1', toolBridgeEnabled: true } } });
  assert.equal(result.captured, true, result.reason);
  const cp = result.checkpoint, entry = cp.files['settings.txt'];
  assert.equal(entry.secretExcluded, undefined); assert.equal(entry.secretRedacted, true);
  assert.equal(entry.originalSize, original.length); assert.equal(entry.redactionCount, 1);
  assert.notEqual(entry.hash, hash(original));
  const retained = service.store.readBlob('p', entry.hash);
  assert.equal(retained.toString(), 'API_KEY=' + SECRET_REDACTION_PLACEHOLDER + '\nkeep=yes\n');
  assert.equal(entry.size, retained.length); assert.equal(entry.hash, hash(retained));
  assert.deepEqual(cp.replayInput.secretRedactedPaths, ['settings.txt']);
  assert.equal(cp.replayInput.incompleteReasons.includes('files_contain_secret'), false);
  assert.equal(cp.stats.secretExcludedFiles, 0); assert.equal(cp.stats.secretRedactedFiles, 1);
  assert.equal(cp.consistency.retries, 0, 'sanitized hashes must agree in scan/write/rescan');
  const restored = service.restoreCheckpoint({ projectId: 'p', checkpointId: result.checkpointId, targetDir: path.join(root, 'restored') });
  assert.equal(restored.ok, true); assert.deepEqual(restored.missingSecrets, []);
  assert.deepEqual(restored.redactedFiles, [{ path: 'settings.txt', byteIdenticalToSource: false, originalSize: original.length, restoredSize: retained.length, redactionCount: 1 }]);
  assert.deepEqual(fs.readFileSync(path.join(root, 'restored', 'settings.txt')), retained);
  assert.deepEqual(fs.readFileSync(path.join(target, 'settings.txt')), original, 'never rewrites the source');
  const scan = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name))]);
  assert.equal(Buffer.concat(scan(path.join(root, 'capture'))).includes(Buffer.from(secret)), false);
  const second = service.captureTurnCheckpoint({ projectId: 'p', targetDir: target, deliveryMode: 'fresh', prompt: 'Read settings.' });
  assert.equal(second.captured, true); assert.equal(second.checkpoint.files['settings.txt'].secretRedacted, true);
  assert.deepEqual(second.checkpoint.replayInput.secretRedactedPaths, ['settings.txt']);
});
