const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SubscriptionAuthStoreError,
  readSubscriptionCredential,
  removeSubscriptionCredential,
  writeSubscriptionCredential,
} = require('../../build/server/domain/models/subscription-auth-store');
const { withTempDir } = require('../helpers/temp-dir');

function oauthCredential(overrides = {}) {
  return {
    type: 'oauth',
    access: 'access-token-value',
    refresh: 'refresh-token-value',
    expires: 1893456000000,
    ...overrides,
  };
}

function readAuthJson(agentDir) {
  return JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
}

test('subscription credential writes the pi AuthStorage byte format and preserves other providers', async (t) => {
  const agentDir = withTempDir('caff-subscription-auth-store-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const written = await writeSubscriptionCredential(agentDir, 'anthropic', oauthCredential());
  assert.equal(written, true);

  const authPath = path.join(agentDir, 'auth.json');
  const raw = fs.readFileSync(authPath, 'utf8');
  assert.equal(raw, JSON.stringify({
    anthropic: oauthCredential(),
  }, null, 2));
  assert.ok(!raw.endsWith('\n'), 'pi AuthStorage writes without a trailing newline');

  await writeSubscriptionCredential(agentDir, 'openai-codex', oauthCredential({
    access: 'codex-access',
    refresh: 'codex-refresh',
    accountId: 'chatgpt-account-id',
  }));

  assert.deepEqual(readAuthJson(agentDir), {
    anthropic: oauthCredential(),
    'openai-codex': oauthCredential({
      access: 'codex-access',
      refresh: 'codex-refresh',
      accountId: 'chatgpt-account-id',
    }),
  });

  const removed = await removeSubscriptionCredential(agentDir, 'anthropic');
  assert.equal(removed, true);
  assert.deepEqual(readAuthJson(agentDir), {
    'openai-codex': oauthCredential({
      access: 'codex-access',
      refresh: 'codex-refresh',
      accountId: 'chatgpt-account-id',
    }),
  });

  const removedAgain = await removeSubscriptionCredential(agentDir, 'anthropic');
  assert.equal(removedAgain, false);
});

test('subscription credential writes tighten permissions of a pre-existing wider auth.json', async (t) => {
  const agentDir = withTempDir('caff-subscription-auth-store-mode-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  // Simulate a pre-existing auth.json with wider permissions. writeFileSync's
  // mode option only applies on creation, so without an explicit chmod the
  // store would keep writing OAuth credentials into the wider file.
  const authPath = path.join(agentDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: oauthCredential() }, null, 2), { mode: 0o644 });
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o644);
  }

  // Any locked store operation (even a read) must tighten the existing file.
  const existing = await readSubscriptionCredential(agentDir, 'anthropic');
  assert.equal(existing && existing.access, 'access-token-value');
  if (!isWindows) {
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o600, 'read path must tighten a pre-existing wider auth.json to 0600');
  }

  // The write path keeps the tightened mode as well.
  await writeSubscriptionCredential(agentDir, 'openai-codex', oauthCredential({ accountId: 'acct' }));
  await removeSubscriptionCredential(agentDir, 'openai-codex');
  if (!isWindows) {
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o600, 'write path must keep auth.json at 0600');
  } else {
    // Windows chmod only maps the read-only bit, so just assert the flow works.
    assert.ok(fs.existsSync(authPath));
  }
});

test('subscription credential writes reject malformed credentials and unsafe provider keys', async (t) => {
  const agentDir = withTempDir('caff-subscription-auth-store-invalid-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  await assert.rejects(
    () => writeSubscriptionCredential(agentDir, 'anthropic', { type: 'api_key', key: 'k' }),
    (error) => error instanceof SubscriptionAuthStoreError && error.code === 'credential_invalid'
  );
  await assert.rejects(
    () => writeSubscriptionCredential(agentDir, 'anthropic', oauthCredential({ expires: 'soon' })),
    (error) => error instanceof SubscriptionAuthStoreError && error.code === 'credential_invalid'
  );
  await assert.rejects(
    () => writeSubscriptionCredential(agentDir, '__proto__', oauthCredential()),
    (error) => error instanceof SubscriptionAuthStoreError && error.code === 'credential_key_invalid'
  );

  assert.equal(fs.existsSync(path.join(agentDir, 'auth.json')), false, 'no file is created for rejected writes');
});

test('subscription credential writes fail closed on an unparseable auth.json', async (t) => {
  const agentDir = withTempDir('caff-subscription-auth-store-broken-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{not-json', 'utf8');

  await assert.rejects(
    () => writeSubscriptionCredential(agentDir, 'anthropic', oauthCredential()),
    (error) => error instanceof SubscriptionAuthStoreError && error.code === 'auth_document_invalid'
  );
  assert.equal(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'), '{not-json', 'the broken file is left untouched');
});

test('subscription credential reads are tolerant of missing or malformed auth.json', async (t) => {
  const tempDir = withTempDir('caff-subscription-auth-store-read-');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const emptyDir = path.join(tempDir, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.equal(readSubscriptionCredential(emptyDir, 'anthropic'), undefined);

  const brokenDir = path.join(tempDir, 'broken');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'auth.json'), 'not json', 'utf8');
  assert.equal(readSubscriptionCredential(brokenDir, 'anthropic'), undefined);

  const healthyDir = path.join(tempDir, 'healthy');
  fs.mkdirSync(healthyDir, { recursive: true });
  fs.writeFileSync(path.join(healthyDir, 'auth.json'), JSON.stringify({
    anthropic: oauthCredential(),
    other: { type: 'api_key', key: 'x' },
  }), 'utf8');
  assert.deepEqual(readSubscriptionCredential(healthyDir, 'anthropic'), oauthCredential());
  assert.deepEqual(readSubscriptionCredential(healthyDir, 'missing'), undefined);
});

test('subscription credential writes serialize under the proper-lockfile lock', async (t) => {
  const agentDir = withTempDir('caff-subscription-auth-store-lock-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  await writeSubscriptionCredential(agentDir, 'anthropic', oauthCredential());

  const properLockfile = require('proper-lockfile');
  const release = await properLockfile.lock(path.join(agentDir, 'auth.json'), { realpath: false });
  const concurrentWrite = writeSubscriptionCredential(agentDir, 'openai-codex', oauthCredential());
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(readAuthJson(agentDir)['openai-codex'], undefined, 'write is blocked while the lock is held');

  await release();
  await concurrentWrite;
  assert.deepEqual(readAuthJson(agentDir)['openai-codex'], oauthCredential());
});
