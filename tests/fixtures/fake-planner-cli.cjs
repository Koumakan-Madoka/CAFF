// Synthetic CLI only: no Claude, providers, credentials or external effects.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  fs.writeFileSync(path.join(__dirname, 'fake-probe.json'), JSON.stringify({
    noFlicker: process.env.CLAUDE_CODE_NO_FLICKER ?? null,
    disableAlternateScreen: process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN ?? null,
  }));
  console.log('2.1.310 (Claude Code)'); process.exit(0);
}
fs.writeFileSync(path.join(process.cwd(), 'fake-launch.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, pid: process.pid }));
if (process.argv.includes('-p')) {
  process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', result: 'synthetic' })));
} else {
  process.stdout.write('FAKE_READY 中文 😀\r\n');
  let pending = '';
  process.stdin.on('data', chunk => {
    pending += chunk.toString();
    if (/[\r\n]/.test(pending)) { process.stdout.write('ECHO:' + pending.trim() + '\r\n'); pending = ''; }
  });
  process.stdin.resume();
}
