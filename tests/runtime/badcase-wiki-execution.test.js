const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const load = () => require('../../build/server/domain/runtime/badcase-capture/wiki-execution-store');
const plan = () => ({ kind: 'sealed-original-replay-v1', variants: ['original'], model: 'openai-codex/gpt-6.1-sol', modelConfig: { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', hostOnlyCredential: true }, repeats: 2, caseId: 'case-1', checkpointHash: 'a'.repeat(64), rulesHash: 'b'.repeat(64), extra: 'never publish input text or paths' });
const run = i => ({ event: 'run', variant: 'original', iteration: i, status: i === 1 ? 'fail' : 'pass', cleaned: true, durationMs: 10, finalText: 'PRIVATE_REPLY', fileEvidence: [{ path: '/private/file', base64: 'PRIVATE_FILE' }], tokenUsage: { knownCalls: 1, callsWithoutUsage: 0, callsUnavailable: false, knownTokens: { totalTokens: 7 } } });
function scope(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-execution-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') }; }

test('execution progress is projected, durable, isolated from wiki revisions and never a prompt-adoption decision', t => {
  const config = scope(t), { createWikiExecutionStore } = load(), store = createWikiExecutionStore(config);
  assert.deepEqual(store.read(), []); assert.equal(fs.existsSync(config.globalRoot), false);
  const record = store.start(plan()); assert.equal(record.status, 'running'); assert.equal(record.runs.length, 0);
  store.event(record.id, { event: 'run_start', variant: 'original', iteration: 1 });
  assert.deepEqual(store.read()[0].current, { variant: 'original', iteration: 1 });
  store.event(record.id, run(1)); store.event(record.id, { event: 'run_start', variant: 'original', iteration: 2 }); store.event(record.id, run(2));
  const done = store.finish(record.id, { ...plan(), completed: true, finalText: 'PRIVATE_REPLY', runs: [] });
  assert.equal(done.status, 'completed'); assert.equal(done.summary.completedRuns, 2); assert.equal(done.summary.totals.original.passed, 1);
  assert.equal(done.summary.knownTokens, 14); assert.equal(done.conclusion, 'original_observation_only'); assert.equal(done.current, null);
  const saved = createWikiExecutionStore(config).read()[0]; assert.deepEqual(saved, done);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|never publish|\/private\//);
  const wiki = require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore(config).read(); assert.equal(wiki.revision, 0); assert.deepEqual(wiki.events, []);
});

test('duplicate/out-of-order slots, late updates and inconsistent completion fail without overwriting the record', t => {
  const store = load().createWikiExecutionStore(scope(t)), started = store.start(plan());
  assert.throws(() => store.event(started.id, { event: 'run_start', variant: 'candidate', iteration: 1 }), /wiki_execution_invalid/);
  assert.throws(() => store.event(started.id, run(2)), /wiki_execution_invalid/);
  store.event(started.id, { event: 'run_start', variant: 'original', iteration: 1 }); store.event(started.id, run(1));
  const before = store.read(); assert.throws(() => store.event(started.id, run(1)), /wiki_execution_invalid/); assert.deepEqual(store.read(), before);
  assert.throws(() => store.finish(started.id, { ...plan(), completed: true }), /wiki_execution_invalid/);
  store.fail(started.id, 'evaluation_input_changed'); const stopped = store.read()[0]; assert.equal(stopped.status, 'failed');
  assert.equal(stopped.summary.totals.original.notRun, 1); assert.equal(stopped.conclusion, 'incomplete');
  assert.throws(() => store.event(started.id, { event: 'run_start', variant: 'original', iteration: 2 }), /wiki_execution_invalid/);
});

test('separate runs never pool counts; malformed checksum is not silently hidden', t => {
  const config = scope(t), store = load().createWikiExecutionStore(config), first = store.start(plan()), second = store.start(plan());
  store.event(first.id, { event: 'run_start', variant: 'original', iteration: 1 }); store.event(first.id, run(1)); store.fail(first.id, 'evaluation_failed');
  assert.equal(store.read().find(r => r.id === second.id).summary.completedRuns, 0);
  const dir = path.join(config.globalRoot, 'executions'), file = path.join(dir, first.id + '.json'), bytes = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, bytes.replace('running', 'corrupted').replace('evaluation_failed', 'evaluation_corrupt'));
  assert.throws(() => store.read(), /wiki_execution_record_invalid/);
});

test('CLI failure preserves partial denominators and sanitized evidence without retrying the model', async t => {
  const { main } = require('../../scripts/badcase-capture/run-wiki-evaluation.cjs');
  const config = scope(t), file = path.join(path.dirname(config.globalRoot), 'config.json'), output = file + '.jsonl';
  fs.writeFileSync(file, JSON.stringify({ ...config, comparison: {} })); let calls = 0;
  const deps = { prepare: () => ({ supported: true, summary: plan() }), print: () => {}, run: async (_config, options) => {
    calls++; options.onEvent({ event: 'run_start', variant: 'original', iteration: 1 }); options.onEvent(run(1));
    throw Object.assign(Error('PRIVATE_PROVIDER_DIAGNOSTIC'), { code: 'evaluation_codex_proxy_failed' });
  } };
  const p = await main(['--config', file, '--plan'], deps);
  await assert.rejects(main(['--config', file, '--run', '--confirmed', '--expected-plan', p.planHash, '--output', output], deps), /evaluation_codex_proxy_failed/);
  const record = load().createWikiExecutionStore(config).read()[0];
  assert.equal(calls, 1); assert.equal(record.status, 'failed'); assert.equal(record.summary.completedRuns, 1); assert.equal(record.summary.totals.original.notRun, 1);
  assert.equal(record.conclusion, 'incomplete'); assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /PRIVATE_PROVIDER_DIAGNOSTIC/);
});
test('CLI preserves specific unsupported material reasons if the sealed input becomes unavailable after plan', async t => {
  const { main } = require('../../scripts/badcase-capture/run-wiki-evaluation.cjs');
  const config = scope(t), file = path.join(path.dirname(config.globalRoot), 'config.json'); fs.writeFileSync(file, JSON.stringify({ ...config, comparison: {} }));
  const output = file + '.jsonl', printed = [], deps = { prepare: () => ({ supported: true, summary: plan() }), print: s => printed.push(s), run: async () => ({ supported: false, reason: 'replay_prompt_size_limit' }) };
  const p = await main(['--config', file, '--plan'], deps);
  const result = await main(['--config', file, '--run', '--confirmed', '--expected-plan', p.planHash, '--output', output], deps);
  assert.equal(result.supported, false); assert.equal(result.reason, 'replay_prompt_size_limit'); assert.match(printed.at(-1), /replay_prompt_size_limit/);
  assert.equal(load().createWikiExecutionStore(config).read()[0].status, 'failed');
});

test('CLI process --plan exits zero and writes no progress or credentials', t => {
  const cp = require('node:child_process'), config = scope(t), root = path.dirname(config.globalRoot), file = path.join(root, 'config.json'), preload = path.join(root, 'fake-plan.cjs');
  fs.writeFileSync(file, JSON.stringify({ ...config, comparison: {} }));
  const target = path.resolve(__dirname, '../../scripts/badcase-capture/run-wiki-evaluation.cjs'), direct = path.resolve(__dirname, '../../scripts/badcase-capture/direct-comparison.cjs');
  fs.writeFileSync(preload, `require.cache[${JSON.stringify(direct)}]={id:${JSON.stringify(direct)},filename:${JSON.stringify(direct)},loaded:true,exports:{prepareComparison:()=>(${JSON.stringify({ supported: true, summary: plan() })})}};`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k)));
  const result = cp.spawnSync(process.execPath, ['--require', preload, target, '--config', file, '--plan'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).preparedOnly, true); assert.equal(fs.existsSync(config.globalRoot), false);
});

test('unfinished staged-policy publication is explicitly rejected before preparation or model access', async t => {
  const { main } = require('../../scripts/badcase-capture/run-wiki-evaluation.cjs');
  const config = scope(t), file = path.join(path.dirname(config.globalRoot), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...config, comparison: { executionPolicy: 'alternating-valid-v1' } }));
  let prepares = 0;
  await assert.rejects(main(['--config', file, '--plan'], { prepare: () => { prepares++; return { supported: true, summary: plan() }; }, print: () => {} }), /evaluation_page_execution_policy_unsupported/);
  assert.equal(prepares, 0); assert.equal(fs.existsSync(config.globalRoot), false);
});
test('trusted CLI requires explicit confirmation and plan hash; plan does not publish or invoke model', async t => {
  const { main } = require('../../scripts/badcase-capture/run-wiki-evaluation.cjs');
  const config = scope(t), file = path.join(path.dirname(config.globalRoot), 'config.json'), output = file + '.jsonl';
  fs.writeFileSync(file, JSON.stringify({ ...config, comparison: { synthetic: true } }));
  let calls = 0; const deps = { prepare: () => ({ supported: true, summary: plan() }), run: async (_config, options) => { calls++; options.onEvent({ event: 'run_start', variant: 'original', iteration: 1 }); options.onEvent(run(1)); options.onEvent({ event: 'run_start', variant: 'original', iteration: 2 }); options.onEvent(run(2)); return { ...plan(), supported: true, completed: true }; }, print: () => {} };
  const prepared = await main(['--config', file, '--plan'], deps); assert.equal(calls, 0); assert.equal(fs.existsSync(config.globalRoot), false); assert.match(prepared.planHash, /^[a-f0-9]{64}$/);
  await assert.rejects(main(['--config', file, '--run', '--confirmed', '--expected-plan', '0'.repeat(64), '--output', output], deps), /evaluation_page_confirmation_required/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(config.globalRoot), false);
  const result = await main(['--config', file, '--run', '--confirmed', '--expected-plan', prepared.planHash, '--output', output], deps);
  assert.equal(calls, 1); assert.equal(result.completed, true); assert.equal(load().createWikiExecutionStore(config).read()[0].status, 'completed');
  assert.throws(() => JSON.parse(fs.readFileSync(output, 'utf8')), 'raw output remains JSONL');
  await assert.rejects(main(['--config', file, '--run', '--confirmed', '--expected-plan', prepared.planHash, '--output', output], deps)); assert.equal(calls, 1);
});
