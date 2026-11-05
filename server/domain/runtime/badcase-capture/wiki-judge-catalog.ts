// Read-only, operator-owned eligibility attestations. HTTP can select a model,
// never submit a calibration result, configuration, path or eligibility flag.
// Hashes detect drift; they are not authentication against the same OS user.
import fs from 'node:fs';
import path from 'node:path';
import { validateWikiScoringModel, wikiExactKeys, wikiRubricText, wikiValueHash, type WikiScoringModel } from './wiki-rubric';
export interface WikiEligibleJudge extends WikiScoringModel { configurationHash: string; freezeHash: string; promptHash: string }
const invalid = () => Object.assign(Error('wiki_judge_catalog_invalid'), { code: 'wiki_judge_catalog_invalid' });
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function readJson(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw invalid();
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw invalid();
  wikiRubricText(text, 128 * 1024);
  return JSON.parse(text);
}
export function readWikiEligibleJudges(configFile?: string): WikiEligibleJudge[] {
  if (configFile === undefined) return [];
  try {
    if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) throw invalid();
    const manifest = readJson(configFile);
    wikiExactKeys(manifest, ['kind', 'judges', 'unavailable']);
    if (manifest.kind !== 'wiki-eligible-judges-v1' || !Array.isArray(manifest.judges) || manifest.judges.length > 16
      || !Array.isArray(manifest.unavailable) || manifest.unavailable.length > 16) throw invalid();
    const seen = new Set();
    return manifest.judges.map((entry: any) => {
      wikiExactKeys(entry, ['backend', 'model', 'configurationHash', 'freezeHash', 'freezeFile']);
      const identity = validateWikiScoringModel({ backend: entry.backend, model: entry.model });
      if (!hash(entry.configurationHash) || !hash(entry.freezeHash) || typeof entry.freezeFile !== 'string'
        || !/^[A-Za-z0-9_-]+\.json$/.test(entry.freezeFile) || seen.has(entry.backend)
        || manifest.unavailable.some((v: any) => v?.backend === entry.backend)) throw invalid();
      seen.add(entry.backend);
      const frozen = readJson(path.join(path.dirname(configFile), entry.freezeFile));
      wikiExactKeys(frozen, ['kind', 'configuration', 'prompt', 'calibration', 'observedModels', 'eligibility', 'limits', 'hash', 'configurationHash', 'frozenAt']);
      const { hash: freezeHash, configurationHash, frozenAt, ...content } = frozen;
      wikiExactKeys(frozen.configuration, ['backend', 'model', 'settings', 'promptHash']);
      if (frozen.kind !== 'wiki-calibrated-judge-v1' || frozen.eligibility?.passed !== true
        || frozen.configuration.backend !== identity.backend || frozen.configuration.model !== identity.model
        || !hash(frozen.configuration.promptHash) || !frozen.configuration.settings || Array.isArray(frozen.configuration.settings)
        || typeof frozen.configuration.settings !== 'object' || typeof frozen.prompt !== 'string'
        || !frozen.calibration || typeof frozen.calibration.approval !== 'string' || !frozen.calibration.approval.trim()
        || !['datasetHash', 'summarySha256', 'callsSha256', 'resultsSha256'].every(key => hash(frozen.calibration[key]))
        || typeof frozenAt !== 'string' || !Number.isFinite(Date.parse(frozenAt))
        || configurationHash !== entry.configurationHash || wikiValueHash(frozen.configuration) !== configurationHash
        || freezeHash !== entry.freezeHash || wikiValueHash(content) !== freezeHash
        || wikiValueHash(frozen.prompt) !== frozen.configuration.promptHash) throw invalid();
      return { ...identity, configurationHash, freezeHash, promptHash: frozen.configuration.promptHash };
    });
  } catch { throw invalid(); }
}
export function assertWikiEligibleModel(value: WikiScoringModel | null | undefined, judges: WikiEligibleJudge[]) {
  if (!value || !judges.some(j => j.backend === value.backend && j.model === value.model)) {
    throw Object.assign(Error('wiki_judge_not_eligible'), { code: 'wiki_judge_not_eligible' });
  }
  validateWikiScoringModel(value);
}
