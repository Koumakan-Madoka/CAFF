// Trusted replay packaging ONLY. Not a production CLI flag or executable entry.
// Materialize the pre-goal_action suggest-goal behavior at the historical path
// inside a disposable replay distribution. All other commands use the current CLI.
const cliPath = 'build/lib/agent-chat-tools.js';
const currentPath = 'build/lib/agent-chat-tools-current.js';
const entry = String.raw`#!/usr/bin/env node
const cli = require('./agent-chat-tools-current.js');
async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const baseMessage = data && data.error ? data.error : 'Request failed with status ' + response.status;
    const issueMessages = Array.isArray(data && data.issues)
      ? data.issues.map(issue => String((issue && issue.message) || issue || '').trim()).filter(Boolean) : [];
    const missingIssueMessages = issueMessages.filter(message => !baseMessage.includes(message));
    const error = new Error(missingIssueMessages.length > 0 ? baseMessage + ': ' + missingIssueMessages.join('; ') : baseMessage);
    error.statusCode = response.status;
    if (Array.isArray(data && data.issues)) error.issues = data.issues;
    throw error;
  }
  return data;
}
async function main() {
  const { command, flags } = cli.parseArgs(process.argv.slice(2));
  if (command !== 'suggest-goal') return cli.main();
  const config = cli.getConfig();
  const action = String(flags.action || flags.status || '').trim().toLowerCase();
  const objective = String(flags.objective || flags.goal || '').trim();
  const reason = String(flags.reason || '').trim();
  let goal = null;
  if (flags['goal-stdin'] === true || flags['content-stdin'] === true || flags.stdin === true || flags.file) {
    const goalText = String(await cli.resolveFileContent(flags) || '').trim();
    if (goalText) {
      try { goal = JSON.parse(goalText); }
      catch { throw new Error('suggest-goal input must be a valid Goal JSON object.'); }
      if (!goal || typeof goal !== 'object' || Array.isArray(goal)) throw new Error('suggest-goal input must be a Goal JSON object.');
    }
  }
  if (!action) throw new Error('suggest-goal requires --action set|revise|pause|resume|complete|clear|accept|reject.');
  const result = await requestJson(config.apiUrl + '/api/agent-tools/goal/suggest', {
    method: 'POST', body: { invocationId: config.invocationId, callbackToken: config.callbackToken,
      action, ...(objective ? { objective } : {}), ...(reason ? { reason } : {}), ...(goal ? { goal } : {}) },
  });
  process.stdout.write(JSON.stringify(cli.formatCommandResult(command, result, flags), null, 2) + '\n');
}
main().catch(error => {
  process.stderr.write((error && error.message ? error.message : String(error || 'Unknown error')) + '\n');
  process.exitCode = 1;
});
`;
function stageReplayGoalCli(files) {
  const current = files.find(file => file.path === cliPath);
  if (!current || files.some(file => file.path === currentPath)) throw new Error('evaluation_replay_cli_stage_failed');
  return files.map(file => file === current ? { path: currentPath, bytes: file.bytes } : file)
    .concat({ path: cliPath, bytes: Buffer.from(entry) });
}
module.exports = { stageReplayGoalCli };
