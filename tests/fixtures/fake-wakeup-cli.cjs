// Synthetic Claude substitute. All state is under the test's temporary cwd.
const fs = require('node:fs'), path = require('node:path'), { execFile } = require('node:child_process');
if (process.argv.includes('--version')) {
  const f = path.join(__dirname, 'fake-version');
  console.log(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '2.1.310');
  process.exit(0);
}
if (!process.argv.includes('-p')) {
  console.log('FAKE_READY');
  process.stdin.on('data', d => process.stdout.write('ECHO:' + d));
  process.stdin.resume();
}
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => input += d);
  process.stdin.on('end', async () => {
    const args = process.argv.slice(2), modeFile = path.join(process.cwd(), 'fake-mode'), mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8') : 'normal';
    fs.appendFileSync(path.join(process.cwd(), 'fake-wakeups.jsonl'), JSON.stringify({ args, env: process.env, prompt: input }) + '\n');
    if (mode === 'missing') {
      console.error('No conversation found with session ID: ' + args[args.indexOf('--resume') + 1]);
      process.exit(1);
    }
    if (mode === 'hang') {
      setInterval(() => { }, 1000);
      return;
    }
    if (mode === 'bad-json') {
      console.log('{invalid');
      process.exit(1);
    }
    if (mode === 'oversize') {
      console.log('x'.repeat(65537));
      setInterval(() => { }, 1000);
      return;
    }
    const emit = value => console.log(JSON.stringify(value));
    emit({ type: 'system', subtype: 'init', tools: mode === 'bad-init' ? ['Bash', 'Write'] : ['Bash', 'Glob', 'Grep', 'Read'], permissionMode: args[args.indexOf('--permission-mode') + 1] });
    if (mode === 'bad-init') {
      setInterval(() => { }, 1000);
      return;
    }
    const syntheticToken = JSON.parse(fs.readFileSync(process.env.CAFF_PLANNER_CREDENTIAL_FILE, 'utf8')).token;
    emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'THINKING_MUST_NOT_BE_STORED' }, { type: 'text', text: 'Synthetic wake-up output provider-sentinel http://proxy-user:proxy-pass@invalid ' + syntheticToken + ' <img src="https://sentinel.invalid">' }] } });
    if (mode === 'long')
      for (let i = 0; i < 65; i++)
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic page ' + i + ' ' + 'x'.repeat(5000) }] } });
    try {
      const envelope = JSON.parse(input.slice(input.lastIndexOf('\n') + 1));
      const prefix = /Bash\('([^']+)' '([^']+)' state\)/.exec(args[args.indexOf('--allowedTools') + 1]);
      const adapter = prefix[2], { encodePlannerJson } = require(path.join(path.dirname(adapter), 'planner-cli'));
      const call = argv => new Promise((resolve, reject) => execFile(process.execPath, [adapter, ...argv], { env: process.env, timeout: 10000 }, (e, stdout) => e ? reject(e) : resolve(JSON.parse(stdout))));
      if (mode !== 'no-finish') {
        const view = await call(['goal', 'read']);
        if (view.goal?.owner?.agentId)
          await call(['owner', 'message', '--json', encodePlannerJson({ goalId: view.goal.goalId, goalRevision: view.goal.revision, ownerAgentId: view.goal.owner.agentId, content: 'Synthetic wake-up instruction', clientRequestId: 'wake-' + envelope.attemptId })]);
        await call(['wakeup', 'finish', '--attempt', envelope.attemptId, '--json', encodePlannerJson(envelope.items.map(i => ({ sequence: i.sequence, disposition: 'needs_user', reason: "User's decision; no $(shell) 中文 🙂" })))]);
      }
      emit({ type: 'result', subtype: 'success', is_error: false });
    }
    catch {
      emit({ type: 'result', subtype: 'error', is_error: true });
      process.exitCode = 1;
    }
  });
  process.stdin.resume();
}
