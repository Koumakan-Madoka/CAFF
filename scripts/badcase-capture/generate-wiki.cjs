#!/usr/bin/env node
// Operator entry. All model traffic/key use stays inside runDirectDockerTask;
// only approved local training selections are sent. No production API writes.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const { runDirectDockerTask } = require('./direct-docker.cjs');
const { readCaffDeepseekKey, DEEPSEEK_PROFILE } = require('./direct-model.cjs');
const fail = code => Object.assign(Error(code), { code });
function prepareWikiGeneration(store, caseIds) {
  if (!Array.isArray(caseIds) || !caseIds.length || caseIds.length > 20 || new Set(caseIds).size !== caseIds.length
    || caseIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw fail('wiki_invalid_case_ids');
  const state = store.read();
  const cases = caseIds.map(id => state.cases.find(c => c.id === id && c.split === 'train' && c.role === 'GPT'));
  if (cases.some(c => !c)) throw fail('wiki_unknown_training_case');
  // Explicit projection: never send test-set, prompt, credentials or arbitrary
  // collection metadata along with the requested training examples.
  const input = { cases: cases.map(c => ({ id: c.id, actual: c.actual, expected: c.expected, message: c.message,
    traceExcerpt: c.traceExcerpt, messageTruncated: c.messageTruncated, traceTruncated: c.traceTruncated, traceState: c.traceState })) };
  const bytes = Buffer.from(JSON.stringify(input));
  if (bytes.length > 1024 * 1024) throw fail('wiki_training_input_too_large');
  if (containsSecretSentinel(bytes.toString())) throw fail('wiki_contains_secret');
  return { caseIds: [...caseIds], inputHash: crypto.createHash('sha256').update(bytes).digest('hex'), files: [
    { path: 'wiki-input.json', bytes },
    { path: 'probe.cjs', bytes: fs.readFileSync(path.join(__dirname, 'wiki-model-container.cjs')) },
  ] };
}
async function generateWiki({ store, caseIds, image, confirmed }, options = {}) {
  if (confirmed !== true) throw fail('wiki_confirmation_required');
  const plan = prepareWikiGeneration(store, caseIds);
  // No caller-selected endpoint/model/credential source. D4 official DeepSeek
  // binding is validated by the same read-only helper used for S3.
  const key = (options.readKey || readCaffDeepseekKey)();
  const result = await (options.execute || runDirectDockerTask)(image, plan.files, { key, timeoutMs: 120000 });
  const serialized = JSON.stringify(result);
  if (serialized.includes(key) || serialized.includes(JSON.stringify(key).slice(1, -1)) || containsSecretSentinel(serialized)) throw fail('wiki_contains_secret');
  const proof = { type: 'wiki-generation', model: DEEPSEEK_PROFILE, inputHash: plan.inputHash, caseIds: plan.caseIds,
    containerId: result.containerId, cleaned: result.cleaned, isolation: result.isolation,
    inputDistributionHash: result.inputHash, calls: result.receipt?.calls ?? null };
  // Preserve the known call record even when model output fails validation;
  // missing infrastructure evidence is unknown, never fabricated as zero calls.
  options.onEvent?.(proof);
  if (result.failed || result.cleaned !== true || result.receipt?.ok !== true) throw fail('wiki_generation_failed');
  const draft = result.receipt.draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).sort().join(',') !== 'entries,unclassified') throw fail('wiki_model_output_invalid');
  // Store validation enforces exact fields, draft-only state, coverage and
  // training membership; invalid output publishes no partial version.
  const version = store.saveDraft({ caseIds: plan.caseIds, model: DEEPSEEK_PROFILE, entries: draft.entries, unclassified: draft.unclassified });
  options.onEvent?.({ type: 'wiki-draft-saved', versionId: version.id, revision: store.read().revision });
  return version;
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 5 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed'
    || args[3] !== '--output' || !path.isAbsolute(args[4])) throw fail('wiki_generation_usage');
  let config;
  try {
    if (!fs.lstatSync(args[1]).isFile() || fs.statSync(args[1]).size > 1024 * 1024) throw Error();
    config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (!config || Object.keys(config).some(k => !['captureRoot', 'sourceWorktree', 'projectId', 'caseIds', 'image'].includes(k))) throw Error();
  } catch { throw fail('wiki_config_invalid'); }
  const store = createWikiStore(config);
  prepareWikiGeneration(store, config.caseIds); // Before output/key/model access.
  const fd = fs.openSync(args[4], 'wx', 0o600);
  try {
    const version = await generateWiki({ store, caseIds: config.caseIds, image: config.image, confirmed: true }, {
      onEvent: row => { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); },
    });
    process.stdout.write(JSON.stringify({ versionId: version.id, status: 'draft', entries: version.entries.length, unclassified: version.unclassified.length }) + '\n');
  } finally { fs.closeSync(fd); }
}
if (require.main === module) main().catch(e => {
  const code = /^wiki_[a-z_]+$/.test(e.code || '') || e.code === 'capture_writer_busy' ? e.code : 'wiki_generation_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { prepareWikiGeneration, generateWiki, main };
