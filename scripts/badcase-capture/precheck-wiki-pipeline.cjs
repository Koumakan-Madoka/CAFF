#!/usr/bin/env node
// Trusted offline command; no HTTP route, models/auth/network or tool execution.
// V2 preparation may read this instance's known-value inventory for redaction.
// Run only against the explicitly authorized Wiki/archives (normally a copy).
const fs = require('node:fs'), path = require('node:path');
const fail = code => Object.assign(Error(code), { code });
function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--config', '--confirmed'].includes(flag) || Object.hasOwn(args, flag)) throw fail('wiki_pipeline_precheck_arguments_invalid');
    args[flag] = flag === '--config' ? argv[++i] : true;
  }
  if (!args['--confirmed'] || !path.isAbsolute(args['--config'] || '')) throw fail('wiki_pipeline_precheck_arguments_invalid');
  let scope;
  try {
    const stat = fs.lstatSync(args['--config']);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error();
    scope = JSON.parse(fs.readFileSync(args['--config'], 'utf8'));
    if (!scope || Object.keys(scope).sort().join('|') !== 'globalRoot|sourceWorktree'
      || !path.isAbsolute(scope.globalRoot || '') || !path.isAbsolute(scope.sourceWorktree || '')) throw Error();
  } catch { throw fail('wiki_pipeline_precheck_config_invalid'); }
  scope = require('../../build/server/domain/runtime/badcase-capture/wiki-data-directory').resolveWikiStorageOptions(scope);
  const { createWikiPipelinePrecheckStore, cacheWikiPipelineInputs } = require('../../build/server/domain/runtime/badcase-capture/wiki-pipeline-prechecks');
  const cache = createWikiPipelinePrecheckStore(scope);
  const store = (dependencies.createStore || require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore)(scope);
  const inspectReplay = dependencies.inspectReplay || require('./wiki-page-runtime.cjs').inspectPageReplay;
  const results = cacheWikiPipelineInputs(store.read(), { cache, readTrace: id => store.readCaseTrace(id), inspectReplay: replay => inspectReplay({ replay, scope }) });
  (dependencies.print || (text => process.stdout.write(text)))(JSON.stringify({ rules: require('../../build/server/domain/runtime/badcase-capture/wiki-pipeline-prechecks').WIKI_PIPELINE_PRECHECK_RULES, results }) + '\n');
  return results;
}
if (require.main === module) {
  try { main(); }
  catch (e) { process.stderr.write(JSON.stringify({ error: /^(?:wiki|capture)_[a-z_]+$/.test(e?.code || '') ? e.code : 'wiki_pipeline_precheck_failed' }) + '\n'); process.exitCode = 1; }
}
module.exports = { main };
