// Current-evidence admission for NEW experiments. Historical plan/result reads
// validate the compact proof only; they never acquire new eligibility or mutate
// stored bytes. Host orchestration must rebuild this proof before each send.
import { planWikiEvaluationSuite } from './wiki-evaluation-suite';
import { projectWikiGateControls } from './wiki-gate-control';
import { projectWikiOriginalPrechecks } from './wiki-original-precheck-projection';
import { validateWikiRubric, wikiExactKeys, wikiValueHash } from './wiki-rubric';
import type { WikiExperimentCase, WikiExperimentDefinition, WikiExperimentPlan } from './wiki-experiment-plan';
const fail = (code = 'wiki_experiment_admission_invalid') => Object.assign(Error(code), { code });
function ensure(value: unknown, code?: string): asserts value { if (!value) throw fail(code); }
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export interface WikiExperimentAdmission {
  kind: 'wiki-experiment-admission-v1'; targetEntryId: string;
  cases: { caseId: string; caseHash: string; rubricHash: string; precheckId: string; precheckPlanHash: string; precheckResultHash: string; controlHash: string | null }[];
  hash: string;
}
// Self-contained integrity/association validation, not a claim of authenticity
// against a hostile same-user host. Current qualification uses the factory below.
export function validateWikiExperimentAdmission(value: WikiExperimentAdmission, cases: Pick<WikiExperimentPlan['cases'][number], 'caseId' | 'rubricHash' | 'stage' | 'category' | 'targetReproduction'>[]): WikiExperimentAdmission {
  wikiExactKeys(value, ['kind', 'targetEntryId', 'cases', 'hash']);
  ensure(value.kind === 'wiki-experiment-admission-v1' && id(value.targetEntryId) && digest(value.hash)
    && Array.isArray(value.cases) && value.cases.length === cases.length && value.cases.length >= 3 && value.cases.length <= 20);
  for (const [n, row] of value.cases.entries()) {
    wikiExactKeys(row, ['caseId', 'caseHash', 'rubricHash', 'precheckId', 'precheckPlanHash', 'precheckResultHash', 'controlHash']);
    const selected = cases[n];
    ensure(id(row.caseId) && row.caseId === selected.caseId && row.rubricHash === selected.rubricHash
      && [row.caseHash, row.rubricHash, row.precheckPlanHash, row.precheckResultHash].every(digest)
      && typeof row.precheckId === 'string' && /^precheck-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.precheckId));
    ensure(selected.category === 'control' ? selected.stage === 'gate' && !selected.targetReproduction && digest(row.controlHash) : row.controlHash === null);
  }
  ensure(new Set(value.cases.map(c => c.caseId)).size === value.cases.length
    && cases.some(c => c.stage === 'gate' && c.category === 'control'));
  const { hash, ...payload } = value; ensure(hash === wikiValueHash(payload));
  return structuredClone(value);
}
export function createWikiExperimentAdmission(input: {
  state: any; records: any[]; replayChecks: any[]; targetEntryId: string; definition: Pick<WikiExperimentDefinition, 'cases'>;
  catalog: Pick<WikiExperimentCase, 'id' | 'actual' | 'expected' | 'rubric' | 'execution'>[];
}): WikiExperimentAdmission {
  wikiExactKeys(input, ['state', 'records', 'replayChecks', 'targetEntryId', 'definition', 'catalog']);
  const { state, records, replayChecks, targetEntryId, definition, catalog } = input;
  ensure(id(targetEntryId) && Array.isArray(definition?.cases) && Array.isArray(catalog));
  const suite = planWikiEvaluationSuite(state, definition.cases.map(c => ({ sourceCaseId: c.caseId, category: c.category })), targetEntryId);
  const prechecks = projectWikiOriginalPrechecks(state, records, replayChecks), controls = projectWikiGateControls(state, records, replayChecks, prechecks);
  const cases = definition.cases.map(selection => {
    const selected = suite.cases.find((c: any) => c.sourceCaseId === selection.caseId), source = state.cases.find((c: any) => c.id === selection.caseId);
    ensure(selected && !selected.reportOnly && source && source.split === selection.stage && selected.stage === selection.stage
      && selected.targetReproduction === selection.targetReproduction, 'wiki_experiment_partition_changed');
    const entry = catalog.find(c => c.id === selection.caseId); ensure(entry, 'wiki_experiment_precheck_changed');
    const rubric = validateWikiRubric(entry.rubric, true);
    const precheck = prechecks.find((p: any) => p.caseId === selection.caseId), current = precheck?.current;
    ensure(current, selection.category === 'control' ? 'wiki_experiment_control_required' : 'wiki_experiment_precheck_required');
    ensure(rubric.caseId === source.id && current?.rubricHash === rubric.hash && entry.actual === source.actual && entry.expected === source.expected,
      'wiki_experiment_precheck_changed');
    const measured = records.find(r => r.reservation.id === current.id);
    ensure(measured?.result && current.status === 'completed', selection.category === 'control' ? 'wiki_experiment_control_required' : 'wiki_experiment_precheck_required');
    const execution = measured.reservation.plan.execution;
    ensure((entry.execution?.level ?? 'trace') === execution.level && (execution.level !== 'run' || entry.execution?.level === 'run'
      && entry.execution.traceBundleHash === execution.traceHash && entry.execution.dehydrationHash === execution.decisionHash), 'wiki_experiment_precheck_changed');
    let controlHash = null;
    if (selection.category === 'control') {
      const control = controls.find((c: any) => c.caseId === selection.caseId);
      ensure(selection.stage === 'gate' && source.split === 'gate' && control?.confirmed, 'wiki_experiment_control_required');
      ensure(control.binding.pattern.entryId !== targetEntryId, 'wiki_experiment_control_target_mode');
      ensure(control.binding.rubricHash === rubric.hash && control.binding.precheckId === current.id, 'wiki_experiment_precheck_changed');
      controlHash = control.confirmation.hash;
    } else ensure(precheck?.reproduced, 'wiki_experiment_precheck_required');
    return { caseId: source.id, caseHash: wikiValueHash(source), rubricHash: rubric.hash, precheckId: current.id,
      precheckPlanHash: current.planHash, precheckResultHash: wikiValueHash(measured.result), controlHash };
  });
  ensure(definition.cases.some(c => c.stage === 'gate' && c.category === 'control'), 'wiki_experiment_control_required');
  const payload = { kind: 'wiki-experiment-admission-v1' as const, targetEntryId, cases };
  // Plan creation subsequently validates the full definition/catalog; proof
  // association is also checked here, without binding a judge or invoking IO.
  return validateWikiExperimentAdmission({ ...payload, hash: wikiValueHash(payload) }, definition.cases.map(c => ({ ...c,
    rubricHash: catalog.find(r => r.id === c.caseId)!.rubric.hash })));
}
