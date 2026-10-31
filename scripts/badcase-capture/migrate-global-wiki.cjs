#!/usr/bin/env node
// Explicit local migration; never reads production APIs or calls a model.
// The legacy collection remains untouched. One source into a fresh global store
// is supported; automatic merging of unrelated histories is not.
const fs = require('node:fs'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const fail = code => Object.assign(Error(code), { code });
function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed') throw fail('wiki_migration_usage');
  let config;
  try {
    if (!fs.lstatSync(args[1]).isFile() || fs.statSync(args[1]).size > 65536) throw Error();
    config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (!config || Object.keys(config).sort().join(',') !== 'globalRoot,legacy,sourceWorktree'
      || !config.legacy || Object.keys(config.legacy).sort().join(',') !== 'captureRoot,projectId,sourceWorktree') throw Error();
  } catch { throw fail('wiki_config_invalid'); }
  const store = createWikiStore({ globalRoot: config.globalRoot, sourceWorktree: config.sourceWorktree,
    sourceWorktrees: [config.legacy.sourceWorktree] });
  const result = store.migrateProjectCollection(config.legacy), state = store.read();
  process.stdout.write(JSON.stringify({ ...result.value, revision: result.revision, scope: state.scope,
    cases: state.cases.length, versions: state.versions.length, entries: state.versions.flatMap(v => v.entries).length }) + '\n');
}
if (require.main === module) {
  try { main(); } catch (e) {
    process.stderr.write(JSON.stringify({ error: /^wiki_[a-z_]+$/.test(e.code || '') || e.code === 'capture_writer_busy' ? e.code : 'wiki_migration_failed' }) + '\n'); process.exitCode = 1;
  }
}
module.exports = { main };
