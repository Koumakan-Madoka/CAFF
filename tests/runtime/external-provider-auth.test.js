const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readExternalAuthProviderIds } = require('../../build/server/domain/models/external-provider-auth');
const { withTempDir } = require('../helpers/temp-dir');

test('external provider auth reads only provider ids from the resolved agentDir auth.json', (t) => {
  const tempDir = withTempDir('caff-external-provider-auth-');
  const agentDir = path.join(tempDir, 'agent');
  const fallbackDir = path.join(tempDir, 'fallback');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(fallbackDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({
    moonshot: { type: 'api_key', key: 'external-auth-secret' },
    anthropic: { type: 'oauth', access: 'oauth-access-secret' },
    malformed: null,
  }), 'utf8');
  fs.writeFileSync(path.join(fallbackDir, 'auth.json'), JSON.stringify({
    openai: { type: 'api_key', key: 'fallback-secret' },
  }), 'utf8');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  assert.deepEqual([...readExternalAuthProviderIds(agentDir)].sort(), ['anthropic', 'moonshot']);
});

test('external provider auth fails closed for missing or malformed auth.json', (t) => {
  const tempDir = withTempDir('caff-external-provider-auth-invalid-');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  assert.deepEqual([...readExternalAuthProviderIds(tempDir)], []);
  fs.writeFileSync(path.join(tempDir, 'auth.json'), '{not json}', 'utf8');
  assert.deepEqual([...readExternalAuthProviderIds(tempDir)], []);
});
