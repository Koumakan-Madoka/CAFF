// One model decision, never an agent loop. Historical tool calls are context;
// newly generated calls are recorded as DATA and have no executor here.
import crypto from 'node:crypto';
import { buildDehydrationPrefix } from './wiki-dehydration';
import { redactTraceKnownValues } from './wiki-trace';
import { locateGlobalPromptTarget } from '../../../../lib/agent-prompt-targets';
const fail = (code: string) => Object.assign(Error(code), { code });
export const wikiRunHash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const WIKI_RUN_MODEL = 'openai-codex/gpt-6.1-sol';
function validHash(v: any, n = 64) { return typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v); }
export function buildWikiRunRequest({ item, bundle, decision, toolset, candidate }: any) {
  // Scene-backed runs require real execution to natural turn end (B7).
  // This no-executor implementation must never silently stand in for them.
  if (item?.sealedCheckpointId) throw fail('wiki_run_scene_unsupported');
  const { hash: decisionHash, ...value } = decision || {};
  if (!validHash(decisionHash) || wikiRunHash(value) !== decisionHash || decision.caseId !== item.id
    || decision.traceHash !== item.traceBundle?.hash || decision.kind !== 'single' || decision.level !== 'run') throw fail('wiki_run_decision_invalid');
  const prefix = buildDehydrationPrefix(item, bundle, decision.cutStep);
  if (toolset?.codingAgentVersion !== '0.85.1' || !validHash(toolset.capabilitiesSha, 40) || !validHash(toolset.capabilitiesFileHash)
    || !Array.isArray(toolset.definitions) || !toolset.definitions.length || toolset.definitions.length > 128
    || toolset.definitions.some((t: any) => !t || Object.keys(t).sort().join('|') !== 'description|name|parameters'
      || typeof t.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(t.name) || typeof t.description !== 'string'
      || !t.parameters || typeof t.parameters !== 'object' || Array.isArray(t.parameters))
    || new Set(toolset.definitions.map((t: any) => t.name)).size !== toolset.definitions.length) throw fail('wiki_run_tools_invalid');
  const { definitions, ...versions } = toolset;
  const context = { systemPrompt: prefix.systemPrompt, messages: prefix.messages, tools: structuredClone(definitions) };
  let variant: any = { kind: 'original' };
  if (candidate !== undefined) {
    // Trusted, already approved candidate content. Replace exactly ONE declared
    // global slot, in system OR retained user input, never other history/prose.
    if (!candidate || Object.keys(candidate).sort().join('|') !== 'baseHash|baseText|id|replacement|targetId'
      || typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id)
      || candidate.targetId !== 'global-harness-behavior-v1' || typeof candidate.replacement !== 'string' || !candidate.replacement.trim()
      || Buffer.byteLength(candidate.replacement) > 65536) throw fail('wiki_run_candidate_invalid');
    const slots: any[] = [], scan = (text: any, set: (text: string) => void) => {
      if (typeof text !== 'string' || !text.includes('Rules:\n' + candidate.baseText)) return;
      // A declaration that exists but is ambiguous/invalid must not disappear
      // from the count just because another prefix segment has a valid slot.
      let slot; try { slot = locateGlobalPromptTarget(text, candidate.targetId, [{ baseText: candidate.baseText, baseHash: candidate.baseHash }]); }
      catch { throw fail('wiki_run_candidate_invalid'); }
      slots.push(() => set(text.slice(0, slot.start) + candidate.replacement + text.slice(slot.end)));
    };
    scan(context.systemPrompt, s => context.systemPrompt = s);
    for (const m of context.messages) if (m.role === 'user') {
      if (typeof m.content === 'string') scan(m.content, s => m.content = s);
      else for (const b of m.content || []) if (b.type === 'text') scan(b.text, s => b.text = s);
    }
    if (slots.length !== 1) throw fail('wiki_run_candidate_invalid'); slots[0]();
    variant = { kind: 'candidate', id: candidate.id, targetId: candidate.targetId, baseHash: candidate.baseHash, replacementHash: wikiRunHash(candidate.replacement) };
  }
  return { schemaVersion: 1, kind: 'wikiskill-run-request', model: WIKI_RUN_MODEL, thinking: 'xhigh', variant, context,
    metadata: { ...prefix.metadata, decisionHash, toolset: { ...structuredClone(versions), definitionsHash: wikiRunHash(definitions) },
      policy: { modelCalls: 1, toolExecutions: 0, retries: 0, prefixConsistencyChecked: false } } };
}
function publicMessage(call: any): string | null {
  if (call.name !== 'bash' || typeof call.arguments?.command !== 'string') return null;
  const command = call.arguments.command.trim();
  const node = String.raw`node\s+(?:"\$CAFF_CHAT_TOOLS_PATH"|'\$CAFF_CHAT_TOOLS_PATH'|\$CAFF_CHAT_TOOLS_PATH|\.?\/?build/lib/agent-chat-tools\.js)\s+send-public`;
  const heredoc = command.match(new RegExp(String.raw`^cat\s+<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\|\s*${node}\s+(?:--no-finalize\s+)?--content-stdin\s*\r?\n([\s\S]*?)\r?\n\2$`));
  if (heredoc) return heredoc[3];
  const quoted = command.match(new RegExp(String.raw`^${node}\s+(?:--no-finalize\s+)?--content\s+(?:'([^']*)'|"([^"$\\]*)")$`));
  return quoted ? quoted[1] ?? quoted[2] : null;
}
export function classifyWikiRunOutput(message: any) {
  if (message?.role !== 'assistant' || !['stop', 'toolUse'].includes(message.stopReason) || !Array.isArray(message.content)) return { status: 'error', reason: 'model_failed', reply: null };
  const calls = message.content.filter((b: any) => b.type === 'toolCall');
  const text = message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  const sent = calls.map(publicMessage);
  const reached = calls.length ? sent.every((s: any) => typeof s === 'string' && s.trim()) : !!text.trim();
  return { status: reached ? 'reached' : 'invalid', reason: reached ? null : calls.length ? 'other_tool_requested' : 'empty_reply',
    reply: reached ? calls.length ? sent.join('\n') : text : null };
}
export async function replayWikiRun(input: any, options: any) {
  const { store, runs, caseId, toolset, candidate, approvedRequestHash } = input;
  const item = store.read().cases.find((c: any) => c.id === caseId);
  if (!item) throw fail('wiki_unknown_case');
  const decision = store.getDehydration(caseId)?.decision;
  const request = buildWikiRunRequest({ item, bundle: store.readCaseTrace(caseId), decision, toolset, candidate });
  if (wikiRunHash(request) !== approvedRequestHash) throw fail('wiki_run_stale');
  if (typeof options?.client?.complete !== 'function') throw fail('wiki_run_client_required');
  if (redactTraceKnownValues(request, options.knownKeyValues || []).count) throw fail('wiki_run_input_contains_known_key');
  // Durable claim BEFORE network. A crash leaves an explicit reserved/unknown
  // attempt; retry cannot silently make another model request for this input.
  // Formal repeats claim a unique batch/iteration OUTSIDE the model request.
  // Legacy one-shot callers retain request-hash identity and cannot resend it.
  const reservation = runs.reserve(request, input.attempt);
  let result: any;
  try {
    const response = await options.client.complete(structuredClone(request));
    if (response?.networkRequests !== 1 || !Number.isFinite(response.durationMs) || response.durationMs < 0) throw fail('wiki_run_client_invalid');
    const message = redactTraceKnownValues(response.message, options.knownKeyValues || []).value;
    result = { message, outcome: classifyWikiRunOutput(message), modelCalls: 1, durationMs: response.durationMs,
      wireRequest: response.wireRequest ? redactTraceKnownValues(response.wireRequest, options.knownKeyValues || []).value : null };
  } catch {
    // No upstream prose, body, path or credentials in error evidence. Never retry.
    result = { message: null, outcome: { status: 'error', reason: 'model_request_failed', reply: null }, modelCalls: null, durationMs: null };
  }
  return runs.finish(reservation.id, { ...result, toolExecutions: 0 });
}
