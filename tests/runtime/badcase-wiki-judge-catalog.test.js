const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readWikiEligibleJudges, assertWikiEligibleConfiguration } = require('../../build/server/domain/runtime/badcase-capture/wiki-judge-catalog');
const fixture = require('../helpers/wiki-judge-catalog.cjs');
function setup(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-judge-catalog-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, ...fixture(root) }; }
test('no catalog means no selectable models; validated projection contains no paths, prompt or settings', t => {
  assert.deepEqual(readWikiEligibleJudges(), []);
  const h = setup(t), models = readWikiEligibleJudges(h.configFile);
  assert.deepEqual(models, [{ backend: 'deepseek', model: h.configuration.model, configurationHash: h.frozen.configurationHash, freezeHash: h.frozen.hash, promptHash: h.configuration.promptHash }]);
  assert.equal(JSON.stringify(models).includes(h.root), false); assert.equal(JSON.stringify(models).includes('Synthetic judge prompt'), false);
});
test('formal judge eligibility requires matching identity, complete configuration hash and prompt hash', t => {
  const h = setup(t), judges = readWikiEligibleJudges(h.configFile);
  assert.doesNotThrow(() => assertWikiEligibleConfiguration(h.configuration, judges));
  for (const changed of [[], [{ ...judges[0], backend: 'jev' }], [{ ...judges[0], model: 'other-model' }],
    [{ ...judges[0], configurationHash: 'f'.repeat(64) }], [{ ...judges[0], promptHash: 'f'.repeat(64) }]]) {
    assert.throws(() => assertWikiEligibleConfiguration(h.configuration, changed), { code: 'wiki_judge_not_eligible' });
  }
  for (const configuration of [{ ...h.configuration, settings: { temperature: 1 } }, { ...h.configuration, promptHash: 'f'.repeat(64) }]) {
    assert.throws(() => assertWikiEligibleConfiguration(configuration, judges), { code: 'wiki_judge_not_eligible' });
  }
  // Object property order alone is not drift: use wikiValueHash, not raw JSON.
  const { settings, promptHash, model, backend } = h.configuration;
  assert.doesNotThrow(() => assertWikiEligibleConfiguration({ promptHash, settings, model, backend }, judges));
});
test('catalog rejects modified hashes, ineligible records, unknown keys and path traversal', t => {
  const h = setup(t);
  for (const change of [() => h.frozen.configuration.settings.temperature = 1, () => h.frozen.eligibility.passed = false,
    () => h.frozen.prompt = 'modified', () => h.manifest.judges[0].freezeFile = '../judge.json',
    () => h.manifest.judges[0].freezeHash = 'f'.repeat(64), () => h.manifest.judges.push(h.manifest.judges[0]), () => h.manifest.globalRoot = h.root]) {
    change(); h.save();
    assert.throws(() => readWikiEligibleJudges(h.configFile), { code: 'wiki_judge_catalog_invalid' });
    Object.assign(h, fixture(h.root));
  }
  for (const file of ['relative.json', path.join(h.root, 'absent.json')]) assert.throws(() => readWikiEligibleJudges(file), { code: 'wiki_judge_catalog_invalid' });
});
