#!/usr/bin/env node
// Deterministic local preparation; never reads a Key, calls a model or edits a
// production role. Generation is distinct from the user's later UI confirmation.
const fs = require('node:fs'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { prepareSealedDirectTurn } = require('./sealed-direct-input.cjs');
const { collectWikiCandidateFiles: collectGlobalCandidateFiles } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate-files');
const fail = code => Object.assign(Error(code), { code });
function createCandidate(config, options = {}) {
  if (config?.globalRoot !== undefined) {
    if (Object.keys(config).some(k => !['globalRoot', 'sourceWorktree', 'versionId', 'entryIds', 'targetId'].includes(k))) throw fail('wiki_candidate_invalid');
    const store = createWikiStore({ globalRoot: config.globalRoot, sourceWorktree: config.sourceWorktree });
    return store.createGlobalCandidate({ versionId: config.versionId, entryIds: config.entryIds, targetId: config.targetId,
      files: collectGlobalCandidateFiles(store.read(), config) });
  }
  if (!config || Object.keys(config).some(k => !['captureRoot', 'sourceWorktree', 'projectId', 'versionId', 'entryIds', 'request'].includes(k))
    || config.request?.captureRoot !== config.captureRoot || config.request?.association?.projectId !== config.projectId
    || config.request?.association?.agentId !== 'role-family-gpt') throw fail('wiki_candidate_invalid');
  const store = createWikiStore(config), prepared = (options.prepare || prepareSealedDirectTurn)(config.request);
  if (!prepared.supported) throw fail('wiki_candidate_anchor_unsupported');
  return store.createCandidate({ versionId: config.versionId, entryIds: config.entryIds, baseRole: prepared.originalRole,
    anchor: { caseId: prepared.provenance.caseId, checkpointId: prepared.provenance.checkpointId,
      originalRoleHash: prepared.provenance.originalRoleHash }, files: prepared.input.files });
}
function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--targets') {
    process.stdout.write(JSON.stringify(require('../../build/server/domain/runtime/badcase-capture/wiki-targets').listWikiTargets()) + '\n');
    return;
  }
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed') throw fail('wiki_candidate_usage');
  let config;
  try {
    if (!fs.lstatSync(args[1]).isFile() || fs.statSync(args[1]).size > 1024 * 1024) throw Error();
    config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  } catch { throw fail('wiki_config_invalid'); }
  const candidate = createCandidate(config);
  process.stdout.write(JSON.stringify({ id: candidate.id, status: candidate.status,
    ...(candidate.kind === 'global-wiki-candidate-v1' ? { kind: candidate.kind, targetId: candidate.targetId, candidateHash: candidate.candidateHash }
      : { candidateRoleHash: candidate.candidateRoleHash }), diff: candidate.diff }) + '\n');
}
if (require.main === module) {
  try { main(); } catch (e) {
    process.stderr.write(JSON.stringify({ error: /^wiki_[a-z_]+$/.test(e.code || '') ? e.code : 'wiki_candidate_failed' }) + '\n'); process.exitCode = 1;
  }
}
module.exports = { createCandidate, collectGlobalCandidateFiles, main };
