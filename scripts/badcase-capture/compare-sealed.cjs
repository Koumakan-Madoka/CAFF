#!/usr/bin/env node
// CLI only. --plan is read-only; --run requires explicit trace/rule confirmation.
const fs = require('node:fs'), path = require('node:path');
const { jsonChunks } = require('./replay-streams.cjs');
const { prepareComparison, runComparison, formatComparison } = require('./direct-comparison.cjs');
function argumentsFor(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--config', '--output', '--plan', '--run', '--confirmed', '--json'].includes(flag) || Object.hasOwn(out, flag)) throw Error('evaluation_cli_invalid');
    if (['--config', '--output'].includes(flag)) { const value = argv[++i]; if (!value || !path.isAbsolute(value)) throw Error('evaluation_cli_invalid'); out[flag] = value; }
    else out[flag] = true;
  }
  if (!out['--config'] || !!out['--plan'] === !!out['--run'] || out['--run'] && (!out['--confirmed'] || !out['--output'])
    || out['--plan'] && (out['--confirmed'] || out['--output'])) throw Error('evaluation_cli_invalid');
  return out;
}
async function main(argv = process.argv.slice(2)) {
  const args = argumentsFor(argv), file = args['--config'];
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) throw Error('evaluation_config_invalid');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args['--plan']) {
    const plan = prepareComparison(config);
    console.log(JSON.stringify(plan.supported ? { supported: true, preparedOnly: true, dockerVerified: false, ...plan.summary } : plan, null, 2));
    return;
  }
  // Never overwrite an earlier result or persist env/config/key content.
  const fd = fs.openSync(args['--output'], 'wx', 0o600);
  try {
    const result = await runComparison(config, { confirmed: true, onEvent: event => { for (const chunk of jsonChunks(event)) fs.writeSync(fd, chunk); fs.writeSync(fd, '\n'); fs.fsyncSync(fd); } });
    if (!result.supported) { fs.writeSync(fd, JSON.stringify(result) + '\n'); fs.fsyncSync(fd); }
    if (args['--json']) { for (const chunk of jsonChunks(result)) process.stdout.write(chunk); process.stdout.write('\n'); }
    else process.stdout.write(formatComparison(result));
    if (!result.supported || !result.completed) process.exitCode = 1;
  } finally { fs.closeSync(fd); }
}
if (require.main === module) main().catch(e => {
  const code = /^(evaluation|wiki_candidate)_[a-z_]+$/.test(e?.code || e?.message || '') ? e.code || e.message : 'evaluation_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { main, argumentsFor };
