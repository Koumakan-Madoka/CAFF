const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, setup, hash, legacyId } = require('../helpers/wiki-pending-patterns.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { projectWikiPatternLabels: labels, planWikiInitialSplit: split } = require(base + 'wiki-initial-split');
const { planWikiEvaluationSuite: suite, wikiConfirmedClassification } = require(base + 'wiki-evaluation-suite');
const immutable = state => Object.fromEntries(['cases', 'versions', 'classifications', 'caseStates', 'replayCases', 'replaySplit',
  'regroupProposals', 'regroupConfirmations', 'dehydrations', 'rubrics'].map(k => [k, JSON.stringify(state[k])]));
function labelGroup(h, caseIds, name) {
  const first = h.confirm(caseIds[0], { pendingPattern: { name } });
  for (const caseId of caseIds.slice(1)) h.confirm(caseId, { pendingPattern: { id: first.pendingPatternId } });
  return first.pendingPatternId;
}
function allocate(h, key) {
  const state = h.store.read(), proposal = split(state, []);
  return h.store.confirmInitialSplit({ proposalHash: proposal.hash, patternKey: key, expectedRevision: state.revision });
}

test('legacy revision-shaped state including #14 null label keeps its golden proposal hash and bytes on read and unrelated write', t => {
  const h = setup(t), before = h.bytes(), state = h.store.read();
  assert.equal(split(state, []).hash, 'd5112ca22f31160258d688ee4a491156b31b53120577be076d81d9a001a870c2');
  assert.equal(labels(state).find(r => r.caseId === legacyId).patternKey, 'unclassified');
  assert.deepEqual(h.bytes(), before);
  h.confirm('new-1', { entryId: 'entry-1' });
  const after = h.store.read();
  assert.equal(JSON.stringify(after.patternLabels[0]), JSON.stringify(state.patternLabels[0]));
  assert.deepEqual(immutable(after), immutable(state));
  for (const [file, bytes] of Object.entries(before)) assert.equal(h.bytes()[file], bytes);
  assert.equal(Object.hasOwn(after, 'pendingPatterns'), false, 'do not normalize old records by adding empty arrays');
  assert.equal(split({ ...fixture(), pendingPatterns: [], pendingPatternLinks: [] }, []).hash, 'd5112ca22f31160258d688ee4a491156b31b53120577be076d81d9a001a870c2');
});

test('create/join/none/approved label consent is atomic, immutable and exact replay is idempotent after other writes', t => {
  const h = setup(t), before = h.store.read(), bytes = h.bytes();
  const input = h.input('new-1', { pendingPattern: { name: '检查工具约束' } });
  const created = h.store.confirmPatternLabel(input), after = h.store.read();
  assert.equal(after.revision, before.revision + 1); assert.equal(after.pendingPatterns.length, 1);
  const pending = after.pendingPatterns[0]; assert.equal(pending.id, created.pendingPatternId); assert.equal(pending.name, '检查工具约束');
  assert.equal(created.entryId, null); assert.deepEqual(immutable(after), immutable(before));
  assert.deepEqual(Object.keys(h.bytes()).filter(k => !Object.hasOwn(bytes, k)).length, 1);
  const joinedInput = h.input('new-2', { pendingPattern: { id: pending.id } });
  const joined = h.store.confirmPatternLabel(joinedInput); assert.equal(joined.pendingPatternId, pending.id);
  h.confirm('new-3', { entryId: null }); h.confirm('new-4', { entryId: 'entry-2' });
  const final = h.store.read(), revision = final.revision;
  assert.deepEqual(h.store.confirmPatternLabel(input), created);
  assert.deepEqual(h.store.confirmPatternLabel(joinedInput), joined); assert.equal(h.store.read().revision, revision);
  assert.equal(final.pendingPatterns.length, 1);
  assert.equal(labels(final).find(r => r.caseId === 'new-1').patternKey, pending.id);
  assert.equal(labels(final).find(r => r.caseId === 'new-2').pendingPatternId, pending.id);
  assert.equal(labels(final).find(r => r.caseId === 'new-3').patternKey, 'unclassified');
  assert.equal(labels(final).find(r => r.caseId === 'new-4').entryId, 'entry-2');
  for (const selection of [{ entryId: null }, { entryId: 'entry-1' }, { pendingPattern: { name: 'Changed' } }, { pendingPattern: { id: 'missing' } }]) {
    assert.throws(() => h.confirm('new-1', selection), /wiki_pattern_label_frozen/);
  }
  assert.throws(() => h.confirm('new-3', { pendingPattern: { id: pending.id } }), /wiki_pattern_label_frozen/);
  assert.deepEqual(immutable(h.store.read()), immutable(before));
});

// A frozen page label must also fence the pre-existing classification paths.
function frozenPageCases(t, kind, allocated = true) {
  const h = setup(t), seeded = h.store.read();
  for (const c of seeded.cases.filter(c => c.id.startsWith('new-'))) {
    c.preclassification = { ...c.preclassification, kind: 'assign', entryId: 'entry-2' };
    seeded.suggestions.push({ id: 'suggestion-' + c.id, caseId: c.id, kind: 'assign', entryId: 'entry-2',
      status: 'pending', reason: 'Synthetic existing-mode suggestion', createdAt: c.createdAt });
  }
  seeded.revision++; h.publish(seeded);
  const caseIds = ['new-1', 'new-2', 'new-3', 'new-4'];
  const key = kind === 'pending' ? labelGroup(h, caseIds, '先检查工具约束') : kind === 'approved' ? 'entry-1' : 'unclassified';
  if (kind !== 'pending') for (const caseId of caseIds) h.confirm(caseId, { entryId: kind === 'approved' ? 'entry-1' : null });
  if (allocated) allocate(h, key);
  return { ...h, key, holdouts: h.store.read().cases.filter(c => c.id.startsWith('new-') && c.split !== 'train') };
}
for (const kind of ['approved', 'pending', 'none']) {
  test(`${kind} page-labelled gate/test cases are confirmed, not legacy pending classifications`, t => {
    const h = frozenPageCases(t, kind), before = h.bytes();
    for (const c of h.holdouts) {
      const view = h.store.getCaseStates().find(v => v.caseId === c.id);
      assert.equal(view.status, 'classification-confirmed');
      assert.deepEqual(view.memberships.map(m => m.entryId), kind === 'approved' ? ['entry-1'] : []);
      if (kind === 'pending') assert.match(view.reason, /待归纳.*先检查工具约束/);
      assert.equal(view.updatedAt, h.store.read().patternLabels.find(r => r.caseId === c.id).confirmedAt);
    }
    assert.deepEqual(h.bytes(), before, 'view projection must not publish or rewrite records');
    if (kind === 'pending') {
      h.store.linkPendingPattern({ pendingPatternId: h.key, entryId: 'entry-1', expectedRevision: h.store.read().revision });
      for (const c of h.holdouts) {
        const view = h.store.getCaseStates().find(v => v.caseId === c.id);
        assert.equal(view.status, 'classification-confirmed'); assert.deepEqual(view.memberships.map(m => m.entryId), ['entry-1']);
      }
    }
    // Labels also confirm historical holdouts that have no preclassification.
    const state = h.store.read();
    for (const c of state.cases.filter(c => h.holdouts.some(v => v.id === c.id))) delete c.preclassification;
    state.revision++; h.publish(state);
    assert.ok(h.holdouts.every(c => h.store.getCaseStates().find(v => v.caseId === c.id).status === 'classification-confirmed'));
  });

  test(`${kind} page labels reject legacy manual membership before and after allocation with no writes`, t => {
    const h = frozenPageCases(t, kind), before = h.store.read();
    const selections = h.holdouts.map(c => ({ sourceCaseId: c.id, category: 'reproduction' })), targets = suite(before, selections, 'entry-1');
    assert.equal(targets.targetReproductionCaseIds.length, kind === 'approved' ? 1 : 0);
    // A labelled but not-yet-allocated case is non-training too.
    for (const group of [h, frozenPageCases(t, kind, false)]) {
      const state = group.store.read(), bytes = group.bytes();
      for (const c of group.holdouts) for (const entryId of ['entry-1', 'entry-2', null]) {
        assert.throws(() => group.store.assignCase({ caseId: c.id, entryId, expectedRevision: state.revision }), /wiki_pattern_label_frozen/);
        assert.deepEqual(group.bytes(), bytes); assert.deepEqual(group.store.read(), state);
      }
    }
    assert.deepEqual(suite(h.store.read(), selections, 'entry-1'), targets);
    const train = before.cases.find(c => c.id.startsWith('new-') && c.split === 'train');
    h.store.assignCase({ caseId: train.id, entryId: 'entry-2', expectedRevision: before.revision });
    assert.equal(h.store.getCaseStates().find(v => v.caseId === train.id).memberships[0].entryId, 'entry-2', 'training membership rules stay unchanged');
    assert.equal(JSON.stringify(h.store.read().patternLabels), JSON.stringify(before.patternLabels));
  });

  test(`${kind} page labels reject accepting or rejecting old assign suggestions without resolving or writing`, t => {
    for (const h of [frozenPageCases(t, kind), frozenPageCases(t, kind, false)]) {
      const before = h.store.read(), bytes = h.bytes();
      for (const c of h.holdouts) for (const decision of ['accepted', 'rejected']) {
        assert.throws(() => h.store.resolveSuggestion({ suggestionId: 'suggestion-' + c.id, decision, expectedRevision: before.revision }), /wiki_pattern_label_frozen/);
        assert.deepEqual(h.store.read(), before); assert.deepEqual(h.bytes(), bytes);
      }
    }
  });

  test(`${kind} page/classification overlap fails closed on resolved identity mismatch and preserves matching provenance`, t => {
    const h = frozenPageCases(t, kind), source = h.holdouts.find(c => c.split === 'gate');
    const check = () => {
      const state = h.store.read(), entryId = labels(state).find(r => r.caseId === source.id).entryId;
      const saved = { caseId: source.id, entryId, source: 'model-confirmed', confirmedAt: '2026-11-08T01:00:00.000Z' };
      state.classifications.push(saved);
      const bytes = JSON.stringify(state);
      assert.deepEqual(wikiConfirmedClassification(state, source), saved);
      suite(state, [{ sourceCaseId: source.id, category: 'reproduction' }], 'entry-1');
      assert.equal(JSON.stringify(state), bytes);
      for (const mismatch of [null, 'entry-1', 'entry-2'].filter(id => id !== entryId)) {
        saved.entryId = mismatch; const before = JSON.stringify(state);
        assert.throws(() => wikiConfirmedClassification(state, source), /wiki_classification_confirmation_required/);
        assert.throws(() => suite(state, [{ sourceCaseId: source.id, category: 'reproduction' }], 'entry-1'), /wiki_classification_confirmation_required/);
        assert.equal(JSON.stringify(state), before);
      }
    };
    check();
    if (kind === 'pending') {
      h.store.linkPendingPattern({ pendingPatternId: h.key, entryId: 'entry-1', expectedRevision: h.store.read().revision });
      check();
    }
  });
}

test('pending names, selection schemas, revision and label hash fail closed without orphan records', t => {
  const h = setup(t); labelGroup(h, ['new-1'], 'Existing pending');
  for (const [selection, error] of [
    [{ pendingPattern: { name: '' } }, /wiki_pending_pattern_name_invalid/],
    [{ pendingPattern: { name: '  ' } }, /wiki_pending_pattern_name_invalid/],
    [{ pendingPattern: { name: '字'.repeat(41) } }, /wiki_pending_pattern_name_invalid/],
    [{ pendingPattern: { name: 'Existing pending' } }, /wiki_pending_pattern_name_conflict/],
    [{ pendingPattern: { name: '  Approved pattern 1  ' } }, /wiki_pending_pattern_name_conflict/],
    [{ pendingPattern: { id: 'missing' } }, /wiki_pending_pattern_not_found/],
    [{ pendingPattern: { name: 'new', id: 'mixed' } }, /wiki_invalid_input/],
    [{ pendingPattern: { name: 'new', entryId: 'entry-1' } }, /wiki_invalid_input/],
    [{ pendingPattern: null }, /wiki_invalid_input/], [{ pendingPattern: [] }, /wiki_invalid_input/],
    [{ entryId: null, pendingPattern: { name: 'new' } }, /wiki_invalid_input/],
    [{ entryId: 'entry-3' }, /wiki_entry_not_found/], [{}, /wiki_invalid_identifier/],
  ]) {
    const before = h.store.read(), bytes = h.bytes();
    assert.throws(() => h.confirm('new-2', selection), error);
    assert.deepEqual(h.store.read(), before); assert.deepEqual(h.bytes(), bytes);
  }
  const input = h.input('new-2', { pendingPattern: { name: 'Another' } });
  for (const [patch, error] of [[{ labelHash: hash('stale') }, /wiki_pattern_label_stale/],
    [{ expectedRevision: input.expectedRevision - 1 }, /wiki_revision_conflict/], [{ caseId: 'missing' }, /wiki_unknown_case/],
    [{ split: 'gate' }, /wiki_invalid_input/]]) {
    const before = h.bytes(); assert.throws(() => h.store.confirmPatternLabel({ ...input, ...patch }), error); assert.deepEqual(h.bytes(), before);
  }
  const original = fs.linkSync, before = h.bytes();
  try { fs.linkSync = () => { throw Error('synthetic disk failure'); };
    assert.throws(() => h.store.confirmPatternLabel(input), /wiki_write_failed/);
  } finally { fs.linkSync = original; }
  assert.deepEqual(h.bytes(), before); assert.equal(h.store.read().pendingPatterns.length, 1);
  const saved = h.confirm('new-2', { pendingPattern: { name: '😀'.repeat(40) } });
  assert.equal([...h.store.read().pendingPatterns.find(p => p.id === saved.pendingPatternId).name].length, 40);
});

test('pending choices bind the label hash and cannot replace any previously confirmed legacy label', t => {
  const h = setup(t), stale = h.input('new-2', { entryId: null });
  labelGroup(h, ['new-1'], 'First');
  assert.throws(() => h.store.confirmPatternLabel({ ...stale, expectedRevision: h.store.read().revision }), /wiki_pattern_label_stale/);
  assert.throws(() => h.confirm(legacyId, { pendingPattern: { name: 'Cannot relabel old null' } }), /wiki_pattern_label_frozen/);
  assert.throws(() => h.confirm('old-control', { pendingPattern: { name: 'Cannot relabel classification' } }), /wiki_pattern_label_frozen/);
  assert.throws(() => h.confirm('old-train', { pendingPattern: { name: 'Cannot relabel membership' } }), /wiki_pattern_label_frozen/);
  assert.equal(h.store.read().pendingPatterns.length, 1);
});

test('two pending patterns and unclassified each get trace 2:1:1 quotas; unconfirmed suggestions do not block them', t => {
  const h = setup(t, 13), a = labelGroup(h, ['new-1', 'new-2', 'new-3', 'new-4'], 'Pattern A');
  const b = labelGroup(h, ['new-5', 'new-6', 'new-7', 'new-8'], 'Pattern B');
  for (let i = 9; i <= 12; i++) h.confirm('new-' + i, { entryId: null });
  const state = h.store.read(), p = split(state, []);
  for (const key of [a, b, 'unclassified']) {
    const bucket = p.patterns.find(v => v.patternKey === key);
    assert.deepEqual(bucket.counts.trace, { train: 2, gate: 1, test: 1 });
    assert.deepEqual(bucket.existingCounts.trace, { train: 0, gate: 0, test: 0 });
    assert.equal(bucket.rows.filter(r => r.proposedSplit).length, 4);
  }
  assert.equal(p.rows.find(r => r.caseId === 'new-13').reason, 'pattern_label_unconfirmed');
  assert.equal(p.blockers.length, 0);
  for (const key of [a, b, 'unclassified']) allocate(h, key);
  const after = h.store.read(); assert.equal(after.initialSplitConfirmations.length, 3);
  assert.deepEqual(after.cases.filter(c => !c.id.startsWith('new-')), state.cases.filter(c => !c.id.startsWith('new-')));
  assert.equal(after.cases.find(c => c.id === 'new-13').split, null);
});

test('pending patterns preserve run gate capacity per bucket and cannot put a run in test', t => {
  const h = setup(t, 10), a = labelGroup(h, ['new-1', 'new-2', 'new-3', 'new-4', 'new-5'], 'A');
  const b = labelGroup(h, ['new-6', 'new-7', 'new-8', 'new-9', 'new-10'], 'B');
  const state = h.store.read(), accounting = [];
  // A has four trace slots plus one run; B has no trace capacity at all.
  for (const c of state.cases.filter(c => c.id === 'new-5' || /new-(?:6|7|8|9|10)$/.test(c.id))) {
    c.sealedCheckpointId = null; const decision = { hash: hash(['decision', c.id]), level: 'run', kind: 'single' };
    state.dehydrations.push({ caseId: c.id, traceHash: c.traceBundle.hash, decision });
    accounting.push({ id: hash(['result', c.id]), caseId: c.id, traceHash: c.traceBundle.hash, decisionHash: decision.hash,
      variant: { kind: 'original' }, baselineStatus: 'valid_output', caseEligibleForGateAndScreen: true });
  }
  const p = split(state, accounting), pa = p.patterns.find(p => p.patternKey === a), pb = p.patterns.find(p => p.patternKey === b);
  assert.equal(pa.counts.trace.gate, 1); assert.equal(pa.counts.run.test, 0);
  assert.equal(pb.counts.trace.gate, 0); assert.equal(pb.counts.run.gate, 0); assert.equal(pb.counts.run.test, 0);
  assert.ok(p.rows.filter(r => r.level === 'run').every(r => r.proposedSplit !== 'test'));
});

function suiteSelections(state, pendingId) {
  const rows = labels(state).filter(r => r.pendingPatternId === pendingId).map(r => state.cases.find(c => c.id === r.caseId));
  return rows.filter(c => ['gate', 'test'].includes(c.split)).map(c => ({ sourceCaseId: c.id, category: 'reproduction' }))
    .concat({ sourceCaseId: 'old-control', category: 'control' });
}

test('link once to an approved entry changes target projections and quota accounting, never frozen data or membership', t => {
  const h = setup(t, 6), a = labelGroup(h, ['new-1', 'new-2', 'new-3', 'new-4'], 'A'); allocate(h, a);
  const b = labelGroup(h, ['new-5'], 'B'), before = h.store.read(), bytes = h.bytes();
  const selections = suiteSelections(before, a), unlinked = suite(before, selections, 'entry-1');
  assert.deepEqual(unlinked.targetReproductionCaseIds, []); assert.deepEqual(unlinked.targetTestReproductionCaseIds, []);
  const input = { pendingPatternId: a, entryId: 'entry-1', expectedRevision: before.revision };
  const link = h.store.linkPendingPattern(input), after = h.store.read();
  assert.equal(after.revision, before.revision + 1); assert.equal(after.pendingPatternLinks.length, 1);
  assert.equal(link.entryId, 'entry-1'); assert.deepEqual(h.store.linkPendingPattern(input), link);
  assert.equal(h.store.read().revision, after.revision);
  assert.deepEqual(immutable(after), immutable(before));
  for (const k of ['patternLabels', 'pendingPatterns', 'initialSplitConfirmations']) assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]));
  for (const [file, content] of Object.entries(bytes)) assert.equal(h.bytes()[file], content);
  const linked = suite(after, selections, 'entry-1');
  assert.equal(linked.targetReproductionCaseIds.length, 1); assert.equal(linked.targetTestReproductionCaseIds.length, 1);
  assert.equal(suite(after, selections, 'entry-2').targetReproductionCaseIds.length, 0);
  assert.ok(labels(after).filter(r => r.pendingPatternId === a).every(r => r.entryId === 'entry-1' && r.patternKey === 'entry-1'));
  assert.deepEqual(split(after, []).patterns.find(p => p.patternKey === 'entry-1').existingCounts.trace, { train: 3, gate: 1, test: 1 });
  h.store.linkPendingPattern({ pendingPatternId: b, entryId: 'entry-1', expectedRevision: after.revision });
  const proposal = split(h.store.read(), []); assert.equal(proposal.patterns.some(p => [a, b].includes(p.patternKey)), false);
  assert.equal(proposal.rows.find(r => r.caseId === 'new-5').patternKey, 'entry-1');
  const joined = h.confirm('new-6', { pendingPattern: { id: a } });
  assert.equal(joined.pendingPatternId, a); assert.equal(labels(h.store.read()).find(r => r.caseId === 'new-6').patternKey, 'entry-1');
});

test('link refuses absent/unapproved targets, unknown pending IDs, revision drift, changed consent and extra fields atomically', t => {
  const h = setup(t), a = labelGroup(h, ['new-1'], 'A'), input = { pendingPatternId: a, entryId: 'entry-1', expectedRevision: h.store.read().revision };
  for (const [patch, error] of [[{ entryId: 'entry-3' }, /wiki_entry_not_found/], [{ entryId: 'missing' }, /wiki_entry_not_found/],
    [{ pendingPatternId: 'missing' }, /wiki_pending_pattern_not_found/], [{ expectedRevision: 0 }, /wiki_revision_conflict/],
    [{ automatic: true }, /wiki_invalid_input/]]) {
    const before = h.bytes(); assert.throws(() => h.store.linkPendingPattern({ ...input, ...patch }), error); assert.deepEqual(h.bytes(), before);
  }
  const original = fs.linkSync, bytes = h.bytes();
  try { fs.linkSync = () => { throw Error('synthetic disk failure'); }; assert.throws(() => h.store.linkPendingPattern(input), /wiki_write_failed/); }
  finally { fs.linkSync = original; }
  assert.deepEqual(h.bytes(), bytes);
  h.store.linkPendingPattern(input);
  assert.throws(() => h.store.linkPendingPattern({ ...input, entryId: 'entry-2', expectedRevision: h.store.read().revision }), /wiki_pending_pattern_link_frozen/);
  const stale = h.input('new-2', { entryId: null }), b = labelGroup(h, ['new-3'], 'B');
  h.store.linkPendingPattern({ pendingPatternId: b, entryId: 'entry-1', expectedRevision: h.store.read().revision });
  assert.throws(() => h.store.confirmPatternLabel({ ...stale, expectedRevision: h.store.read().revision }), /wiki_pattern_label_stale/);
});

test('existing induction/review learns only training members; approval never auto-links pending holdouts', t => {
  const h = setup(t), a = labelGroup(h, ['new-1', 'new-2', 'new-3', 'new-4'], 'Checks first'); allocate(h, a);
  const before = h.store.read(), trained = before.cases.filter(c => c.id.startsWith('new-') && c.split === 'train').map(c => c.id);
  assert.equal(trained.length, 2);
  const selections = suiteSelections(before, a), proposal = { title: 'Check tool constraints', failureMode: 'Calls without checking constraints',
    symptoms: 'Tool rejects parameters', rootCauseHypothesis: 'Skipped constraint validation', guideline: 'Check constraints before calling.', caseIds: trained };
  const result = h.store.recordInduction({ caseIds: trained, model: 'deepseek/deepseek-v4-flash', proof: { inputHash: hash('synthetic induction'), calls: [], cleaned: true },
    results: trained.map(caseId => ({ caseId, kind: 'new', reason: 'New pattern', confidence: 'high', proposal })) }, before.revision);
  const created = result.version.entries.at(-1); assert.equal(created.status, 'draft'); assert.deepEqual(created.caseIds, trained);
  assert.throws(() => h.store.linkPendingPattern({ pendingPatternId: a, entryId: created.id, expectedRevision: h.store.read().revision }), /wiki_entry_not_found/);
  h.store.review({ versionId: result.version.id, entryId: created.id, decision: 'approved', expectedRevision: h.store.read().revision });
  const reviewed = h.store.read(); assert.equal(reviewed.pendingPatternLinks, undefined);
  assert.ok(labels(reviewed).filter(r => r.pendingPatternId === a).every(r => r.entryId === null));
  assert.deepEqual(suite(reviewed, selections, created.id).targetReproductionCaseIds, []);
  h.store.linkPendingPattern({ pendingPatternId: a, entryId: created.id, expectedRevision: reviewed.revision });
  const linked = h.store.read(), projected = suite(linked, selections, created.id);
  assert.equal(projected.targetReproductionCaseIds.length, 1); assert.equal(projected.targetTestReproductionCaseIds.length, 1);
  assert.equal(JSON.stringify(linked.versions), JSON.stringify(reviewed.versions));
  assert.deepEqual(linked.versions.at(-1).entries.at(-1).caseIds, trained, 'holdouts never become learned members');
  assert.equal(JSON.stringify(linked.cases), JSON.stringify(before.cases));
  assert.equal(JSON.stringify(linked.initialSplitConfirmations), JSON.stringify(before.initialSplitConfirmations));
});

test('association makes the synthetic new-pattern suite pass the actual experiment target/control guards', t => {
  const h = setup(t), a = labelGroup(h, ['new-1', 'new-2', 'new-3', 'new-4'], 'Check constraints'); allocate(h, a);
  const { createWikiRubric, wikiValueHash } = require(base + 'wiki-rubric');
  const { createWikiExperimentPlan } = require(base + 'wiki-experiment-plan');
  const before = h.store.read(), selections = suiteSelections(before, a);
  const judge = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: wikiValueHash('synthetic-judge') };
  const judges = require('../helpers/wiki-judge-catalog.cjs')(h.root, [{ configuration: judge, prompt: 'synthetic-judge' }]);
  const previous = process.env.CAFF_WIKISKILL_JUDGES_CONFIG; process.env.CAFF_WIKISKILL_JUDGES_CONFIG = judges.configFile;
  t.after(() => { if (previous === undefined) delete process.env.CAFF_WIKISKILL_JUDGES_CONFIG; else process.env.CAFF_WIKISKILL_JUDGES_CONFIG = previous; });
  const catalog = selections.map(s => before.cases.find(c => c.id === s.sourceCaseId)).map(c => ({ id: c.id, sceneHash: hash(['scene', c.id]),
    task: 'Synthetic task', actual: c.actual, expected: c.expected, hardAssertions: { kind: 'synthetic-check' },
    rubric: { ...createWikiRubric({ caseId: c.id, version: 1, actual: c.actual, expected: c.expected, model: judge.model,
      scoringModel: { backend: judge.backend, model: judge.model }, questions: [{ id: 'q1', question: 'Checks constraints first', evidence: 'reply' }] }),
      status: 'frozen', confirmedAt: '2026-11-08T00:00:00.000Z', confirmationRecord: 'Synthetic confirmation' } }));
  const definition = state => ({ kind: 'wiki-experiment-v1', variants: [{ id: 'original', promptHash: hash('original') }, { id: 'candidate', promptHash: hash('candidate') }],
    runner: { model: 'openai-codex/gpt-6.1-sol', settings: { thinking: 'xhigh' } }, repeats: 10, executionPolicy: 'alternating-valid-v1',
    decision: { kind: 'wikiskill-gate-v1', alpha: .05, noHarmFraction: .05, minimumAllowedLoss: 1, maxExtraAttemptsPerCase: 5 }, judge,
    cases: suite(state, selections, 'entry-1').cases.map(c => ({ caseId: c.sourceCaseId, stage: c.stage, category: c.category, targetReproduction: c.targetReproduction })) });
  assert.throws(() => createWikiExperimentPlan(definition(before), catalog), /wiki_experiment_invalid/);
  h.store.linkPendingPattern({ pendingPatternId: a, entryId: 'entry-1', expectedRevision: before.revision });
  const plan = createWikiExperimentPlan(definition(h.store.read()), catalog);
  assert.equal(plan.cases.filter(c => c.targetReproduction).length, 2); assert.equal(plan.cases.filter(c => c.category === 'control').length, 1);
});
