#!/usr/bin/env node
// Trusted local backfill/recovery only. Validates the full result against an
// existing immutable comparison before publishing fixed-metric experience.
// Does not execute a replay, authenticate a model or expose raw result text.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { projectStagedResult } = require(base + 'wiki-staged-result');
const { wikiComparisonTotals } = require(base + 'wiki-comparison-totals');
const { readWikiComparisonRecord } = require(base + 'wiki-comparison-record');
const { extractWikiLiteralObservations } = require(base + 'wiki-experience');
const fail = code => Object.assign(Error(code), { code });
function readJson(file, maxBytes) {
  if (!path.isAbsolute(file || '')) throw fail('wiki_experience_config_invalid');
  const stat = fs.statSync(file); if (!stat.isFile() || stat.size > maxBytes) throw fail('wiki_experience_config_invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function main(args = process.argv.slice(2)) {
  if (args.length !== 9 || args[0] !== '--config' || args[2] !== '--comparison' || !/^comparison-[a-f0-9]{64}$/.test(args[3])
    || args[4] !== '--result' || args[6] !== '--confirmed' || args[7] !== '--expected-revision' || !/^\d+$/.test(args[8])) throw fail('wiki_experience_usage');
  const config = readJson(args[1], 65536);
  if (!config || Object.keys(config).sort().join(',') !== 'globalRoot,sourceWorktree') throw fail('wiki_experience_config_invalid');
  const store = createWikiStore(config), revision = Number(args[8]);
  if (!Number.isSafeInteger(revision) || store.read().revision !== revision) throw fail('wiki_revision_conflict');
  const raw = readJson(args[5], 128 * 1024 * 1024), payload = projectStagedResult(raw, wikiComparisonTotals);
  const comparisonId = 'comparison-' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (comparisonId !== args[3] || !(payload.evaluation?.splitPolicy === 'd15-frozen-v1' || payload.kind === 'wiki-mode-holdout-comparison-v2')) throw fail('wiki_experience_result_mismatch');
  const scope = require(base + 'wiki-data-directory').resolveWikiStorageOptions(config);
  readWikiComparisonRecord(scope.globalRoot, comparisonId, value => projectStagedResult(value, wikiComparisonTotals));
  const draft = store.recordComparisonExperience({ comparisonId, observations: extractWikiLiteralObservations(raw), expectedRevision: revision });
  const summary = { comparisonId, experienceId: draft.id, version: draft.version, status: draft.status, revision: store.read().revision, modelCalls: 0 };
  process.stdout.write(JSON.stringify(summary) + '\n'); return summary;
}
if (require.main === module) { try { main(); } catch (e) {
  process.stderr.write(JSON.stringify({ error: /^wiki_[a-z_]+$/.test(e.code || '') ? e.code : 'wiki_experience_failed' }) + '\n'); process.exitCode = 1;
} }
module.exports = { main };
