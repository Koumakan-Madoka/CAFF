#!/usr/bin/env node
// Trusted, offline, one-source -> fresh production-layout copy. Never opens a
// chat DB, credentials, a live worktree, Docker or network. No merge/overwrite.
// Source writers must be quiescent; re-inventory before atomic publication
// detects drift without acquiring locks (which would modify the source).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { readSealedCase, validateSealRequest } = require(base + 'sealed-case');
const { createCaptureStore } = require(base + 'capture-store');
const { createCheckpointRetentionStore } = require(base + 'checkpoint-retention');
const { resolveSampleReplayVersion } = require(base + 'wiki-sample-replay-version');
const { hashFile, hashJson } = require('./replay-streams.cjs');
const fail = code => Object.assign(Error(code), { code });
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const check = (v, code = 'wiki_migration_record_invalid') => { if (!v) throw fail(code); };
function plainPath(file) {
  // Static symlinks/junctions are not supported. Same-OS-user trusted storage;
  // not an openat2/path-swap sandbox against a hostile concurrent OS user.
  let current = path.resolve(file);
  for (;;) {
    try { check(!fs.lstatSync(current).isSymbolicLink(), 'wiki_migration_layout_invalid'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function inside(a, b) { const r = path.relative(a, b); return !r || !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep); }
function configuration(config) {
  check(config && Object.keys(config).sort().join(',') === 'captureRoots,destinationAgentDir,globalRoot,sourceWorktree', 'wiki_migration_config_invalid');
  check(Array.isArray(config.captureRoots) && config.captureRoots.length <= 100, 'wiki_migration_config_invalid');
  const fields = [config.globalRoot, config.sourceWorktree, config.destinationAgentDir, ...config.captureRoots];
  check(fields.every(p => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0')), 'wiki_migration_config_invalid');
  const [globalRoot, sourceWorktree, destinationAgentDir, ...captureRoots] = fields.map(p => path.resolve(p));
  check(new Set(captureRoots).size === captureRoots.length, 'wiki_migration_config_invalid');
  fields.forEach(plainPath);
  const sources = [globalRoot, ...captureRoots];
  check(!sources.some(s => inside(s, destinationAgentDir) || inside(destinationAgentDir, s)) && !inside(sourceWorktree, destinationAgentDir), 'wiki_migration_layout_invalid');
  for (let i = 0; i < sources.length; i++) for (let j = i + 1; j < sources.length; j++) check(!inside(sources[i], sources[j]) && !inside(sources[j], sources[i]), 'wiki_migration_layout_invalid');
  createWikiStore({ globalRoot, sourceWorktree }).read(); // Existing layout boundary.
  check(!fs.existsSync(path.join(globalRoot, 'capture-locations.json')), 'wiki_migration_already_relocated');
  return { globalRoot, sourceWorktree, destinationAgentDir, captureRoots: captureRoots.sort() };
}
function names(dir, pattern) {
  plainPath(dir);
  let entries; try { entries = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  check(entries.every(n => pattern.test(n)), 'wiki_migration_source_busy_or_invalid'); return entries.sort();
}
function envelope(file, max = 16 * 1024 * 1024) {
  try {
    plainPath(file); const stat = fs.lstatSync(file); check(stat.isFile() && stat.size <= max);
    const e = JSON.parse(fs.readFileSync(file, 'utf8')); check(e.schemaVersion === 1 && e.record && e.checksum === hashJson(e.record)); return e.record;
  } catch { throw fail('wiki_migration_record_invalid'); }
}
function prepareMigration(input) {
  const config = configuration(input);
  for (const root of [config.globalRoot, ...config.captureRoots]) {
    for (const project of names(path.join(root, 'projects'), /^[A-Za-z0-9_-]{1,128}$/)) {
      check(!fs.readdirSync(path.join(root, 'projects', project)).some(n => n === '.writer-lock' || n === '.writer-recovery'), 'wiki_migration_source_busy_or_invalid');
    }
  }
  const state = createWikiStore(config).read(); check(state.revision > 0, 'wiki_migration_empty');
  const files = new Map(), requests = [], roots = new Map(config.captureRoots.map(sourceRoot => [sourceRoot, { sourceRoot, directory: sha(sourceRoot) }]));
  const counts = Object.fromEntries(['cases', 'versions', 'candidates', 'experiences', 'baselines', 'comparisonReviews', 'replayCases', 'replayVersions'].map(k => [k, (state[k] || []).length]));
  Object.assign(counts, { snapshots: 0, comparisons: 0, executions: 0, batchExecutions: 0, sealedCases: 0, blobs: 0 });
  function add(source, relative, expectedHash) {
    plainPath(source); const stat = fs.lstatSync(source); check(stat.isFile());
    const digest = hashFile(source); if (expectedHash) check(digest === expectedHash, 'wiki_migration_blob_invalid');
    const old = files.get(relative); check(!old || old.sha256 === digest && old.bytes === stat.size);
    files.set(relative, { source, relative, sha256: digest, bytes: stat.size });
  }
  const snapshots = names(path.join(config.globalRoot, 'snapshots'), /^\d{12}\.json$/);
  for (const n of snapshots) {
    const file = path.join(config.globalRoot, 'snapshots', n), record = envelope(file, 8 * 1024 * 1024);
    check(record.scope === 'global' && record.revision === Number(n.slice(0, 12)) && Array.isArray(record.cases) && Array.isArray(record.versions));
    requests.push(...(record.replayCases || []).map(r => ({ request: r.request, checkpointHash: r.checkpointHash })), ...(record.replayVersions || []).map(r => ({ request: r.request, checkpointHash: r.checkpointHash })));
    add(file, 'badcase-global/snapshots/' + n); counts.snapshots++;
  }
  for (const [dir, pattern, count] of [
    ['comparisons', /^[a-f0-9]{64}\.json$/, 'comparisons'],
    ['executions', /^execution-[a-f0-9-]{36}\.json$/, 'executions'],
    ['batch-executions', /^batch-execution-[a-f0-9-]{36}\.json$/, 'batchExecutions'],
  ]) for (const n of names(path.join(config.globalRoot, dir), pattern)) {
    const file = path.join(config.globalRoot, dir, n), record = envelope(file, dir === 'comparisons' ? 512 * 1024 : 64 * 1024);
    check(record.status !== 'running', 'wiki_migration_source_busy_or_invalid');
    if (dir === 'comparisons') { const { id, createdAt, ...payload } = record; check(id === 'comparison-' + n.slice(0, -5) && hashJson(payload) === n.slice(0, -5)); }
    else check(record.id + '.json' === n);
    add(file, 'badcase-global/' + dir + '/' + n); counts[count]++;
  }
  // Existing readers validate full page projections as well as byte checksums.
  require(base + 'wiki-comparison-store').createWikiComparisonStore(config).read();
  require(base + 'wiki-execution-store').createWikiExecutionStore(config).read();
  require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(config).read();
  for (const v of state.replayVersions || []) resolveSampleReplayVersion(state, v.sourceCaseId, v.id);
  // Enumerate every seal under explicitly approved roots, including marks not
  // registered as evaluation tasks and seals referenced only by old snapshots.
  for (const [root] of roots) {
    check(fs.existsSync(root), 'wiki_migration_capture_root_required');
    for (const projectId of names(path.join(root, 'projects'), /^[A-Za-z0-9_-]{1,128}$/)) {
      const project = path.join(root, 'projects', projectId);
      for (const n of names(path.join(project, 'cases'), /^[a-f0-9]{64}\.json$/)) {
        const record = envelope(path.join(project, 'cases', n), 64 * 1024);
        check(sha(record.association?.messageId || '') + '.json' === n);
        requests.push({ request: { captureRoot: root, association: record.association, flagId: record.flagId } });
      }
    }
  }
  const seals = new Set();
  for (const item of requests) {
    const request = validateSealRequest(item.request), root = path.resolve(request.captureRoot), mapping = roots.get(root);
    check(mapping, 'wiki_migration_capture_root_required');
    const { association: a, flagId } = request, sealed = readSealedCase(request); check(sealed, 'wiki_migration_seal_missing');
    const retained = createCheckpointRetentionStore({ captureStore: createCaptureStore({ captureRoot: root }) }).get({ ...Object.fromEntries(['projectId', 'checkpointId', 'conversationId', 'turnId', 'agentId'].map(k => [k, a[k]])), referenceId: sealed.referenceId });
    check(retained, 'wiki_migration_seal_missing');
    if (item.checkpointHash) check(hashJson(retained.checkpoint) === item.checkpointHash);
    const identity = JSON.stringify([root, a.projectId, flagId]); if (seals.has(identity)) continue; seals.add(identity);
    const project = path.join(root, 'projects', a.projectId), prefix = 'badcase-capture/imports/' + mapping.directory + '/projects/' + a.projectId + '/';
    const metadata = ['cases/' + sha(a.messageId) + '.json', 'retention/' + sha(sealed.referenceId) + '.json'];
    for (const n of metadata) add(path.join(project, n), prefix + n);
    const flag = 'flags/' + sha(a.messageId) + '.json';
    if (fs.existsSync(path.join(project, flag))) { envelope(path.join(project, flag), 64 * 1024); add(path.join(project, flag), prefix + flag); }
    // Retention owns the frozen manifest. A mutable live manifest may already
    // have expired; do not invent or overwrite one from the retained copy.
    const cp = 'checkpoints/' + a.checkpointId + '.json';
    if (fs.existsSync(path.join(project, cp))) add(path.join(project, cp), prefix + cp);
    for (const h of retained.blobHashes) {
      const n = 'blobs/' + h.slice(0, 2) + '/' + h;
      try { if (!files.has(prefix + n)) { add(path.join(project, n), prefix + n, h); counts.blobs++; } }
      catch { throw fail('wiki_migration_blob_invalid'); }
    }
    counts.sealedCases++;
  }
  const entries = [...files.values()].sort((a, b) => a.relative.localeCompare(b.relative));
  const locations = { kind: 'wiki-capture-locations-v1', roots: [...roots.values()] };
  const summary = { kind: 'wiki-layout-migration-v1', sourceRevision: state.revision, configHash: hashJson(config),
    sourceFingerprint: hashJson(entries), counts, files: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) };
  check(Number.isSafeInteger(summary.bytes));
  return { config, files: entries, locations, summary: { ...summary, planHash: hashJson(summary) } };
}
function writeEnvelope(file, record) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, checksum: hashJson(record), record }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function migrateWikiLayout(input, options = {}) {
  check(options.confirmed === true, 'wiki_migration_confirmation_required');
  const plan = prepareMigration(input); check(options.expectedPlanHash === plan.summary.planHash, 'wiki_migration_plan_changed');
  const target = plan.config.destinationAgentDir, receiptFile = path.join(target, 'wiki-migration.json');
  if (fs.existsSync(target)) {
    try {
      const receipt = envelope(receiptFile, 16 * 1024 * 1024);
      check(receipt.planHash === plan.summary.planHash && hashJson(receipt.files) === hashJson(plan.files.map(({ source, ...f }) => f)));
      check(hashJson(envelope(path.join(target, 'badcase-global/capture-locations.json'), 64 * 1024)) === hashJson(plan.locations));
      for (const f of receipt.files) { const file = path.join(target, f.relative); plainPath(file); check(fs.lstatSync(file).size === f.bytes && hashFile(file) === f.sha256); }
      return { ...plan.summary, migrated: false };
    } catch { throw fail('wiki_migration_destination_conflict'); }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(target + '.migration-');
  // On failure retain our staging tree for diagnosis, never delete user data.
  for (const f of plan.files) {
    const dest = path.join(staging, f.relative); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.source, dest, fs.constants.COPYFILE_EXCL); fs.chmodSync(dest, 0o600);
    check(hashFile(dest) === f.sha256 && fs.statSync(dest).size === f.bytes, 'wiki_migration_source_changed');
  }
  writeEnvelope(path.join(staging, 'badcase-global/capture-locations.json'), plan.locations);
  check(prepareMigration(input).summary.planHash === plan.summary.planHash, 'wiki_migration_source_changed');
  writeEnvelope(path.join(staging, 'wiki-migration.json'), { ...plan.summary, files: plan.files.map(({ source, ...f }) => f) });
  // Destination is offline, same-user trusted; no concurrent destination writer
  // is supported. Never replace an existing directory, even an empty one.
  check(!fs.existsSync(target), 'wiki_migration_destination_conflict'); fs.renameSync(staging, target);
  return { ...plan.summary, migrated: true };
}
function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; check(['--config', '--plan', '--run', '--confirmed', '--expected-plan'].includes(flag) && !Object.hasOwn(args, flag), 'wiki_migration_usage');
    args[flag] = ['--config', '--expected-plan'].includes(flag) ? argv[++i] : true;
  }
  check(path.isAbsolute(args['--config'] || '') && !!args['--plan'] !== !!args['--run']
    && (args['--plan'] ? !args['--confirmed'] && !args['--expected-plan'] : args['--confirmed'] && /^[a-f0-9]{64}$/.test(args['--expected-plan'] || '')), 'wiki_migration_usage');
  const stat = fs.lstatSync(args['--config']); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024, 'wiki_migration_config_invalid');
  const config = JSON.parse(fs.readFileSync(args['--config'], 'utf8'));
  const result = args['--plan'] ? { ...prepareMigration(config).summary, preparedOnly: true } : migrateWikiLayout(config, { confirmed: true, expectedPlanHash: args['--expected-plan'] });
  process.stdout.write(JSON.stringify(result) + '\n'); return result;
}
if (require.main === module) { try { main(); } catch (e) { process.stderr.write(JSON.stringify({ error: /^wiki_migration_[a-z_]+$/.test(e.code || '') ? e.code : 'wiki_migration_failed' }) + '\n'); process.exitCode = 1; } }
module.exports = { prepareMigration, migrateWikiLayout, main };
