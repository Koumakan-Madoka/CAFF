const assert = require('node:assert/strict'), test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { once } = require('node:events'), { fork } = require('node:child_process');
const { launchPlannerPrint } = require('../../build/server/domain/runtime/embedded-planner-print');
const { buildPlannerEnvironment } = require('../../build/server/domain/runtime/embedded-planner-env');
function alive(pid) { try {
  process.kill(pid, 0);
  return true;
}
catch {
  return false;
} }
async function wait(check) { const start = Date.now(); while (!check()) {
  if (Date.now() - start > 12000)
    throw new Error('Synthetic print cleanup timeout');
  await new Promise(r => setTimeout(r, 25));
} }
function fixture(t, natural = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-print-tree-')), script = path.join(root, 'fake.cjs');
  fs.writeFileSync(script, `const fs=require('node:fs'),{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${natural === 'inherit' ? "['ignore','inherit','inherit']" : "'ignore'"}});fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));process.stdin.resume();${natural ? 'setTimeout(()=>process.exit(0),300)' : 'setInterval(()=>{},1000)'};`);
  const config = { cli: { file: process.execPath, prefix: [script] }, args: [], cwd: root, cols: 120, rows: 30, prompt: 'Synthetic EOF', env: buildPlannerEnvironment({ source: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, SystemRoot: process.env.SystemRoot }, baseUrl: 'http://127.0.0.1:45678' }) };
  t.after(async () => { const file = path.join(root, 'pids.json'); if (fs.existsSync(file)) {
    const pids = JSON.parse(fs.readFileSync(file));
    for (const pid of pids)
      if (alive(pid))
        try {
          process.kill(pid, 'SIGKILL');
        }
        catch { }
    await wait(() => pids.every(pid => !alive(pid)));
  } fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config };
}
for (const natural of [false, true, 'inherit'])
  test(`pipe guardian cleans descendants on ${natural === 'inherit' ? 'natural CLI exit with an inherited pipe' : natural ? 'natural CLI exit' : 'explicit stop'}`, { timeout: 30000 }, async (t) => {
    const f = fixture(t, natural), child = await launchPlannerPrint(f.config);
    t.after(() => child.stop());
    const done = once(child, 'exit');
    await wait(() => fs.existsSync(path.join(f.root, 'pids.json')));
    const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json')));
    if (!natural)
      child.stop();
    await done;
    await wait(() => pids.every(pid => !alive(pid)));
    assert.ok(pids.every(pid => !alive(pid)));
  });
test('pipe guardian parent death cleans the full owned tree', { timeout: 30000 }, async (t) => {
  const f = fixture(t), parentFile = path.join(f.root, 'parent.cjs'), adapter = path.resolve(__dirname, '../../build/server/domain/runtime/embedded-planner-print');
  fs.writeFileSync(parentFile, `require(${JSON.stringify(adapter)}).launchPlannerPrint(${JSON.stringify(f.config)}).then(c=>process.send({pid:c.guardianPid}));`);
  const parent = fork(parentFile, [], { env: f.config.env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => parent.kill());
  const [{ pid }] = await once(parent, 'message');
  await wait(() => fs.existsSync(path.join(f.root, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(f.root, 'pids.json')));
  const end = once(parent, 'exit');
  parent.kill();
  await end;
  await wait(() => [pid, ...pids].every(p => !alive(p)));
  assert.ok(!alive(pid));
});
