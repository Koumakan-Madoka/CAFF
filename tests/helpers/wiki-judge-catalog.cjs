// Synthetic, operator-owned eligibility attestation. No real calibration/key.
const fs = require('node:fs'), path = require('node:path');
const { wikiValueHash } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
module.exports = function judgeCatalog(root) {
  const configuration = { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: wikiValueHash('Synthetic judge prompt') };
  const content = { kind: 'wiki-calibrated-judge-v1', configuration, prompt: 'Synthetic judge prompt',
    calibration: { approval: 'synthetic-test-only', datasetHash: 'a'.repeat(64), summarySha256: 'b'.repeat(64), callsSha256: 'c'.repeat(64), resultsSha256: 'd'.repeat(64) },
    observedModels: ['deepseek-flash'], eligibility: { passed: true, activeCalibrationAssertions: ['q1'], knownBadCases: 3 }, limits: ['synthetic only'] };
  const frozen = { ...content, hash: wikiValueHash(content), configurationHash: wikiValueHash(configuration), frozenAt: '2026-11-05T00:00:00.000Z' };
  const manifest = { kind: 'wiki-eligible-judges-v1', judges: [{ backend: configuration.backend, model: configuration.model, configurationHash: frozen.configurationHash, freezeHash: frozen.hash, freezeFile: 'judge.json' }], unavailable: [{ backend: 'jev', reason: 'unavailable' }] };
  const configFile = path.join(root, 'judges.json'), freezeFile = path.join(root, 'judge.json');
  const save = () => { fs.writeFileSync(configFile, JSON.stringify(manifest)); fs.writeFileSync(freezeFile, JSON.stringify(frozen)); };
  save(); return { configFile, freezeFile, manifest, frozen, save, configuration };
};
