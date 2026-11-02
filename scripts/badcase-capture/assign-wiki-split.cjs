#!/usr/bin/env node
// Operator freezes the confirmed replay-task source list BEFORE wiki generation.
// This does not create a checkpoint or claim a text-only case can be replayed.
const fs = require('node:fs'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const fail = code => Object.assign(Error(code), { code });
function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed') throw fail('wiki_split_usage');
  let config;
  try {
    if (!fs.lstatSync(args[1]).isFile() || fs.statSync(args[1]).size > 1024 * 1024) throw Error();
    config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (!config || Object.keys(config).some(k => !['globalRoot', 'captureRoot', 'sourceWorktree', 'projectId', 'caseIds'].includes(k))) throw Error();
  } catch { throw fail('wiki_config_invalid'); }
  const plan = createWikiStore(config).setReplaySplit({ caseIds: config.caseIds });
  process.stdout.write(JSON.stringify(plan) + '\n');
}
if (require.main === module) {
  try { main(); } catch (e) { process.stderr.write(JSON.stringify({ error: /^wiki_[a-z_]+$/.test(e.code || '') ? e.code : 'wiki_split_failed' }) + '\n'); process.exitCode = 1; }
}
module.exports = { main };
