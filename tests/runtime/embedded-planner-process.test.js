const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { once } = require('node:events');
const { launchPlannerPty } = require('../../build/server/domain/runtime/embedded-planner-pty');
const { buildPlannerEnvironment } = require('../../build/server/domain/runtime/embedded-planner-env');
const { fork } = require('node:child_process');

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(check, deadlineMs = 10000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > deadlineMs) throw new Error('Synthetic process cleanup timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-pty-tree-'));
  const script = path.join(root, 'fake tree 中文.cjs');
  fs.writeFileSync(script, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));
console.log('FAKE_TREE_READY'); process.stdin.resume(); setInterval(()=>{},1000);`);
  const config = { cli: { file: process.execPath, prefix: [script] }, args: [], cwd: root, cols: 120, rows: 30,
    env: buildPlannerEnvironment({ source: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, baseUrl: 'http://127.0.0.1:45678', interactive: true }) };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, config };
}

test('real node-pty fake CLI cleanup covers descendants on explicit stop', async t => {
  const f = fixture(t), child = await launchPlannerPty(f.config);
  t.after(() => child.stop());
  await waitFor(() => fs.existsSync(path.join(f.root, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json')));
  const end = once(child, 'exit'); child.stop(); await end;
  await waitFor(() => pids.every(pid => !alive(pid)));
});

test('guardian IPC parent death stops the fake CLI and its descendants', async t => {
  const f = fixture(t);
  const parentScript = path.join(f.root, 'parent.cjs');
  const adapter = path.resolve(__dirname, '../../build/server/domain/runtime/embedded-planner-pty');
  fs.writeFileSync(parentScript, `require(${JSON.stringify(adapter)}).launchPlannerPty(${JSON.stringify(f.config)}).then(()=>process.send('started'));`);
  const parent = fork(parentScript, [], { env: f.config.env, execArgv: [], stdio: ['ignore','ignore','ignore','ipc'] });
  t.after(() => parent.kill());
  await once(parent, 'message'); await waitFor(() => fs.existsSync(path.join(f.root, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json')));
  const end = once(parent, 'exit'); parent.kill(); await end;
  await waitFor(() => pids.every(pid => !alive(pid)));
});
