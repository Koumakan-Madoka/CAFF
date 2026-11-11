// Synthetic fixtures and fake provider transport only; never reads production config.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { PassThrough } = require('node:stream');
const { createBadcaseWikiController } = require('../../build/server/api/badcase-wiki-controller');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
function setup(t, mode = 'valid') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-recommend-api-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, store = createWikiStore(scope);
  const c = store.addMarkedCase({ source: { projectId: null, conversationId: 'room', conversationTitle: 'Synthetic room', messageId: 'marked', agentId: mode === 'other' ? 'role-family-deepseek' : 'role-family-gpt' },
    role: mode === 'other' ? 'role-family-deepseek' : 'role-family-gpt', actual: 'wrong', expected: 'right', message: 'reply', traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false, ...(mode === 'scene' ? { sealedCheckpointId: 'sealed-synthetic' } : {}) }).case;
  const packet = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', origin: 'mark', source: c.source, frozenAt: '2026-11-06T00:00:00Z', complete: false, missingReasons: [], redaction: { policy: 'known_values_only' },
    markedStep: 1, markedMessage: 'reply', actual: 'wrong', expected: 'right', context: { systemPrompt: 'system', priorSessionEntries: [], trigger: { message: { role: 'user', content: 'solve this' } } },
    steps: [{ step: 1, output: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }, toolResults: [] }] };
  if (mode === 'unavailable') packet.context.systemPrompt = '【上下文未归档：已知 key 清单不可用】'; // pre-fix frozen packet
  if (mode === 'no-prompt') packet.context.systemPrompt = null;
  if (mode === 'unavailable-metadata') {
    packet.context.systemPrompt = null; packet.context.systemPromptSource = 'unavailable';
    packet.context.archiveUnavailableReason = 'known_key_inventory_unavailable'; packet.missingReasons = ['system_prompt_unavailable'];
  }
  if (mode !== 'missing') store.freezeCaseTrace(c.id, packet);
  const credentialDir = path.join(root, 'agent'), configFile = path.join(root, 'runtime.json'), key = 'synthetic-recommend-only-key';
  fs.mkdirSync(credentialDir); fs.writeFileSync(path.join(credentialDir, 'models.json'), JSON.stringify({ providers: { deepseek: { api: 'openai-completions', baseUrl: 'https://api.deepseek.com', apiKey: key, models: [{ id: 'deepseek-v4-flash' }] } } }));
  fs.writeFileSync(configFile, JSON.stringify({ image: { imageId: 'sha256:' + 'a'.repeat(64), architecture: 'amd64' }, credentialDir }));
  let calls = 0, opens = 0, closed = 0, release;
  const options = { ...scope, host: '127.0.0.1', port: 4313, csrfToken: 'synthetic-csrf', runDehydration: input => {
    opens++;
    return require('../../scripts/badcase-capture/wiki-page-runtime.cjs').runPageDehydration(input, { configFile }, {
      createDispatcher: uri => { assert.equal(uri, 'http://127.0.0.1:17890'); return { destroy: async () => { closed++; } }; },
      fetch: async (url, q) => {
        calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(q.headers.authorization, 'Bearer ' + key); assert.equal(q.redirect, 'error');
        const b = JSON.parse(q.body); assert.equal(b.tools, undefined); assert.equal(b.model, 'deepseek-v4-flash'); assert.equal(b.temperature, 0);
        if (mode === 'pending') await new Promise(r => { release = r; });
        if (mode === 'network') throw Error(key);
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: mode === 'malformed' ? 'REAL INVALID JSON' : JSON.stringify({ kind: '单步型', cutStep: 1, reason: '本步决定', evidence: 'reply' }) } }] });
      },
    });
  } };
  const controller = createBadcaseWikiController(options);
  const route = '/api/wikiskill/cases/' + c.id + '/dehydration/recommend';
  const body = extra => ({ confirmed: true, expectedRevision: store.read().revision, traceHash: store.read().cases[0]?.traceBundle?.hash || 'a'.repeat(64), ...extra });
  async function invoke(value = body(), overrides = {}) {
    const req = new PassThrough(); req.method = overrides.method || 'POST'; req.socket = { remoteAddress: overrides.remoteAddress || '127.0.0.1' };
    req.headers = { host: '127.0.0.1:4313', origin: 'http://127.0.0.1:4313', 'content-type': 'application/json', 'x-caff-csrf-token': 'synthetic-csrf', ...overrides.headers };
    let result; const res = { writeHead(status) { this.status = status; }, end(bytes) { result = { status: this.status, body: JSON.parse(bytes) }; } };
    const p = controller({ req, res, pathname: overrides.pathname || route }); req.end(JSON.stringify(value));
    assert.equal(await p, true, 'recommendation route must be wired'); return result;
  }
  return { root, store, c, packet, scope, body, invoke, options, controller, get calls() { return calls; }, get opens() { return opens; }, get closed() { return closed; }, changeMode: value => { mode = value; }, release: () => release() };
}
const rejects = (p, code, status) => assert.rejects(p, e => e.statusCode === status && e.issues?.[0]?.code === code);
test('trusted recommend API guards and closed schema reject before reading runtime/key or sending', async t => {
  const h = setup(t);
  for (const override of [{ remoteAddress: '10.0.0.1' }, { headers: { host: 'evil.test' } }, { headers: { origin: 'http://evil.test' } }, { headers: { 'x-caff-csrf-token': '' } }])
    await assert.rejects(h.invoke(h.body(), override), e => [403, 404].includes(e.statusCode));
  await rejects(h.invoke(h.body({ confirmed: false })), 'wiki_confirmation_required', 422);
  for (const extra of [{ key: 'bad' }, { configFile: h.root }, { cause: {} }, { response: {} }, { retry: true }]) await rejects(h.invoke(h.body(extra)), 'wiki_invalid_input', 422);
  await rejects(h.invoke(h.body({ expectedRevision: 0 })), 'wiki_revision_conflict', 409);
  await rejects(h.invoke(h.body({ traceHash: 'f'.repeat(64) })), 'wiki_dehydration_stale', 409);
  assert.equal(await h.controller({ req: { method: 'GET' }, res: {}, pathname: '/api/wikiskill/cases/x/dehydration/recommend' }), false);
  assert.equal(h.opens, 0); assert.equal(h.calls, 0);
});
test('eligible new mark sends exactly once with runtime-only config, stores recommendation, and cannot request again or alter frozen trace', async t => {
  const h = setup(t), before = h.store.readCaseTrace(h.c.id), original = h.body();
  const r = await h.invoke(); assert.equal(r.status, 200); assert.equal(h.calls, 1); assert.equal(h.closed, 1);
  const row = r.body.dehydrations[0]; assert.equal(row.recommendation.kindSuggestion, 'single'); assert.equal(row.decision, undefined);
  assert.doesNotMatch(JSON.stringify(r), /synthetic-recommend-only-key|credentialDir|runtime\.json/);
  await rejects(h.invoke(original), 'wiki_revision_conflict', 409);
  await rejects(h.invoke(), 'wiki_dehydration_recommendation_exists', 409);
  h.store.confirmDehydration({ caseId: h.c.id, traceHash: row.traceHash, recommendationHash: row.hash, kind: 'single', cutStep: 1, expectedRevision: h.store.read().revision });
  await rejects(h.invoke(), 'wiki_dehydration_frozen', 409);
  assert.equal(h.calls, 1); assert.deepEqual(h.store.readCaseTrace(h.c.id), before);
});
test('sealed scenes can request a cut recommendation while API projection and persisted scene identity remain trace', async t => {
  const h = setup(t, 'scene'), before = h.store.read(), packet = h.store.readCaseTrace(h.c.id);
  const view = await h.invoke(undefined, { method: 'GET', pathname: '/api/wikiskill' });
  assert.equal(view.body.cases[0].dehydrationRecommendation.eligible, true);
  const response = await h.invoke(); assert.equal(response.status, 200);
  assert.equal(h.opens, 1); assert.equal(h.calls, 1); assert.equal(h.closed, 1);
  assert.equal(response.body.dehydrations[0].recommendation.kindSuggestion, 'single');
  assert.equal(response.body.dehydrations[0].decision, undefined);
  assert.deepEqual(h.store.read().cases, before.cases); assert.deepEqual(h.store.readCaseTrace(h.c.id), packet);
});
test('sealed recommendation can freeze a report-only single cut through HTTP or direct store; non-single remains trace', async t => {
  const h = setup(t, 'scene');
  // Existing recommendation fixture only: no model call and no migration of old data.
  const item = h.store.read().cases[0], built = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration').buildDehydrationRequest({ caseRecord: item, bundle: h.packet, cause: { source: 'trigger', text: 'solve this' } });
  const row = h.store.saveDehydrationRecommendation({ built, expectedRevision: h.store.read().revision, response: { model: 'deepseek/deepseek-v4-flash', attempts: [{ content: JSON.stringify({ kind: '单步型', cutStep: 1, reason: '本步决定', evidence: 'reply' }), finishReason: 'stop' }] } });
  const before = h.store.read(), input = { caseId: h.c.id, traceHash: row.traceHash, recommendationHash: row.hash, kind: 'single', cutStep: 1, expectedRevision: before.revision };
  const result = await h.invoke({ confirmed: true, ...input }, { pathname: '/api/wikiskill/dehydration-confirm' });
  const decision = result.body.dehydrations[0].decision;
  assert.equal(decision.level, 'run'); assert.equal(decision.cutStep, 1);
  assert.deepEqual(h.store.confirmDehydration({ ...input, expectedRevision: h.store.read().revision }), decision);
  const { decision: ignored, ...unchanged } = result.body.dehydrations[0]; assert.deepEqual(unchanged, row);
  assert.deepEqual(h.store.read().cases, before.cases); assert.equal(h.calls, 0); assert.equal(h.opens, 0);
  const throughout = setup(t, 'scene'), item2 = throughout.store.read().cases[0];
  const built2 = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration').buildDehydrationRequest({ caseRecord: item2, bundle: throughout.packet, cause: { source: 'trigger', text: 'solve this' } });
  const r2 = throughout.store.saveDehydrationRecommendation({ built: built2, expectedRevision: throughout.store.read().revision, response: { model: 'deepseek/deepseek-v4-flash', attempts: [{ content: JSON.stringify({ kind: '贯穿型', cutStep: '无', reason: 'Across the trace', evidence: '' }), finishReason: 'stop' }] } });
  assert.equal(throughout.store.confirmDehydration({ caseId: item2.id, traceHash: r2.traceHash, recommendationHash: r2.hash, kind: 'throughout', cutStep: null, expectedRevision: throughout.store.read().revision }).level, 'trace');
});
test('missing or unavailable real system prompt rejects recommendation and legacy single confirmation without writes', async t => {
  for (const mode of ['unavailable', 'unavailable-metadata', 'no-prompt']) {
    const h = setup(t, mode);
    await rejects(h.invoke(), 'wiki_dehydration_ineligible', 422);
    const view = await h.invoke(undefined, { method: 'GET', pathname: '/api/wikiskill' });
    assert.equal(view.body.cases[0].dehydrationRecommendation.eligible, false);
    // Seed the legacy recommendation that the pre-fix implementation could save.
    const state = h.store.read(), packet = h.store.readCaseTrace(h.c.id);
    const row = { caseId: h.c.id, traceHash: state.cases[0].traceBundle.hash, hash: 'c'.repeat(64) };
    state.dehydrations = [row]; state.revision++;
    fs.writeFileSync(path.join(h.scope.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json'), JSON.stringify({ schemaVersion: 1, checksum: require('node:crypto').createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
    const before = h.store.read(), input = { caseId: h.c.id, traceHash: row.traceHash, recommendationHash: row.hash, kind: 'single', cutStep: 1, expectedRevision: before.revision };
    assert.throws(() => h.store.confirmDehydration(input), e => e.code === 'wiki_dehydration_ineligible');
    await rejects(h.invoke({ confirmed: true, ...input }, { pathname: '/api/wikiskill/dehydration-confirm' }), 'wiki_dehydration_ineligible', 422);
    assert.deepEqual(h.store.read(), before); assert.deepEqual(h.store.readCaseTrace(h.c.id), packet);
    assert.equal(h.opens, 0); assert.equal(h.calls, 0);
  }
});
test('missing trace, non-GPT, old sources and deleted cases cannot reach runtime', async t => {
  for (const mode of ['missing', 'other', 'source', 'deleted']) {
    const h = setup(t, mode);
    if (mode === 'source' || mode === 'deleted') {
      // Same checksum envelope mechanism as existing store corruption/legacy tests.
      const state = h.store.read(), id = mode === 'source' ? 'text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b' : 'text-6d9cbd07278d02cc72a12b5a358aad639d802a632679a43de0752e5eff7a3a92';
      state.cases[0].id = id;
      if (mode === 'deleted') { state.deletedCases = [{ case: state.cases[0] }]; state.cases = []; }
      state.revision++;
      fs.writeFileSync(path.join(h.scope.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json'), JSON.stringify({ schemaVersion: 1, checksum: require('node:crypto').createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state }));
      await rejects(h.invoke(h.body(), { pathname: '/api/wikiskill/cases/' + id + '/dehydration/recommend' }), mode === 'deleted' ? 'wiki_case_deleted' : 'wiki_dehydration_ineligible', mode === 'deleted' ? 409 : 422);
    } else await rejects(h.invoke(), 'wiki_dehydration_ineligible', 422);
    assert.equal(h.calls, 0); assert.equal(h.opens, 0);
  }
});
test('parse failure is stored after ONE call; manual hash-bound retry appends without replacing old evidence and may be confirmed', async t => {
  const h = setup(t, 'malformed');
  let r = await h.invoke(); const first = structuredClone(r.body.dehydrations[0]);
  assert.equal(h.calls, 1); assert.equal(first.recommendation.fallbackReason, 'parse_failed'); assert.equal(first.recommendation.cutStepSuggestion, 1);
  assert.equal(first.recommendation.attempts[0].content, 'REAL INVALID JSON'); assert.equal(first.recommendation.attempts.length, 1);
  await rejects(h.invoke(), 'wiki_dehydration_recommendation_exists', 409);
  await rejects(h.invoke(h.body({ retryOf: 'f'.repeat(64) })), 'wiki_dehydration_stale', 409);
  r = await h.invoke(h.body({ retryOf: first.hash })); const second = r.body.dehydrations.at(-1);
  assert.equal(h.calls, 2); assert.equal(second.retryOf, first.hash); assert.notEqual(second.hash, first.hash); assert.deepEqual(r.body.dehydrations[0], first);
  await rejects(h.invoke(h.body({ retryOf: second.hash })), 'wiki_dehydration_recommendation_exists', 409);
  h.store.confirmDehydration({ caseId: h.c.id, traceHash: second.traceHash, recommendationHash: second.hash, kind: 'single', cutStep: 1, expectedRevision: h.store.read().revision });
  assert.equal(h.store.getDehydration(h.c.id).decision.kind, 'single'); assert.deepEqual(h.store.read().dehydrations[0], first);
});
test('manual retry can recover, keeps the first record, and frozen hash binds only the selected latest recommendation', async t => {
  const h = setup(t, 'malformed'), first = (await h.invoke()).body.dehydrations[0]; h.changeMode('valid');
  const latest = (await h.invoke(h.body({ retryOf: first.hash }))).body.dehydrations.at(-1);
  assert.equal(h.calls, 2); assert.equal(latest.recommendation.kindSuggestion, 'single'); assert.deepEqual(h.store.read().dehydrations[0], first);
  assert.throws(() => h.store.confirmDehydration({ caseId: h.c.id, traceHash: first.traceHash, recommendationHash: first.hash, kind: 'single', cutStep: 1, expectedRevision: h.store.read().revision }), e => e.code === 'wiki_dehydration_stale');
  h.store.confirmDehydration({ caseId: h.c.id, traceHash: latest.traceHash, recommendationHash: latest.hash, kind: 'single', cutStep: 1, expectedRevision: h.store.read().revision });
  await rejects(h.invoke(), 'wiki_dehydration_frozen', 409); assert.deepEqual(h.store.read().dehydrations[0], first);
});
test('missing runtime selection fails with a fixed safe code and does not send or store invented output', async t => {
  const h = setup(t); h.options.runDehydration = input => require('../../scripts/badcase-capture/wiki-page-runtime.cjs').runPageDehydration(input);
  await rejects(h.invoke(), 'wiki_runtime_config_required', 503); assert.equal(h.calls, 0); assert.equal(h.store.getDehydration(h.c.id), null);
  const src = fs.readFileSync(path.join(__dirname, '../../server/app/create-server.ts'), 'utf8');
  assert.match(src, /runDehydration:[\s\S]*runPageDehydration\(input/); assert.match(src, /CAFF_BADCASE_WIKI_RUNTIME_CONFIG/);
});
test('concurrent HTTP requests with distinct store objects cannot double-send; network errors are safe and never retried', async t => {
  const h = setup(t, 'pending'), p = h.invoke();
  await new Promise(r => setImmediate(r)); assert.equal(h.calls, 1);
  await rejects(h.invoke(), 'wiki_dehydration_busy', 409); assert.equal(h.calls, 1);
  h.release(); await p; assert.equal(h.closed, 1);
  const bad = setup(t, 'network'); await rejects(bad.invoke(), 'wiki_dehydration_model_failed', 503);
  assert.equal(bad.calls, 1); assert.equal(bad.closed, 1); assert.equal(bad.store.getDehydration(bad.c.id), null);
});
