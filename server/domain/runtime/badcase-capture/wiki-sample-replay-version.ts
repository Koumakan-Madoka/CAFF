// Only approved representative control fixtures may acquire a new model input
// version. This never relabels a historical captured turn or changes its seal.
import crypto from 'node:crypto';
import { wikiGoalCaseNumber } from './wiki-suite';
import { validateSealRequest } from './sealed-case';
const fail = () => Object.assign(Error('wiki_sample_version_invalid'), { code: 'wiki_sample_version_invalid' });
function check(v: any): asserts v { if (!v) throw fail(); }
const hash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
export const SAMPLE_MODEL_CONFIG = Object.freeze({ provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh', fast: false });
export function buildSampleReplayVersion(state: any, input: any) {
  check(input && Object.keys(input).sort().join(',') === 'checkpointHash,parentReplayId,request,sourceCaseId,sourceModelConfig,unchangedInputHash');
  const source = state.cases.find((c: any) => c.id === input.sourceCaseId), parent = state.replayCases.find((r: any) => r.id === input.parentReplayId && r.sourceCaseId === input.sourceCaseId);
  check(source?.kind === 'text-only' && [10, 14, 16].includes(wikiGoalCaseNumber(source.id)!) && parent?.category === 'control' && parent.split === source.split);
  const parentContent = Object.fromEntries(['sourceCaseId', 'category', 'task', 'fixture', 'request', 'rules', 'checkpointHash'].map(k => [k, parent[k]]));
  check(parent.contentHash === hash(parentContent) && parent.id === 'replay-' + parent.contentHash);
  check([input.checkpointHash, input.unchangedInputHash].every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)));
  check(input.sourceModelConfig && Object.keys(input.sourceModelConfig).sort().join(',') === 'fast,model,provider,thinking');
  check(input.sourceModelConfig.provider === 'deepseek' && input.sourceModelConfig.model === 'deepseek-v4-flash' && input.sourceModelConfig.thinking === 'off' && input.sourceModelConfig.fast === false);
  const request = validateSealRequest(input.request);
  check(request.captureRoot !== parent.request.captureRoot && request.association.agentId === 'role-family-gpt');
  check(request.association.checkpointId !== parent.request.association.checkpointId && input.checkpointHash !== parent.checkpointHash);
  const content = { kind: 'sample-model-replay-version-v1', historicalReproduction: false, parentReplayId: parent.id, parentContentHash: parent.contentHash,
    sourceCaseId: source.id, category: parent.category, split: parent.split, task: parent.task, fixture: structuredClone(parent.fixture), rules: structuredClone(parent.rules),
    request, checkpointHash: input.checkpointHash, unchangedInputHash: input.unchangedInputHash, sourceModelConfig: structuredClone(input.sourceModelConfig),
    targetModelConfig: { ...SAMPLE_MODEL_CONFIG }, modelProfile: 'openai-codex/gpt-6.1-sol' };
  return { id: 'replay-version-' + hash(content), ...content, contentHash: hash(content) };
}
export function resolveSampleReplayVersion(state: any, sourceCaseId: string, versionId: string) {
  const saved = (state.replayVersions || []).find((v: any) => v.id === versionId && v.sourceCaseId === sourceCaseId); check(saved);
  const rebuilt = buildSampleReplayVersion(state, Object.fromEntries(['sourceCaseId', 'parentReplayId', 'request', 'checkpointHash', 'sourceModelConfig', 'unchangedInputHash'].map(k => [k, saved[k]])));
  const { createdAt, ...content } = saved; check(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt)) && same(rebuilt, content));
  return saved;
}
