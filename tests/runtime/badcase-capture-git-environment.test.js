// Synthetic repositories/helper processes only. No live instance or model calls.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { execFileSync } = require('node:child_process'), { EventEmitter } = require('node:events');
const base = '../../build/server/domain/runtime/badcase-capture/';
const parentEnv = () => ({ PATH: 'unchanged-path', HOME: 'C:/fixture-home', OTHER: 'unchanged', GIT_CONFIG_GLOBAL: 'C:/fixture-global',
  GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: 'C:/outside',
  GIT_DIR: 'C:/other-repo', GIT_INDEX_FILE: 'C:/other-index', git_config_parameters: 'injected', GIT_BASH_PATH: 'C:/Git/bash.exe' });
test('capture child environment strips Git injection and disables only its own config layers, never mutating the parent', () => {
  const { createWindowsCaptureEnvironment } = require(base + 'windows-git-environment');
  assert.equal(typeof createWindowsCaptureEnvironment, 'function');
  for (const env of [{}, parentEnv()]) {
    const before = JSON.stringify(env), child = createWindowsCaptureEnvironment(env);
    assert.notEqual(child, env); assert.equal(JSON.stringify(env), before);
    assert.equal(child.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(child.GIT_CONFIG_GLOBAL, 'NUL');
    assert.equal(child.GIT_TERMINAL_PROMPT, '0');
    assert.deepEqual(Object.keys(child).filter(k => k.toUpperCase().startsWith('GIT_')).sort(), ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']);
    for (const [k, v] of Object.entries(env)) if (!k.toUpperCase().startsWith('GIT_')) assert.equal(child[k], v);
    child.OTHER = 'child-only'; assert.notEqual(child.OTHER, env.OTHER);
  }
});
test('every native capture helper launch receives its private Git environment even when ambient config drifts', async () => {
  const filename = require.resolve(base + 'windows-helper'), local = require('node:module').createRequire(filename), exports = {};
  const source = require(base + 'windows-helper-source').WINDOWS_HELPER_SOURCE;
  const env = parentEnv(), before = JSON.stringify(env), launches = [];
  const child = { spawnSync(_python, _args, options) { launches.push(options); return { status: 1, stderr: Buffer.alloc(0) }; },
    spawn(_python, _args, options) { launches.push(options); const c = new EventEmitter();
      for (const name of ['stdin', 'stdout', 'stderr']) c[name] = new EventEmitter(); c.kill = () => true;
      c.stdin.end = () => c.emit('close', 1); return c; } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, Buffer, process: { platform: 'win32', env }, setTimeout, clearTimeout,
    require: name => name === 'node:child_process' ? child : name === 'node:fs' ? { statSync: () => ({ size: Buffer.byteLength(source) }), readFileSync: () => Buffer.from(source) } : local(name) }, { filename });
  const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
  exports.invokeWindowsHelper('python', 'trusted.py', { version: 1, op: 'identity', root: 'C:/repo' });
  const request = { version: 1, root: 'C:/repo', expected: identity, excluded: [] };
  await exports.invokeWindowsEstimateHelper('python', 'trusted.py', { ...request, op: 'estimate' });
  for (const [method, op, extra] of [['invokeWindowsGitHelper', 'gitMetadata', { excluded: [] }],
    ['invokeWindowsSessionHelper', 'sessionInput', { path: 'turn.jsonl' }], ['invokeWindowsGitInputHelper', 'gitInput', { path: 'index' }]]) {
    env.GIT_CONFIG_GLOBAL = 'C:/changed-after-first-launch';
    await exports[method]('python', 'trusted.py', { version: 1, root: 'C:/repo', expected: identity, op, ...extra }, performance.now() + 1000);
  }
  assert.equal(launches.length, 5);
  for (const options of launches) { assert.notEqual(options.env, env); assert.equal(options.env?.GIT_CONFIG_GLOBAL, 'NUL');
    assert.equal(options.env?.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(options.env?.GIT_DIR, undefined); assert.equal(options.env?.git_config_parameters, undefined); }
  assert.equal(JSON.stringify({ ...env, GIT_CONFIG_GLOBAL: 'C:/fixture-global' }), before);
});
test('service uses classification without host Git prerequisites; unsupported capacity cannot grant capture', async t => {
  const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-env-vm-')); t.after(() => fs.rmSync(captureRoot, { recursive: true, force: true }));
  const filename = require.resolve(base + 'index'), local = require('node:module').createRequire(filename), exports = {}, env = parentEnv(), before = JSON.stringify(env);
  const seen = []; let collectorOptions, classifiedOk = true, now = 0;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, structuredClone, process: { platform: 'win32', env }, require: name =>
    name === 'node:perf_hooks' ? { performance: { now: () => now } } : name === './windows-turn-collector' ? { createWindowsTurnCollector: options => { collectorOptions = options; return {}; } }
      : name === './windows-git-candidate' ? { estimateWindowsGitDirectoryAsync: async options => { seen.push('classified'); assert.equal(options.deadline, 25000); if (!classifiedOk) now = 24900;
        return classifiedOk ? { ok: true, complete: true } : { ok: false, reason: 'git_metadata_unsupported' }; } }
      : name === './windows-estimate' ? { estimateWindowsDirectoryAsync: async options => { seen.push('raw'); assert.equal(options.deadline, 25000, 'fallback must not gain another 25 seconds');
        return { ok: true, complete: true, captureAvailable: true }; } } : local(name) }, { filename });
  const service = exports.createBadcaseCaptureService({ captureRoot }), result = await service.estimateDirectoryAsync('p', 'C:/repo');
  assert.equal(result.captureAvailable, true); assert.deepEqual(seen, ['classified']); assert.equal(collectorOptions.checkEnvironment, undefined);
  classifiedOk = false; const capacity = await service.estimateDirectoryAsync('p', 'C:/repo');
  assert.equal(capacity.captureAvailable, false); assert.equal(capacity.reason, 'git_metadata_unsupported');
  assert.deepEqual(seen, ['classified', 'classified', 'raw']); assert.equal(JSON.stringify(env), before);
});
test('raw capacity helper honors an earlier shared deadline rather than resetting its timeout', async () => {
  const filename = require.resolve(base + 'windows-helper'), local = require('node:module').createRequire(filename), exports = {};
  const source = require(base + 'windows-helper-source').WINDOWS_HELPER_SOURCE, waits = []; let launches = 0, now = 24900;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, Buffer, process: { platform: 'win32', env: {} },
    setTimeout: (_fn, ms) => { waits.push(ms); return 1; }, clearTimeout: () => {},
    require: name => name === 'node:perf_hooks' ? { performance: { now: () => now } }
      : name === 'node:fs' ? { statSync: () => ({ size: Buffer.byteLength(source) }), readFileSync: () => Buffer.from(source) }
      : name === 'node:child_process' ? { spawn: () => { launches++; const c = new EventEmitter();
        for (const n of ['stdin', 'stdout', 'stderr']) c[n] = new EventEmitter(); c.kill = () => true; c.stdin.end = () => c.emit('close', 1); return c; } } : local(name) }, { filename });
  const request = { version: 1, root: 'C:/repo', op: 'estimate', expected: { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' }, excluded: [] };
  await exports.invokeWindowsEstimateHelper('python', 'trusted.py', request, 25000);
  assert.equal(launches, 1); assert.deepEqual(waits, [100]);
  for (const deadline of [24900, NaN, Infinity, '25000']) assert.equal((await exports.invokeWindowsEstimateHelper('python', 'trusted.py', request, deadline)).reason, 'estimate_timeout');
  assert.equal(launches, 1);
});
test('native Windows service captures with ordinary global Git config and leaves agent Git behavior unchanged', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-env-native-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'repo'), globalFile = path.join(root, 'fixture-global'), ignore = path.join(root, 'fixture-ignore'); fs.mkdirSync(target);
  fs.writeFileSync(ignore, 'global-only.txt\n'); fs.writeFileSync(globalFile, '[user]\nname = fixture-global\n[core]\nexcludesFile = ' + ignore.replaceAll('\\', '/') + '\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  // These are private synthetic inputs for this child, NOT service-global changes.
  Object.assign(env, { GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'fixture-injected' });
  execFileSync('git', ['-C', target, 'init', '-q', '--template='], { env, stdio: 'pipe' });
  fs.writeFileSync(path.join(target, 'ordinary.txt'), 'ordinary'); fs.writeFileSync(path.join(target, 'global-only.txt'), 'capture still sees this file');
  execFileSync('git', ['-C', target, 'add', 'ordinary.txt'], { env, stdio: 'pipe' });
  const code = `const assert=require('node:assert/strict'),fs=require('node:fs'),{execFileSync}=require('node:child_process');
    const [target,captureRoot,globalFile]=process.argv.slice(1),api=require(${JSON.stringify(require.resolve(base + 'index'))});
    const git=()=>execFileSync('git',['-C',target,'config','user.name'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const before=JSON.stringify(process.env),globalBytes=fs.readFileSync(globalFile);assert.equal(git(),'fixture-injected');assert.equal(process.env.GIT_CONFIG_NOSYSTEM,undefined);
    (async()=>{const service=api.createBadcaseCaptureService({captureRoot});service.savePolicy('p',{authorizedDirs:[target],excludedPatterns:[]});
      const policy=service.authorizeProject('p'),estimate=await service.estimateDirectoryAsync('p',target);assert.equal(estimate.captureAvailable,true,JSON.stringify(estimate));
      service.store.savePolicy({...policy,status:'enabled'});const result=await service.captureTurnCheckpoint({projectId:'p',conversationId:'c',turnId:'t',agentId:'a',targetDir:target,deliveryMode:'fresh',prompt:'synthetic only'});
      assert.equal(result.captured,true,result.reason);assert.ok(result.checkpoint.files['ordinary.txt']);assert.ok(result.checkpoint.files['global-only.txt']);
      assert.equal(result.checkpoint.integrity.knownLimitations.includes('global_git_config_explicitly_disabled_in_host_runtime'),false);
      assert.ok(JSON.stringify(process.env)===before,'parent_environment_changed');assert.deepEqual(fs.readFileSync(globalFile),globalBytes);assert.equal(git(),'fixture-injected');
      console.log(JSON.stringify({captured:true,classifiedEstimate:true,parentUnchanged:true,agentGitUnchanged:true,files:Object.keys(result.checkpoint.files).sort(),realModelRequests:0}));
    })().catch(()=>{console.error('native_capture_environment_regression');process.exitCode=1});`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', code, target, path.join(root, 'capture'), globalFile], { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(result.captured, true); assert.equal(result.agentGitUnchanged, true); assert.equal(result.parentUnchanged, true);
});
