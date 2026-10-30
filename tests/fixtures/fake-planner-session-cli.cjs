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
// Raw input preserves the bracketed-paste delimiters sent by real xterm.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1004hFAKE_SESSION_READY\r\n');
// Model the CLI's asynchronous console-size sampling. A back-to-back nudge is
// invisible; repaint does NOT re-emit startup modes or retain screen contents.
let size = `${process.stdout.columns}x${process.stdout.rows}`, repaint = 0;
setInterval(() => {
  const next = `${process.stdout.columns}x${process.stdout.rows}`;
  if (next === size) return;
  size = next;
  // Repaint a separate status row while preserving the input cursor. Otherwise
  // a second resize repaint could erase an ECHO before the browser asserts it.
  process.stdout.write('\x1b7\x1b[' + process.stdout.rows + ';1H\x1b[2KFAKE_REPAINT_' + (++repaint) + '\x1b8');
}, 20);
let pending = '';
process.stdin.on('data', chunk => {
  fs.appendFileSync('fake-input.txt', chunk);
  pending += chunk.toString();
  pending = pending.replace(/\x1b\[[IO]/g, ''); // focus reports are not commands
  if (!/[\r\n]/.test(pending)) return;
  const input = pending.trim(); pending = '';
  if (input === '/exit') process.exit(0); // Deliberately does NOT create a record.
  if (input === 'save') {
    fs.writeFileSync(record, JSON.stringify({ sessionId }));
    process.stdout.write('FAKE_SESSION_SAVED\r\n');
  } else if (input === 'palette') {
    // Representative dark-oriented CLI ANSI output, not a real trust dialog.
    process.stdout.write('Accessing workspace (synthetic):\r\n\x1b[90m/synthetic/worktree\x1b[0m\r\n\x1b[38;2;177;156;217mYes, I trust this folder (synthetic)\x1b[0m\r\nPALETTE_DONE\r\n');
  } else if (input === 'ghost') {
    // Deterministic synthetic TUI, six *exactly* 59-cell rows. The emoji/VS16
    // prefix plus padding exposes a width disagreement without a model call.
    const lines = ['✅', '⚠️', '❌', '🙂', '📌', '🚀'].map((emoji, i) => `${emoji} 行${i + 1} ` + '中文重绘'.repeat(6) + ' OK!');
    fs.writeFileSync('fake-ghost-lines.json', JSON.stringify(lines));
    process.stdout.write('\x1b[?1049h');
    let round = 0;
    const render = () => {
      process.stdout.write('\x1b[H' + lines.map(line => '\x1b[2K' + line).join('\r\n') + '\r\n\x1b[2K' + (round < 8 ? '输入🙂 待删除中文' : 'GHOST_DONE'));
      if (++round <= 8) setTimeout(render, 30);
    };
    render();
  } else if (input === 'safety') {
    process.stdout.write('\x1b]52;c;U1lOVEhFVElDX09OTFk=\x07\x1b]8;;https://terminal-sentinel.invalid\x07link\x1b]8;;\x07 <img src="https://terminal-sentinel.invalid/image"> SAFETY_DONE\r\n');
  } else process.stdout.write('ECHO:' + input + '\r\n');
});
process.stdin.resume();
