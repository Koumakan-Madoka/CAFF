// Synthetic sources/SQLite only. Never reads a real account or service DB.
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
function sqliteFixture(t, value = 'synthetic-sqlite-jev-value') {
  const f = fixture(t), Database = require('better-sqlite3'), file = path.join(f.sandboxRoot, 'pi-state.sqlite');
  const db = new Database(file);
  db.exec('CREATE TABLE chat_system_service_credentials (service_type TEXT PRIMARY KEY, api_key TEXT); CREATE TABLE unrelated (value TEXT)');
  db.prepare('INSERT INTO chat_system_service_credentials VALUES (?, ?)').run('turn-time-breakdown-jev', value);
  db.prepare('INSERT INTO chat_system_service_credentials VALUES (?, ?)').run('other-service', 'synthetic-unapproved-service-value');
  db.prepare('INSERT INTO unrelated VALUES (?)').run('synthetic-unapproved-table-value'); db.close();
  f.config.jevSource = 'pi-state.sqlite:turn-time-breakdown-jev';
  Object.defineProperty(f.env, 'TYPESAFE_API_KEY', { get() { throw Error('JEV env must not be read'); } });
  return { ...f, file, Database };
}
test('explicit SQLite source queries only the approved JEV row in read-only mode, stays in memory and leaves database unchanged', t => {
  const f = sqliteFixture(t), before = fs.readFileSync(f.file), names = fs.readdirSync(f.sandboxRoot), statements = [];
  let closed = 0;
  const inventory = load().readKnownKeyValues(f.config, { env: f.env, openDatabase(file, options) {
    assert.equal(file, f.file); assert.deepEqual(options, { readonly: true, fileMustExist: true });
    const db = new f.Database(file, options); assert.equal(db.readonly, true);
    assert.throws(() => db.exec('DELETE FROM chat_system_service_credentials'), /readonly/i);
    return { prepare(sql) { statements.push(sql); const stmt = db.prepare(sql);
      return { get(service) { assert.equal(service, 'turn-time-breakdown-jev'); return stmt.get(service); } }; }, close() { closed++; db.close(); } };
  } });
  assert.deepEqual(statements, ['SELECT api_key FROM chat_system_service_credentials WHERE service_type = ?']);
  assert.equal(closed, 1); assert.equal(JSON.stringify(inventory), '{}');
  assert.ok(inventory.values.includes('synthetic-sqlite-jev-value'));
  assert.ok(inventory.values.includes('synthetic-access-value'));
  assert.ok(!inventory.values.includes('synthetic-unapproved-service-value'));
  assert.ok(!inventory.values.includes('synthetic-unapproved-table-value'));
  assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(fs.readdirSync(f.sandboxRoot), names);
});
test('SQLite inventory can read explicitly approved regular hardlinked auth without changing either path', t => {
  const f = sqliteFixture(t), file = path.join(f.sandboxRoot, 'auth.json'), alias = path.join(f.sandboxRoot, 'synthetic-alias.json');
  const before = fs.readFileSync(file); fs.linkSync(file, alias);
  const inventory = load().readKnownKeyValues(f.config, { env: f.env });
  assert.ok(inventory.values.includes('synthetic-access-value'));
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readFileSync(alias), before);
});
test('SQLite errors are sanitized and connection is closed even when the one approved query fails', t => {
  const f = sqliteFixture(t); let closed = 0;
  assert.throws(() => load().readKnownKeyValues(f.config, { env: f.env, openDatabase() {
    return { prepare() { throw Error('synthetic-private-db-error'); }, close() { closed++; } };
  } }), e => e.code === 'evaluation_known_keys_unavailable' && e.message === e.code && !e.stack.includes('synthetic-private-db-error'));
  assert.equal(closed, 1);
});
test('missing database, row, empty value or schema fail closed without creating a database or falling back to environment', t => {
  for (const mode of ['file', 'row', 'empty', 'schema']) {
    const f = sqliteFixture(t);
    if (mode === 'file') fs.unlinkSync(f.file);
    else { const db = new f.Database(f.file);
      if (mode === 'row') db.prepare('DELETE FROM chat_system_service_credentials WHERE service_type = ?').run('turn-time-breakdown-jev');
      if (mode === 'empty') db.prepare('UPDATE chat_system_service_credentials SET api_key = ? WHERE service_type = ?').run('', 'turn-time-breakdown-jev');
      if (mode === 'schema') db.exec('DROP TABLE chat_system_service_credentials'); db.close(); }
    const before = fs.existsSync(f.file) ? fs.readFileSync(f.file) : null;
    assert.throws(() => load().readKnownKeyValues(f.config, { env: f.env }), /evaluation_known_keys_unavailable/);
    if (before) assert.deepEqual(fs.readFileSync(f.file), before); else assert.equal(fs.existsSync(f.file), false);
  }
});
test('SQLite source rejects linked or directory sources before opening them', t => {
  const f = sqliteFixture(t), moved = f.file + '.real'; fs.renameSync(f.file, moved);
  fs.linkSync(moved, f.file); let opens = 0;
  const options = { env: f.env, openDatabase() { opens++; throw Error(); } };
  assert.throws(() => load().readKnownKeyValues(f.config, options), /evaluation_known_keys_unavailable/);
  assert.equal(opens, 0); fs.unlinkSync(f.file); fs.mkdirSync(f.file);
  assert.throws(() => load().readKnownKeyValues(f.config, options), /evaluation_known_keys_unavailable/); assert.equal(opens, 0);
});
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
