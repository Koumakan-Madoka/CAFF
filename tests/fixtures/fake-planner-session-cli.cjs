// Synthetic session persistence, not Claude: isolated cwd contains all state.
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.310 (Claude Code)'); process.exit(0); }
const argv = process.argv.slice(2), sessionId = argv[1];
fs.writeFileSync(path.join(process.cwd(), 'fake-launch.json'), JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid }));
const record = path.join(process.cwd(), 'fake-saved-session.json');
const saved = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')).sessionId : null;
if (argv[0] === '--resume' && saved !== sessionId) {
  console.log('No conversation found with session ID: ' + sessionId); process.exit(1);
}
if (argv[0] === '--session-id' && saved === sessionId) {
  console.log('Error: Session ID ' + sessionId + ' is already in use.'); process.exit(1);
}
process.stdout.write('FAKE_SESSION_READY\r\n');
let pending = '';
process.stdin.on('data', chunk => {
  pending += chunk.toString();
  if (!/[\r\n]/.test(pending)) return;
  const input = pending.trim(); pending = '';
  if (input === '/exit') process.exit(0); // Deliberately does NOT create a record.
  if (input === 'save') {
    fs.writeFileSync(record, JSON.stringify({ sessionId }));
    process.stdout.write('FAKE_SESSION_SAVED\r\n');
  } else if (input === 'palette') {
    // Representative dark-oriented CLI ANSI output, not a real trust dialog.
    process.stdout.write('Accessing workspace (synthetic):\r\n\x1b[90m/synthetic/worktree\x1b[0m\r\n\x1b[38;2;177;156;217mYes, I trust this folder (synthetic)\x1b[0m\r\nPALETTE_DONE\r\n');
  } else if (input === 'safety') {
    process.stdout.write('\x1b]52;c;U1lOVEhFVElDX09OTFk=\x07\x1b]8;;https://terminal-sentinel.invalid\x07link\x1b]8;;\x07 <img src="https://terminal-sentinel.invalid/image"> SAFETY_DONE\r\n');
  } else process.stdout.write('ECHO:' + input + '\r\n');
});
process.stdin.resume();
