#!/usr/bin/env node
import { PlannerCliError, runPlannerCli } from './planner-cli';

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runPlannerCli(argv);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const e = error instanceof PlannerCliError ? error : new PlannerCliError('caff_internal_error');
    process.stderr.write(JSON.stringify({ ok: false, code: e.code, ...(e.status ? { status: e.status } : {}), ...(e.serverCode ? { serverCode: e.serverCode } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module) void main();
