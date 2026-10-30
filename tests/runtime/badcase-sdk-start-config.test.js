// Static SDK start descriptors only. Never starts a provider, SDK or Docker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
function runtime(env = {}) {
  const filename = path.resolve(__dirname, '../../build/lib/pi-runtime.js'), exports = {};
  const local = Module.createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, module: { exports }, Buffer,
    __dirname: path.dirname(filename), process: { env, cwd: () => '/static-fixture', platform: process.platform },
    require: name => name === 'node:child_process' ? { fork: () => assert.fail('no process'), spawn: () => assert.fail('no process') } : local(name),
  }, { filename });
  return exports;
}
const plain = v => JSON.parse(JSON.stringify(v));
test('one shared resolver describes exactly the complete SDK wire config without auth, DB, images or arbitrary options', () => {
  const api = runtime({ PI_THINKING: 'high', PI_CODING_AGENT_DIR: path.resolve('agent'), PI_HEARTBEAT_INTERVAL_MS: '1234', OPENAI_API_KEY: 'never-copy' });
  assert.equal(typeof api.resolveSdkStartConfig, 'function');
  const options = { session: 'named', cwd: path.resolve('project'), extensionPaths: ['./extension.mjs', './extension.mjs'],
    additionalSkillPaths: ['./skill'], retireUserScopeSkills: true, extraEnv: { PRIVATE_VALUE: 'never-copy' }, sqlitePath: '/never-copy', images: ['never-copy'] };
  const before = JSON.stringify(options), c = plain(api.resolveSdkStartConfig(' provider ', ' model ', options));
  assert.deepEqual(Object.keys(c).sort(), ['provider','model','thinking','fast','agentDir','sessionPath','resume','cwd','heartbeatIntervalMs','extensionPaths','additionalSkillPaths','retireUserScopeSkills'].sort());
  assert.equal(c.provider, 'provider'); assert.equal(c.model, 'model'); assert.equal(c.thinking, 'high');
  assert.equal(c.fast, false);
  assert.equal(api.resolveSdkStartConfig('p', 'm', { fast: true }).fast, true);
  assert.equal(api.resolveSdkStartConfig('p', 'm', { fast: 'true' }).fast, false);
  assert.equal(c.agentDir, path.resolve('agent')); assert.equal(c.sessionPath, path.join(c.agentDir, 'named-sessions/named.jsonl'));
  assert.equal(c.heartbeatIntervalMs, 1234); assert.equal(c.resume, false); assert.equal(c.retireUserScopeSkills, true);
  assert.deepEqual(c.extensionPaths, [path.resolve('extension.mjs')]); assert.deepEqual(c.additionalSkillPaths, [path.resolve('skill')]);
  assert.doesNotMatch(JSON.stringify(c), /never-copy/); assert.equal(JSON.stringify(options), before);
  c.extensionPaths.push('changed'); assert.equal(api.resolveSdkStartConfig('provider', 'model', options).extensionPaths.length, 1);
});
test('shared resolver preserves zero interval, explicit values, aliases, resume, defaults and existing validation', () => {
  const api = runtime({ PI_THINKING: 'high', PI_HEARTBEAT_INTERVAL_MS: '99' });
  const c = api.resolveSdkStartConfig('packycode', 'model', { thinking: 'off', heartbeatIntervalMs: 0, resume: true, extensions: ['./ext'], additionalSkillPaths: ['./skill'], retireUserScopeSkills: 'true' });
  assert.equal(c.thinking, 'off'); assert.equal(c.heartbeatIntervalMs, 0); assert.equal(c.resume, true);
  assert.equal(c.retireUserScopeSkills, false); assert.deepEqual(plain(c.extensionPaths), [path.resolve('ext')]);
  const defaults = runtime().resolveSdkStartConfig('packycode', 'm');
  assert.equal(defaults.thinking, 'xhigh'); assert.equal(defaults.heartbeatIntervalMs, 5000); assert.equal(defaults.sessionPath, '');
  assert.throws(() => api.resolveSdkStartConfig('p', 'm', { heartbeatIntervalMs: '-1' }), /non-negative integer/);
});
test('production wire and pre-turn capture use the same resolver, and drift removes checkpoint association before startRun', () => {
  const runtimeSource = fs.readFileSync(path.resolve(__dirname, '../../lib/pi-runtime.ts'), 'utf8');
  const executor = fs.readFileSync(path.resolve(__dirname, '../../server/domain/conversation/turn/agent-executor.ts'), 'utf8');
  assert.match(runtimeSource, /const sdkStartConfig = resolveSdkStartConfig\(provider, model, options\)/);
  assert.match(runtimeSource, /config: sdkStartConfig/);
  assert.match(executor, /sdkStartConfig: structuredClone\(capturedSdkStartConfig\)/);
  const compare = executor.indexOf('JSON.stringify(resolveSdkStartConfig(provider, model, runOptions))');
  const start = executor.indexOf('handle = startRun(provider, model, prompt, runOptions)');
  assert.ok(compare > 0 && compare < start);
  assert.match(executor.slice(compare, start), /badcaseCheckpointId = ''/);
});
