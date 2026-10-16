const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { hash } = require('../helpers/badcase-offline-spec.cjs');
const { selectSealedMaterials } = require('../../scripts/badcase-capture/sealed-workbench.cjs');
function setup(t, mode = 'fresh') {
  const h = fixture(t, mode);
  const options = { captureRoot: h.root, selections: [{ id: 'chosen', projectId: 'p1', conversationId: 'c1', messageId: 'msg1' }],
    image: {}, sources: {}, roles: { baseline: 'baseline', candidate: 'candidate' }, rule: {} };
  const file = path.join(h.root, 'projects/p1/cases', hash('msg1') + '.json');
  return { ...h, options, file };
}
function rewrite(h, change) {
  const value = JSON.parse(fs.readFileSync(h.file)); change(value.record);
  value.checksum = hash(JSON.stringify(value.record)); fs.writeFileSync(h.file, JSON.stringify(value));
}
test('select persisted fresh/resume case by message scope, detached and read-only, no live checkpoint fallback', t => {
  for (const mode of ['fresh', 'resume']) {
    const h = setup(t, mode);
    fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints/cp1.json'));
    const before = h.store.computeUsage('p1');
    const [m] = selectSealedMaterials(h.options);
    assert.deepEqual(m.request.association, h.request.association);
    assert.equal(m.request.flagId, h.request.flagId); assert.equal(m.request.replayRunId, 'selection-' + hash('chosen').slice(0, 32));
    assert.equal(m.id, 'chosen'); assert.equal(m.projectId, 'p1');
    assert.deepEqual(h.store.computeUsage('p1'), before); assert.equal(fs.existsSync(h.runDir), false);
    m.roles.baseline = 'changed'; assert.equal(h.options.roles.baseline, 'baseline');
    assert.equal(JSON.parse(fs.readFileSync(h.file)).record.trajectory.archived, false);
  }
});
test('invalid scope, duplicate ID, injected association/path and absent case refuse without creating storage', t => {
  const h = setup(t), selection = h.options.selections[0];
  for (const selections of [[], Array(65).fill(selection), [selection, selection], [{ ...selection, projectId: '../p1' }],
    [{ ...selection, conversationId: 'wrong' }], [{ ...selection, messageId: 'missing' }], [{ ...selection, association: h.request.association }],
    [{ ...selection, extra: 'valid-text' }]]) {
    assert.throws(() => selectSealedMaterials({ ...h.options, selections }), e => e.code === 'sealed_material_invalid' && !e.message.includes(h.root));
  }
  assert.throws(() => selectSealedMaterials({ ...h.options, captureRoot: path.join(h.root, 'absent') }), /sealed_material_invalid/);
  assert.equal(fs.existsSync(path.join(h.root, 'absent')), false); assert.equal(fs.existsSync(h.runDir), false);
});
test('tampered, oversized, non-UTF8 and invalid case cannot become registry material', t => {
  for (const kind of ['checksum', 'oversized', 'utf8', 'state', 'scope', 'extra']) {
    const h = setup(t);
    if (kind === 'checksum') { const v = JSON.parse(fs.readFileSync(h.file)); v.checksum = '0'.repeat(64); fs.writeFileSync(h.file, JSON.stringify(v)); }
    if (kind === 'oversized') fs.writeFileSync(h.file, ' '.repeat(65537));
    if (kind === 'utf8') fs.appendFileSync(h.file, Buffer.from([255]));
    if (kind === 'state') rewrite(h, r => { r.captured = true; });
    if (kind === 'scope') rewrite(h, r => { r.association.conversationId = 'other'; });
    if (kind === 'extra') rewrite(h, r => { r.output = 'not allowed'; });
    assert.throws(() => selectSealedMaterials(h.options), /sealed_material_invalid/);
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('missing/corrupt retention or blob refuses, never reconstructs from live checkpoint', t => {
  for (const kind of ['retention', 'blob']) {
    const h = setup(t);
    if (kind === 'retention') fs.unlinkSync(h.source);
    else fs.writeFileSync(h.blobPath(h.r.promptBlobHash), 'corrupt');
    assert.throws(() => selectSealedMaterials(h.options), /sealed_material_invalid/);
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
test('static links in each selected storage layer and case file refuse', t => {
  for (const layer of ['root', 'projects', 'project', 'cases', 'file']) {
    const h = setup(t), target = { root: h.root, projects: path.join(h.root, 'projects'), project: path.join(h.root, 'projects/p1'), cases: path.dirname(h.file), file: h.file }[layer];
    const retired = target + '-retired'; fs.renameSync(target, retired);
    t.after(() => { try { fs.unlinkSync(target); } catch {} fs.rmSync(retired, { recursive: true, force: true }); });
    try { fs.symlinkSync(retired, target, layer === 'file' ? 'file' : process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (e) { if (e.code === 'EPERM' && layer === 'file') { t.diagnostic('file symlink unavailable; Linux required'); continue; } throw e; }
    assert.throws(() => selectSealedMaterials(h.options), /sealed_material_invalid/);
  }
});
test('case replaced between lstat/open with identical bytes is rejected', t => {
  const h = setup(t), open = fs.openSync; let swapped = false;
  fs.openSync = function(file, ...args) {
    if (!swapped && file === h.file) {
      swapped = true; fs.renameSync(h.file, h.file + '.old'); fs.copyFileSync(h.file + '.old', h.file);
    }
    return open.call(fs, file, ...args);
  };
  try { assert.throws(() => selectSealedMaterials(h.options), /sealed_material_invalid/); assert.equal(swapped, true); }
  finally { fs.openSync = open; }
});
test('operator config is bounded, exact, UTF8, secret-free and report root is separate', t => {
  const h = setup(t), { readOperatorConfig } = require('../../scripts/badcase-capture/serve-sealed-workbench.cjs');
  const config = { root: path.join(h.root, 'reports'), captureRoot: path.join(h.root, 'capture'), selections: h.options.selections,
    sources: {}, roles: h.options.roles, rule: {}, imageArchive: {}, destination: {} };
  const file = path.join(h.root, 'operator.json'); fs.writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(readOperatorConfig(file), config);
  for (const v of [{ ...config, root: config.captureRoot }, { ...config, root: path.join(config.captureRoot, 'reports') },
    { ...config, captureRoot: path.join(config.root, 'capture') }, { ...config, root: 'relative' }, { ...config, extra: true },
    { ...config, roles: { baseline: 'sk-synthetic12345678', candidate: 'candidate' } }]) {
    fs.writeFileSync(file, JSON.stringify(v)); assert.throws(() => readOperatorConfig(file), /sealed_workbench_config_invalid/);
  }
  for (const bytes of [Buffer.alloc(262145, 32), Buffer.concat([Buffer.from(JSON.stringify(config)), Buffer.from([255])])]) {
    fs.writeFileSync(file, bytes); assert.throws(() => readOperatorConfig(file), /sealed_workbench_config_invalid/);
  }
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/badcase-capture/serve-sealed-workbench.cjs'), '--config', file], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr.trim(), 'sealed_workbench_start_failed');
  assert.equal(fs.existsSync(config.root), false);
});
test('selected server opens only scoped catalog, then previews actual retained material without launch', async t => {
  const h = setup(t), { startSealedWorkbenchServer } = require('../../scripts/badcase-capture/sealed-workbench.cjs');
  const { archiveRuntime } = require('../../scripts/badcase-capture/runtime-archive.cjs');
  const { archiveHarness } = require('../../scripts/badcase-capture/harness-archive.cjs');
  const repo = path.resolve(__dirname, '../..'), image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
  let calls = 0;
  const server = await startSealedWorkbenchServer({ ...h.options, image, root: path.join(h.root, 'approvals'),
    sources: { runtimeArchive: archiveRuntime(repo, path.join(h.root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(h.root, 'harness')) },
    rule: { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') }, runProbe: async () => { calls++; throw Error('must not launch'); } });
  t.after(() => server.close());
  const bootstrap = await (await fetch(server.url + '/api/bootstrap')).json();
  const response = await fetch(server.url + '/api/projects/p1/badcase-evaluations/material-preview', { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: server.url, 'X-CAFF-CSRF-Token': bootstrap.localAdmin.modelProviders.csrfToken }, body: JSON.stringify({ materialId: 'chosen', repetitions: 1 }) });
  assert.equal(response.status, 200); const p = await response.json();
  assert.equal(p.review.deliveryMode, 'fresh'); assert.equal(p.plan.spec.caseId, h.request.flagId);
  assert.equal(p.review.faithfulReplay, false); assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(h.root, 'approvals')), false);
});
test('operator startup validates selection before restore and routes only restored transport into server', async t => {
  const h = setup(t), image = { imageId: 'sha256:' + '1'.repeat(64), repositoryDigest: 'node@sha256:' + '2'.repeat(64), architecture: 'amd64', nodeVersion: 'v24.21.0', pythonVersion: 'Python 3.11.2' };
  const imageModule = require('../../scripts/badcase-capture/image-archive.cjs'), recovery = require('../../scripts/badcase-capture/image-recovery.cjs'), serverModule = require('../../scripts/badcase-capture/workbench-server.cjs');
  const original = { verify: imageModule.verifyImageArchive, restore: recovery.restoreImageArchive, start: serverModule.startScriptedWorkbenchServer };
  const filename = require.resolve('../../scripts/badcase-capture/serve-sealed-workbench.cjs');
  const config = { ...h.options, root: path.join(h.root, 'reports'), imageArchive: { marker: 'archive' }, destination: { marker: 'dedicated' } }; delete config.image;
  const events = [], transport = () => {}, result = { url: 'synthetic' };
  imageModule.verifyImageArchive = ref => { assert.equal(ref, config.imageArchive); events.push('verify'); return { image }; };
  recovery.restoreImageArchive = async (ref, dest) => { assert.equal(ref, config.imageArchive); assert.equal(dest, config.destination); events.push('restore'); return { runProbe: transport }; };
  serverModule.startScriptedWorkbenchServer = async opts => { events.push('server'); assert.equal(opts.runProbe, transport); assert.equal(opts.materials[0].request.flagId, h.request.flagId); return result; };
  try {
    delete require.cache[filename]; const { serve } = require(filename);
    assert.equal(await serve(config), result); assert.deepEqual(events, ['verify', 'restore', 'server']);
    events.length = 0; fs.unlinkSync(h.file);
    await assert.rejects(serve(config), /sealed_material_invalid/); assert.deepEqual(events, ['verify']);
  } finally {
    imageModule.verifyImageArchive = original.verify; recovery.restoreImageArchive = original.restore; serverModule.startScriptedWorkbenchServer = original.start;
    delete require.cache[filename];
  }
});
test('real synthetic capture and HTTP/SQLite sealing feed selector without manual checkpoints', { skip: process.platform !== 'linux', timeout: 60000 }, async t => {
  const fixture = require('../../scripts/badcase-capture/captured-workbench-fixture.cjs');
  for (const mode of ['fresh', 'resume']) {
    const h = await fixture(t, mode);
    fs.unlinkSync(path.join(h.root, 'projects/p1/checkpoints', h.cp.checkpointId + '.json'));
    const [m] = selectSealedMaterials({ captureRoot: h.root, selections: [h.selection], image: {}, sources: {}, roles: {}, rule: {} });
    assert.equal(m.request.association.checkpointId, h.cp.checkpointId);
    assert.equal(h.evidence.collector, true); assert.equal(h.evidence.sqlite, true); assert.equal(h.evidence.trajectoryArchived, false);
    assert.equal(fs.existsSync(h.runDir), false);
  }
});
