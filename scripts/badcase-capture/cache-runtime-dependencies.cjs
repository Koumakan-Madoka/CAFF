#!/usr/bin/env node
// Trusted fixed-distribution preparation. No case selection, account access,
// model request, host npm execution or service/data operation.
const fs = require('node:fs'), path = require('node:path');
const { cacheRuntimeDependencies } = require('./runtime-dependencies.cjs');
async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args.some(p => !path.isAbsolute(p))) throw Error('evaluation_runtime_cli_invalid');
  const st = fs.lstatSync(args[0]);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw Error('evaluation_runtime_config_invalid');
  return cacheRuntimeDependencies(JSON.parse(fs.readFileSync(args[0])), args[1]);
}
if (require.main === module) main().then(r => console.log(JSON.stringify(r))).catch(e => {
  const code = e?.code || e?.message;
  console.error(/^evaluation_[a-z_]+$/.test(code || '') ? code : 'evaluation_runtime_preparation_failed'); process.exitCode = 1;
});
module.exports = { main };
