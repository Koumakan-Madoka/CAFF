const test = require('node:test'), assert = require('node:assert/strict');
const { setup, content } = require('../helpers/wiki-category-induction.cjs');
const runtime = require('../../scripts/badcase-capture/wiki-induction.cjs');
const { classify, buildRequestBody } = require('../../scripts/badcase-capture/wiki-induction-container.cjs');
const parse = plan => JSON.parse(plan.files[0].bytes);

test('bounded model input is exactly this category title and training problem/expectation/message/trace; no scope/holdout/other pattern prose', t => {
  const h = setup(t), before = h.bytes(), plan = runtime.prepareWikiCategoryInduction(h.store, h.categoryId), input = parse(plan);
  assert.equal(plan.phase, 'category-induction'); assert.deepEqual(plan.caseIds, h.trainIds);
  assert.deepEqual(Object.keys(input).sort(), ['cases', 'name', 'phase']); assert.equal(input.name, '调用前检查约束');
  assert.deepEqual(input.cases.map(c => c.id).sort(), h.trainIds);
  for (const c of input.cases) assert.deepEqual(Object.keys(c).sort(), ['actual', 'expected', 'id', 'message', 'traceExcerpt']);
  const serialized = JSON.stringify(input);
  assert.equal(serialized.includes('SCOPE_MUST_NOT'), false);
  for (const c of h.store.read().cases.filter(c => !h.trainIds.includes(c.id))) for (const field of ['actual', 'expected', 'message', 'traceExcerpt']) assert.equal(serialized.includes(c[field]), false);
  assert.equal(serialized.includes('Approved pattern'), false); assert.deepEqual(h.bytes(), before);
  const body = JSON.parse(buildRequestBody(input)); assert.equal(body.tools, undefined); assert.equal(body.temperature, 0); assert.equal(body.max_tokens, 32768);
  assert.match(body.messages[0].content, /训练/); assert.match(body.messages[0].content, /300/); assert.match(body.messages[0].content, /failureMode/);
});

test('bounded worker makes one fake request; exact content goes through standard isolated generation and publishes only draft', async t => {
  const h = setup(t); let calls = 0, captured;
  const saved = await runtime.inductWikiCategory({ store: h.store, pendingPatternId: h.categoryId, expectedRevision: h.store.read().revision, confirmed: true, image: {} }, {
    readKey: () => 'synthetic-category-content-key', execute: async (_image, files) => {
      captured = JSON.parse(files[0].bytes);
      const receipt = await classify(captured, { key: 'synthetic-category-content-key', fetchImpl: async (_url, options) => {
        calls++; const body = JSON.parse(options.body); assert.equal(body.tools, undefined);
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: [content()] }) } }] });
      } }); return { cleaned: true, receipt, isolation: { binds: [] } };
    },
  });
  assert.equal(calls, 1); assert.deepEqual(captured.cases.map(c => c.id).sort(), h.trainIds);
  assert.equal(saved.version.entries.at(-1).status, 'draft'); assert.equal(h.store.read().pendingPatternLinks, undefined);
  assert.equal(h.store.read().inductionRuns.at(-1).phase, 'category-induction');
});

test('bounded runner refuses missing consent, stale revision and unready category before key access or execution', async t => {
  const h = setup(t, false); let calls = 0;
  for (const patch of [{ confirmed: false }, { expectedRevision: 0 }, {}]) {
    await assert.rejects(runtime.inductWikiCategory({ store: h.store, pendingPatternId: h.categoryId, expectedRevision: h.store.read().revision, confirmed: true, ...patch },
      { readKey: () => { calls++; }, execute: () => { calls++; } }), /wiki_confirmation_required|wiki_revision_conflict|wiki_category_not_ready/);
  }
  assert.equal(calls, 0);
});

test('invalid bounded output and model-time revision drift never save draft, membership or link; no retries', async t => {
  for (const mode of ['long', 'extra', 'missing', 'drift']) {
    const h = setup(t), before = h.bytes(), revision = h.store.read().revision; let calls = 0;
    await assert.rejects(runtime.inductWikiCategory({ store: h.store, pendingPatternId: h.categoryId, expectedRevision: revision, confirmed: true, image: {} }, {
      readKey: () => 'synthetic-category-content-key', writeDiagnostic: () => {}, execute: async () => {
        calls++; if (mode === 'drift') { const s = h.store.read(); s.revision++; h.publish(s); }
        const draft = mode === 'long' ? { ...content(), guideline: '字'.repeat(301) } : mode === 'extra' ? { ...content(), title: 'forbidden' } : mode === 'missing' ? {} : content();
        return { cleaned: true, receipt: { ok: true, results: [draft], calls: [] } };
      },
    }), /wiki_model_output_invalid|wiki_guideline_too_long|wiki_revision_conflict/);
    assert.equal(calls, 1); assert.equal(h.store.read().pendingPatternLinks, undefined); assert.equal(h.store.read().versions.length, 1);
    if (mode !== 'drift') assert.deepEqual(h.bytes(), before);
  }
});

test('page runtime forwards only operator config and category ID, preserving existing isolation selection', async t => {
  const h = setup(t), fs = require('node:fs'), path = require('node:path');
  const configFile = path.join(h.root, 'runtime.json'), credentialDir = path.join(h.root, 'synthetic-agent');
  fs.writeFileSync(configFile, JSON.stringify({ image: { imageId: 'sha256:' + 'a'.repeat(64), architecture: 'amd64' }, credentialDir }));
  let seen;
  const result = await require('../../scripts/badcase-capture/wiki-page-runtime.cjs').runPageCategoryInduction({ store: h.store, pendingPatternId: h.categoryId, expectedRevision: h.store.read().revision }, { configFile }, {
    readKey: env => { assert.equal(env.PI_CODING_AGENT_DIR, credentialDir); return 'synthetic'; },
    inductCategory: async (args, options) => { seen = args; assert.equal(options.readKey(), 'synthetic'); return 'fake'; },
  });
  assert.equal(result, 'fake'); assert.equal(seen.pendingPatternId, h.categoryId); assert.equal(seen.store, h.store); assert.equal(seen.confirmed, true);
});
