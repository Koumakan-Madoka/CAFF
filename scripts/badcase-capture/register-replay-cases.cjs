// Explicit operator bridge from approved representative tasks to real sealed
// pre-turn inputs. Never upgrades a historical text-only source into a snapshot,
// invokes a model, regenerates wiki, changes the frozen split or approves it.
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { resolveWikiReplayRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-replay-location');
const { prepareSealedDirectTurn } = require('./sealed-direct-input.cjs');
const { validateRules } = require('./direct-comparison.cjs');
const fail = code => Object.assign(Error(code), { code });
function registerReplayCases(config, confirmed = false, options = {}) {
  if (confirmed !== true) throw fail('wiki_confirmation_required');
  if (!config || Object.keys(config).some(k => !['globalRoot', 'sourceWorktree', 'cases'].includes(k))
    || !Array.isArray(config.cases) || !config.cases.length || config.cases.length > 20) throw fail('wiki_invalid_input');
  const store = createWikiStore({ globalRoot: config.globalRoot, sourceWorktree: config.sourceWorktree });
  const prepare = options.prepare || prepareSealedDirectTurn;
  // Whole batch preflight before publication. File/rule/checkpoint material must
  // exist at import; evaluation rechecks it, rather than trusting this label.
  for (const c of config.cases) {
    validateRules(c.rules);
    const prepared = prepare(resolveWikiReplayRequest(config, c.request));
    if (prepared.supported !== true || prepared.provenance.checkpointHash !== c.checkpointHash) throw fail('wiki_replay_materials_unavailable');
  }
  const replayCases = store.addReplayCases(config.cases);
  return { scope: 'global', revision: store.read().revision, replayCases };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--config');
    if (!args.includes('--confirmed')) throw fail('wiki_confirmation_required');
    if (index < 0 || !path.isAbsolute(args[index + 1] || '') || args.length !== 3) throw fail('wiki_invalid_input');
    const result = registerReplayCases(JSON.parse(fs.readFileSync(args[index + 1], 'utf8')), true);
    console.log(JSON.stringify({ scope: result.scope, revision: result.revision, replayCases: result.replayCases.map(c => ({ id: c.id, sourceCaseId: c.sourceCaseId, category: c.category, split: c.split, checkpointHash: c.checkpointHash })) }, null, 2));
  } catch (e) { console.error(e.code || 'wiki_replay_registration_failed'); process.exitCode = 1; }
}
module.exports = { registerReplayCases };
