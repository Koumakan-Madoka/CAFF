#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const { prepareBatch, runBatch, formatBatch } = require('./batch-comparison.cjs');
const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
const fail = code => Object.assign(Error(code), { code });
function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--config', '--output', '--expected-plan', '--plan', '--run', '--confirmed', '--json'].includes(flag) || Object.hasOwn(args, flag)) throw fail('evaluation_batch_cli_invalid');
    if (['--config', '--output', '--expected-plan'].includes(flag)) {
      const value = argv[++i];
      if (flag === '--expected-plan' ? !/^[a-f0-9]{64}$/.test(value || '') : !path.isAbsolute(value || '')) throw fail('evaluation_batch_cli_invalid');
      args[flag] = value;
    } else args[flag] = true;
  }
  if (!args['--config'] || !!args['--plan'] === !!args['--run']
    || args['--run'] && (!args['--confirmed'] || !args['--expected-plan'] || !args['--output'])
    || args['--plan'] && (args['--confirmed'] || args['--expected-plan'] || args['--output'])) throw fail('evaluation_batch_cli_invalid');
  return args;
}
async function main(argv = process.argv.slice(2), runtimeOptions = {}) {
  const args = argumentsFor(argv), file = args['--config'];
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw fail('evaluation_batch_config_invalid');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')), plan = prepareBatch(config, runtimeOptions);
  if (args['--plan']) { process.stdout.write(JSON.stringify({ preparedOnly: true, dockerVerified: false, ...plan.summary }, null, 2) + '\n'); return; }
  if (plan.summary.planHash !== args['--expected-plan']) throw fail('evaluation_batch_confirmation_required');
  const fd = fs.openSync(args['--output'], 'wx', 0o600);
  try {
    const result = await runBatch(config, { ...runtimeOptions, confirmed: true, expectedPlanHash: args['--expected-plan'],
      onEvent: event => { fs.writeSync(fd, JSON.stringify(event) + '\n'); fs.fsyncSync(fd); } });
    if (result.scope === 'global') {
      // Save incomplete batches too; never lose error/not-run denominators. A
      // failed save leaves the fsynced JSONL intact and must not rerun models.
      const saved = createWikiComparisonStore(config).save(result);
      result.comparisonId = saved.id;
    }
    process.stdout.write(args['--json'] ? JSON.stringify(result, null, 2) + '\n' : formatBatch(result) + (result.comparisonId ? '已保存全局结果：' + result.comparisonId + '\n' : ''));
    if (!result.completed) process.exitCode = 1;
  } finally { fs.closeSync(fd); }
}
if (require.main === module) main().catch(e => {
  const code = /^(evaluation|wiki)_[a-z_]+$/.test(e?.code || '') ? e.code : 'evaluation_batch_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { argumentsFor, main };
