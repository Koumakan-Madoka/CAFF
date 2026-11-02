const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { startOperatorCli, containerLifecycleEvidence } = require('../../scripts/badcase-capture/cli-verification.cjs');
function script(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-cli-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'child.cjs'); fs.writeFileSync(file, source); return file;
}
const ready = { url: 'http://127.0.0.1:12345', mode: 'offline-scripted-workbench', realModel: false, faithfulReplay: false, note: 'synthetic' };
test('CLI supervisor parses real child readiness, uses minimal env and waits for clean owned exit', { timeout: 10000, skip: process.platform === 'win32' }, async t => {
  const file = script(t, `const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['--config', ${JSON.stringify(path.resolve('synthetic-config'))}]);
    assert.equal(process.env.CAFF_CLI_TEST_PRIVATE, undefined);
    console.log(${JSON.stringify(JSON.stringify(ready))});
    const timer = setInterval(() => {}, 1000); process.on('SIGTERM', () => clearInterval(timer));`);
  process.env.CAFF_CLI_TEST_PRIVATE = 'must-not-inherit';
  let child;
  try { child = await startOperatorCli(path.resolve('synthetic-config'), { script: file, timeoutMs: 3000 }); }
  finally { delete process.env.CAFF_CLI_TEST_PRIVATE; }
  assert.equal(child.url, ready.url); assert.ok(child.pid > 0);
  await child.close(); await child.close();
  assert.equal(child.exitCode, 0); assert.equal(child.exitSignal, null);
});
test('CLI supervisor never accepts a nonzero post-readiness exit as a clean shutdown', { timeout: 10000 }, async t => {
  const file = script(t, `console.log(${JSON.stringify(JSON.stringify(ready))}); setTimeout(() => process.exit(23), 100);`);
  const child = await startOperatorCli(path.resolve('synthetic-config'), { script: file, timeoutMs: 3000 });
  await new Promise(resolve => setTimeout(resolve, 250));
  await assert.rejects(child.close(), /operator_cli_exit_failed/); assert.equal(child.exitCode, 23);
});
test('CLI supervisor rejects bad readiness, early exit, excessive output and startup timeout without leaking output', { timeout: 15000 }, async t => {
  for (const source of [
    `console.log(${JSON.stringify(JSON.stringify({ ...ready, url: 'http://evil.example:12345' }))});`,
    `console.log(${JSON.stringify(JSON.stringify({ ...ready, realModel: true }))});`,
    `console.log('private-body');`, `process.exit(2);`,
    `console.log('x'.repeat(8192));`, `setInterval(() => {}, 1000);`,
  ]) {
    const file = script(t, source);
    await assert.rejects(startOperatorCli(path.resolve('synthetic-config'), { script: file, timeoutMs: 500 }),
      e => e.message === 'operator_cli_verification_failed');
  }
});
function events() {
  return ['a', 'b'].flatMap(c => ['create', 'start', 'die', 'destroy'].map((Action, i) => ({ Type: 'container', Action,
    Actor: { ID: c.repeat(64), Attributes: { image: 'sha256:' + '1'.repeat(64), name: 'caff-pi-init-owner-' + c,
      'caff.badcase.pi-initialization': 'owner-' + c, ...(Action === 'die' ? { exitCode: '0' } : {}) } }, timeNano: i + 1 })));
}
test('independent target-daemon history requires complete, ordered, unique successful container lifecycles', () => {
  const imageId = 'sha256:' + '1'.repeat(64), good = events();
  assert.deepEqual(containerLifecycleEvidence(good, imageId, 2), ['a'.repeat(64), 'b'.repeat(64)]);
  for (const mutate of [e => e.pop(), e => e.push(e[0]), e => { e[0].Actor.ID = 'g'.repeat(64); },
    e => { e[0].Actor.Attributes.image = 'other'; }, e => { delete e[0].Actor.Attributes['caff.badcase.pi-initialization']; },
    e => { e[2].Actor.Attributes.exitCode = '1'; }, e => { e[3].timeNano = 1; },
    e => { e[3].Action = 'kill'; }, e => { e[0].Actor.Attributes.name = 'other'; },
    e => { e[1].Actor.Attributes['caff.badcase.pi-initialization'] = 'other'; },
    e => { e[1].Actor.Attributes['caff.badcase.pi-initialization'] = 'intruder'; e[1].Actor.Attributes.name = 'caff-pi-init-intruder'; }]) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => containerLifecycleEvidence(bad, imageId, 2));
  }
  assert.throws(() => containerLifecycleEvidence(good, imageId, 4));
});
