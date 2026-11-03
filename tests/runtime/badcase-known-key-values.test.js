// Synthetic sources only. Never reads a real account/JEV key or service DB.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'known-key-values-')), sandboxRoot = path.join(root, '.pi-sandbox'); fs.mkdirSync(sandboxRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const models = { providers: { a: { apiKey: 'synthetic-provider-value' }, b: { apiKey: '$TEST_PROVIDER_KEY' } } };
  const auth = { a: { type: 'api_key', key: 'synthetic-api-key-value' }, b: { type: 'oauth', access: 'synthetic-access-value', refresh: 'synthetic-refresh-value', token: 'synthetic-extra-token', expires: 1, accountId: 'not-a-key-value' } };
  fs.writeFileSync(path.join(sandboxRoot, 'models.json'), JSON.stringify(models)); fs.writeFileSync(path.join(sandboxRoot, 'auth.json'), JSON.stringify(auth));
  return { sandboxRoot, models, auth, config: { sandboxRoot, jevSource: 'TYPESAFE_API_KEY' }, env: { TEST_PROVIDER_KEY: 'synthetic-environment-provider-value', TYPESAFE_API_KEY: 'synthetic-jev-value' } };
}
const load = () => require('../../scripts/badcase-capture/known-key-values.cjs');
test('all provider API keys, auth key/token values and explicit JEV key are collected only in a non-serializable in-memory inventory', t => {
  const f = fixture(t), before = ['models.json', 'auth.json'].map(n => fs.readFileSync(path.join(f.sandboxRoot, n)));
  const inventory = load().readKnownKeyValues(f.config, { env: f.env });
  assert.equal(JSON.stringify(inventory), '{}');
  assert.deepEqual([...inventory.values].sort(), ['synthetic-provider-value', 'synthetic-environment-provider-value', 'synthetic-api-key-value',
    'synthetic-access-value', 'synthetic-refresh-value', 'synthetic-extra-token', 'synthetic-jev-value'].sort());
  ['models.json', 'auth.json'].forEach((n, i) => assert.deepEqual(fs.readFileSync(path.join(f.sandboxRoot, n)), before[i]));
});
test('absent/malformed sources, missing JEV or unresolved/command-based model keys fail closed without discovery or shell execution', t => {
  const f = fixture(t);
  assert.throws(() => load().readKnownKeyValues(f.config, { env: {} }), /evaluation_known_keys_unavailable/);
  assert.throws(() => load().readKnownKeyValues({ ...f.config, jevSource: 'OTHER' }, { env: f.env }), /evaluation_known_keys_unavailable/);
  fs.writeFileSync(path.join(f.sandboxRoot, 'models.json'), JSON.stringify({ providers: { a: { apiKey: '!do-not-execute' } } }));
  assert.throws(() => load().readKnownKeyValues(f.config, { env: f.env }), /evaluation_known_keys_unavailable/);
  fs.writeFileSync(path.join(f.sandboxRoot, 'models.json'), '{invalid');
  assert.throws(() => load().readKnownKeyValues(f.config, { env: f.env }), /evaluation_known_keys_unavailable/);
  fs.unlinkSync(path.join(f.sandboxRoot, 'models.json'));
  assert.throws(() => load().readKnownKeyValues(f.config, { env: f.env }), /evaluation_known_keys_unavailable/);
});
