#!/usr/bin/env node
// Preclassification uses all unallocated marks and approved patterns only.
// Subsequent induction sees pending training cases only; never gate/test.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const { runDirectDockerTask } = require('./direct-docker.cjs');
const { readCaffDeepseekKey, DEEPSEEK_PROFILE } = require('./direct-model.cjs');
const fail = code => Object.assign(Error(code), { code });
function prepareWikiInduction(store) {
  const state = store.read(), states = store.getCaseStates();
  const phase = states.some(s => s.status === 'pending-preclassification') ? 'preclassification' : 'induction';
  const pending = states.filter(s => s.status === (phase === 'preclassification' ? 'pending-preclassification' : 'pending')).map(s => s.caseId);
  if (!pending.length) throw fail('wiki_no_pending_cases');
  if (pending.length > 20) throw fail('wiki_collection_too_large');
  const cases = pending.map(id => state.cases.find(c => c.id === id && (phase === 'preclassification' ? c.split === null : c.split === 'train')));
  if (cases.some(c => !c)) throw fail('wiki_unknown_training_case');
  const version = state.versions.at(-1);
  const approvedEntries = (version?.entries || []).filter(e => e.status === 'approved').map(e => ({
    id: e.id, title: e.title, failureMode: e.failureMode, symptoms: e.symptoms, rootCauseHypothesis: e.rootCauseHypothesis, guideline: e.guideline,
  }));
  const input = { phase, cases: cases.map(c => ({ id: c.id, actual: c.actual, expected: c.expected, message: c.message,
    traceExcerpt: c.traceExcerpt, messageTruncated: c.messageTruncated, traceTruncated: c.traceTruncated, traceState: c.traceState })), approvedEntries };
  const bytes = Buffer.from(JSON.stringify(input));
  if (bytes.length > 1024 * 1024) throw fail('wiki_training_input_too_large');
  if (containsSecretSentinel(bytes.toString())) throw fail('wiki_contains_secret');
  return { phase, caseIds: pending, inputHash: crypto.createHash('sha256').update(bytes).digest('hex'), files: [
    { path: 'wiki-induction-input.json', bytes },
    { path: 'probe.cjs', bytes: fs.readFileSync(path.join(__dirname, 'wiki-induction-container.cjs')) },
  ] };
}
async function inductWikiCases({ store, image, confirmed, expectedRevision, dockerBackend }, options = {}) {
  if (confirmed !== true) throw fail('wiki_confirmation_required');
  if (!Number.isSafeInteger(expectedRevision) || store.read().revision !== expectedRevision) throw fail('wiki_revision_conflict');
  const plan = prepareWikiInduction(store);
  // Explicit backend/host errors precede auth access and any Docker action.
  if (dockerBackend !== undefined) {
    require('./wsl-docker.cjs').validateWslDockerBackend(dockerBackend);
    if (!options.execute && process.platform !== 'win32') throw fail('evaluation_wsl_host_required');
  } else if (!options.execute && process.platform !== 'linux') throw fail('evaluation_linux_required');
  const key = (options.readKey || readCaffDeepseekKey)();
  const execute = options.execute || (dockerBackend === undefined ? runDirectDockerTask : require('./wiki-host-model.cjs').runWikiHostTask);
  const result = await execute(image, plan.files, { key, timeoutMs: 120000, ...(dockerBackend === undefined ? {} : { dockerBackend }) });
  const modelOutput = result.receipt?.modelOutput;
  // Raw output lives in memory until validation completes; never in events,
  // saved proof, returned data or the controller's generic HTTP errors.
  if (result.receipt) delete result.receipt.modelOutput;
  const diagnose = error => {
    try {
      const diagnostic = require('./wiki-diagnostics.cjs');
      (options.writeDiagnostic || (details => diagnostic.writeWikiDiagnostic(details, {
        ...(options.diagnosticDirectory === undefined ? {} : { directory: options.diagnosticDirectory }),
        knownValues: [key, ...(options.readDiagnosticValues || diagnostic.readDiagnosticValues)()],
      })))({ phase: plan.phase, modelOutput, validationIssue: error.validationIssue || { field: 'results', rule: error.code } });
    } catch {
      // Best effort only. Never log a private path/body/error or change the
      // original validation failure. No retry and no successful publication.
      options.onEvent?.({ type: 'wiki-private-diagnostic-unavailable' });
    }
  };
  const serialized = JSON.stringify(result);
  if (serialized.includes(key) || serialized.includes(JSON.stringify(key).slice(1, -1)) || containsSecretSentinel(serialized)) throw fail('wiki_contains_secret');
  const proof = { type: plan.phase === 'preclassification' ? 'wiki-preclassification' : 'wiki-incremental-induction', model: DEEPSEEK_PROFILE, inputHash: plan.inputHash, caseIds: plan.caseIds,
    ...(dockerBackend === undefined ? {} : { dockerBackend }),
    containerId: result.containerId, cleaned: result.cleaned, isolation: result.isolation, calls: result.receipt?.calls ?? null };
  options.onEvent?.(proof);
  let saved;
  try {
    if (result.failed || result.cleaned !== true || result.receipt?.ok !== true || !Array.isArray(result.receipt?.results)) {
      throw Object.assign(fail('wiki_generation_failed'), { validationIssue: result.receipt?.validationIssue });
    }
    options.onModelOutput?.(result.receipt.results);
    if (result.receipt.results.length !== plan.caseIds.length) throw Object.assign(fail('wiki_model_output_invalid'), {
      validationIssue: { field: 'results', rule: 'must_cover_each_input_once' },
    });
    const save = plan.phase === 'preclassification' ? store.recordPreclassification.bind(store) : store.recordInduction.bind(store);
    saved = save({ caseIds: plan.caseIds, model: DEEPSEEK_PROFILE, results: result.receipt.results,
      proof: { inputHash: plan.inputHash, calls: result.receipt.calls ?? [], cleaned: result.cleaned,
        ...(result.containerId === undefined ? {} : { containerId: result.containerId }), ...(result.isolation === undefined ? {} : { isolation: result.isolation }) } }, expectedRevision);
  } catch (error) {
    if (error.validationIssue || ['wiki_model_output_invalid', 'wiki_generation_failed'].includes(error.code)) diagnose(error);
    throw error;
  }
  options.onEvent?.({ type: 'wiki-induction-saved', runId: saved.run.id, revision: store.read().revision, versionId: saved.version?.id || null });
  return saved;
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 5 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed'
    || args[3] !== '--output' || !path.isAbsolute(args[4])) throw fail('wiki_generation_usage');
  let config;
  try {
    if (!fs.lstatSync(args[1]).isFile() || fs.statSync(args[1]).size > 1024 * 1024) throw Error();
    config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (!config || Object.keys(config).some(k => !['globalRoot', 'sourceWorktree', 'image', 'expectedRevision', 'dockerBackend'].includes(k))) throw Error();
  } catch { throw fail('wiki_config_invalid'); }
  const store = createWikiStore(config);
  if (store.read().revision !== config.expectedRevision) throw fail('wiki_revision_conflict');
  prepareWikiInduction(store);
  const fd = fs.openSync(args[4], 'wx', 0o600);
  try {
    const saved = await inductWikiCases({ store, image: config.image, confirmed: true, expectedRevision: config.expectedRevision, dockerBackend: config.dockerBackend }, {
      onEvent: row => { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); },
    });
    process.stdout.write(JSON.stringify({ runId: saved.run.id, suggestions: saved.suggestions.length, versionId: saved.version?.id || null }) + '\n');
  } finally { fs.closeSync(fd); }
}
if (require.main === module) main().catch(e => {
  const code = /^wiki_[a-z_]+$/.test(e.code || '') || e.code === 'capture_writer_busy' ? e.code : 'wiki_generation_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { prepareWikiInduction, inductWikiCases, main };
