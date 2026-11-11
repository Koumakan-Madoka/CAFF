#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const { prepareBatch, runBatch, formatBatch } = require('./batch-comparison.cjs');
const { createWikiComparisonStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-comparison-store');
const { createWikiBatchExecutionStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-batch-execution-store');
const fail = code => Object.assign(Error(code), { code });
const { jsonChunks } = require('./replay-streams.cjs');
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
  const config = JSON.parse(fs.readFileSync(file, 'utf8')), plan = prepareBatch(config, { ...runtimeOptions, allowDraftCandidate: args['--plan'] === true });
  if (args['--plan']) { process.stdout.write(JSON.stringify({ preparedOnly: true, dockerVerified: false, ...plan.summary }, null, 2) + '\n'); return; }
  if (plan.summary.planHash !== args['--expected-plan']) throw fail('evaluation_batch_confirmation_required');
  // Keep CLI/model operation closed until v4's immutable result and progress
  // validators are in place; never spend a batch then fail its publication.
  if (plan.summary.kind === 'wiki-mode-holdout-comparison-v1') throw fail('wiki_holdout_publication_not_ready');
  const progress = plan.summary.evaluation?.splitPolicy === 'd15-frozen-v1' ? createWikiBatchExecutionStore(config) : null;
  const fd = fs.openSync(args['--output'], 'wx', 0o600);
  let record, timer, publicationFailed = false;
  const append = event => { for (const chunk of jsonChunks(event)) fs.writeSync(fd, chunk); fs.writeSync(fd, '\n'); fs.fsyncSync(fd); };
  try {
    if (progress) {
      record = progress.start(plan.summary);
      append({ event: 'page_execution', executionId: record.id, planHash: plan.summary.planHash });
      timer = setInterval(() => { try { progress.heartbeat(record.id); } catch { publicationFailed = true; } }, 5000); timer.unref?.();
    }
    const result = await runBatch(config, { ...runtimeOptions, confirmed: true, expectedPlanHash: args['--expected-plan'],
      onEvent: event => {
        if (publicationFailed) throw fail('evaluation_progress_write_failed');
        try { append(event); if (record) progress.event(record.id, event); }
        catch (e) { publicationFailed = true; throw e; }
      } });
    if (publicationFailed) throw fail('evaluation_progress_write_failed');
    if (result.scope === 'global') {
      // Save incomplete batches too; never lose error/not-run denominators. A
      // failed save leaves the fsynced JSONL intact and must not rerun models.
      const saved = createWikiComparisonStore(config).save(result);
      result.comparisonId = saved.id;
      if (record) {
        const finished = progress.finish(record.id, saved);
        append({ event: 'page_execution_finished', executionId: record.id, comparisonId: saved.id, status: finished.status });
      }
    }
    if (args['--json']) { for (const chunk of jsonChunks(result)) process.stdout.write(chunk); process.stdout.write('\n'); }
    else process.stdout.write(formatBatch(result) + (result.comparisonId ? '已保存全局结果：' + result.comparisonId + '\n' : ''));
    if (!result.completed) process.exitCode = 1;
  } catch (e) {
    const code = /^(evaluation|wiki)_[a-z_]+$/.test(e?.code || '') ? e.code : 'evaluation_batch_failed';
    if (record) {
      try { progress.fail(record.id, code); } catch {}
      append({ event: 'page_execution_failed', executionId: record.id, reason: code });
    }
    throw e;
  } finally { clearInterval(timer); fs.closeSync(fd); }
}
if (require.main === module) main().catch(e => {
  const code = /^(evaluation|wiki)_[a-z_]+$/.test(e?.code || '') ? e.code : 'evaluation_batch_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { argumentsFor, main };
