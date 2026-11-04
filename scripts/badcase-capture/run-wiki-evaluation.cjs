#!/usr/bin/env node
// Trusted command only. The page has read access to a safe progress projection;
// full evidence remains in this exclusive-create operator JSONL.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { prepareComparison, runComparison, formatComparison } = require('./direct-comparison.cjs');
const { createWikiExecutionStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-execution-store');
const fail = code => Object.assign(Error(code), { code });
function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--config', '--output', '--expected-plan', '--plan', '--run', '--confirmed', '--json'].includes(flag) || Object.hasOwn(args, flag)) throw fail('evaluation_page_cli_invalid');
    if (['--config', '--output', '--expected-plan'].includes(flag)) {
      const value = argv[++i];
      if (flag === '--expected-plan' ? !/^[a-f0-9]{64}$/.test(value || '') : !path.isAbsolute(value || '')) throw fail('evaluation_page_cli_invalid');
      args[flag] = value;
    } else args[flag] = true;
  }
  if (!args['--config'] || !!args['--plan'] === !!args['--run']
    || args['--run'] && (!args['--confirmed'] || !args['--expected-plan'] || !args['--output'])
    || args['--plan'] && (args['--confirmed'] || args['--expected-plan'] || args['--output'])) throw fail('evaluation_page_cli_invalid');
  return args;
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = argumentsFor(argv), file = args['--config']; let config;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error();
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || Object.keys(config).sort().join(',') !== 'comparison,globalRoot,sourceWorktree'
      || !path.isAbsolute(config.globalRoot || '') || !path.isAbsolute(config.sourceWorktree || '') || !config.comparison
      || typeof config.comparison !== 'object' || Array.isArray(config.comparison)) throw Error();
  } catch { throw fail('evaluation_page_config_invalid'); }
  config = require('../../build/server/domain/runtime/badcase-capture/wiki-data-directory').resolveWikiStorageOptions(config);
  // The outer wiki context also applies to original-only runs (which have no
  // globalWikiCandidate to trigger the comparison core's location mapping).
  if (config.comparison.request) config = { ...config, comparison: { ...config.comparison,
    request: require('../../build/server/domain/runtime/badcase-capture/wiki-replay-location').resolveWikiReplayRequest(config, config.comparison.request) } };
  // Formal staged/batched publication is a separate milestone. Do not let its
  // replacement attempts silently enter this single-case progress schema.
  if (config.comparison.executionPolicy !== undefined) throw fail('evaluation_page_execution_policy_unsupported');
  const prepared = (dependencies.prepare || prepareComparison)(config.comparison);
  const print = dependencies.print || (text => process.stdout.write(text));
  if (!prepared.supported) { print(JSON.stringify(prepared) + '\n'); return prepared; }
  const planHash = crypto.createHash('sha256').update(JSON.stringify(prepared.summary)).digest('hex');
  if (args['--plan']) { const result = { supported: true, preparedOnly: true, dockerVerified: false, ...prepared.summary, planHash }; print(JSON.stringify(result, null, 2) + '\n'); return result; }
  if (args['--expected-plan'] !== planHash) throw fail('evaluation_page_confirmation_required');
  // Existence/permissions are resolved before a record or paid request starts.
  const store = createWikiExecutionStore(config), fd = fs.openSync(args['--output'], 'wx', 0o600);
  let record, timer, publicationFailed = false;
  const append = event => { fs.writeSync(fd, JSON.stringify(event) + '\n'); fs.fsyncSync(fd); };
  try {
    record = store.start(prepared.summary);
    append({ event: 'page_execution', executionId: record.id, planHash });
    timer = setInterval(() => { try { store.heartbeat(record.id); } catch { publicationFailed = true; } }, 5000); timer.unref?.();
    const result = await (dependencies.run || runComparison)(config.comparison, { confirmed: true, onEvent: event => {
      if (publicationFailed) throw fail('evaluation_progress_write_failed');
      append(event); store.event(record.id, event);
    } });
    if (publicationFailed) throw fail('evaluation_progress_write_failed');
    if (!result.supported) {
      const reason = /^replay_[a-z_]+$/.test(result.reason || '') ? result.reason : 'replay_materials_invalid';
      const unsupported = { supported: false, reason, executionId: record.id };
      append({ event: 'unsupported', ...unsupported }); store.fail(record.id, 'evaluation_' + reason);
      print(args['--json'] ? JSON.stringify(unsupported) + '\n' : formatComparison(unsupported));
      return unsupported;
    }
    const saved = store.finish(record.id, result);
    append({ event: 'page_execution_finished', executionId: record.id, status: saved.status });
    print(args['--json'] ? JSON.stringify({ ...result, executionId: record.id }, null, 2) + '\n' : formatComparison(result) + '页面执行记录：' + record.id + '\n');
    return { ...result, executionId: record.id };
  } catch (e) {
    const code = /^(evaluation|wiki)_[a-z_]+$/.test(e?.code || '') ? e.code : 'evaluation_failed';
    if (record) { try { store.fail(record.id, code); } catch {} }
    // A publication failure stops the sequence. Never restart a model to repair
    // a page record; fsynced evidence remains available to the operator.
    append({ event: 'page_execution_failed', executionId: record?.id || null, reason: code });
    throw fail(code);
  } finally { clearInterval(timer); fs.closeSync(fd); }
}
if (require.main === module) main().then(result => { if (!result.supported || !result.preparedOnly && !result.completed) process.exitCode = 1; }).catch(e => {
  const code = /^(evaluation|wiki)_[a-z_]+$/.test(e?.code || '') ? e.code : 'evaluation_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { main, argumentsFor };
