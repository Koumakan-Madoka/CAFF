// Synthetic, operator-owned eligibility attestation. No real calibration/key.
const fs = require('node:fs'), path = require('node:path');
const { wikiValueHash } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
module.exports = function judgeCatalog(root, definitions = [{
  configuration: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', settings: { temperature: 0 }, promptHash: wikiValueHash('Synthetic judge prompt') }, prompt: 'Synthetic judge prompt',
}]) {
  const records = definitions.map(({ configuration, prompt }, i) => {
    configuration = structuredClone(configuration);
    const content = { kind: 'wiki-calibrated-judge-v1', configuration, prompt,
      calibration: { approval: 'synthetic-test-only', datasetHash: 'a'.repeat(64), summarySha256: 'b'.repeat(64), callsSha256: 'c'.repeat(64), resultsSha256: 'd'.repeat(64) },
      observedModels: [configuration.model], eligibility: { passed: true, activeCalibrationAssertions: ['q1'], knownBadCases: 3 }, limits: ['synthetic only'] };
    const frozen = { ...content, hash: wikiValueHash(content), configurationHash: wikiValueHash(configuration), frozenAt: '2026-11-05T00:00:00.000Z' };
    return { configuration, frozen, freezeFile: path.join(root, i === 0 ? 'judge.json' : 'judge-' + i + '.json') };
  });
  const manifest = { kind: 'wiki-eligible-judges-v1', judges: records.map(({ configuration, frozen, freezeFile }) => ({ backend: configuration.backend, model: configuration.model,
    configurationHash: frozen.configurationHash, freezeHash: frozen.hash, freezeFile: path.basename(freezeFile) })), unavailable: records.some(r => r.configuration.backend === 'jev') ? [] : [{ backend: 'jev', reason: 'unavailable' }] };
  const configFile = path.join(root, 'judges.json');
  const save = () => { fs.writeFileSync(configFile, JSON.stringify(manifest)); for (const r of records) fs.writeFileSync(r.freezeFile, JSON.stringify(r.frozen)); };
  save(); return { configFile, manifest, ...records[0], records, save };
};
