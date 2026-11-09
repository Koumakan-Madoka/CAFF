// One model decision, never an agent loop. Historical tool calls are context;
// newly generated calls are recorded as DATA and have no executor here.
import crypto from 'node:crypto';
import { buildDehydrationPrefix, pageDehydrationCause } from './wiki-dehydration';
import { redactTraceKnownValues } from './wiki-trace';
import { prepareWikiRunChecks, finishWikiRunChecks } from './wiki-run-checks';
import { scoreWikiRunChecks, wikiSceneReportChecks } from './wiki-run-check-scoring';
import { bindWikiJudge } from './wiki-scoring-v2';
import { verifyWikiRunWireRequest } from './wiki-run-wire';
import { locateGlobalPromptTarget } from '../../../../lib/agent-prompt-targets';
const fail = (code: string) => Object.assign(Error(code), { code });
export const wikiRunHash = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const WIKI_RUN_MODEL = 'openai-codex/gpt-6.1-sol';
function validHash(v: any, n = 64) { return typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v); }
export function buildWikiRunRequest({ item, bundle, decision, toolset, candidate, reportOnly = false, rubricHash }: any) {
  // An explicit diagnostic is NOT a formal scene run/restore. Bind this policy
  // outside model context, so neither its packets nor hashes can be substituted.
  if (item?.sealedCheckpointId && reportOnly !== true) throw fail('wiki_run_scene_unsupported');
  if (![false, true].includes(reportOnly) || reportOnly && (candidate !== undefined || !validHash(rubricHash))) throw fail('wiki_run_report_invalid');
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
    metadata: { ...prefix.metadata, decisionHash,
      ...(reportOnly ? { report: { kind: 'wiki-run-report-v1', rubricHash, sceneCheckpointId: item.sealedCheckpointId || null } } : {}),
      toolset: { ...structuredClone(versions), definitionsHash: wikiRunHash(definitions) },
      policy: { modelCalls: 1, toolExecutions: 0, retries: 0, prefixConsistencyChecked: false } } };
}
export function publicMessage(call: any): string | null {
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
  // Opt-in only: legacy callers keep their exact request/result packet shape.
  // The frozen rubric hash is result evidence, never part of the model input.
  const rubric = input.rubricHash === undefined ? null : store.getFrozenRubric(caseId, input.rubricHash);
  const sceneReport = input.reportOnly === true && !!item.sealedCheckpointId;
  const observed = rubric && sceneReport ? wikiSceneReportChecks(rubric) : rubric;
  if (rubric && (!rubric.toolCheck && !input.reportOnly || !sceneReport && rubric.questions.some((q: any) => q.evidence !== 'reply')
    || input.reportOnly && !observed.toolCheck && !observed.questions.length)) throw fail('wiki_rubric_run_evidence_invalid');
  const bundle = store.readCaseTrace(caseId);
  let reportBinding = null, reportTask = '';
  if (input.reportOnly) {
    if (options?.confirmed !== true) throw fail('wiki_run_confirmation_required');
    if (!rubric) throw fail('wiki_run_report_invalid');
    reportTask = pageDehydrationCause(bundle).text;
    if (observed.questions.length) {
      if (typeof options.judge?.evaluate !== 'function') throw fail('wiki_judge_adapter_required');
      reportBinding = bindWikiJudge(options.judge.configuration, rubric);
    }
  }
  const request = buildWikiRunRequest({ item, bundle, decision, toolset, candidate,
    ...(input.reportOnly ? { reportOnly: input.reportOnly, rubricHash: rubric.hash } : {}) });
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
    let outcome = classifyWikiRunOutput(message), checks;
    if (rubric) {
      const prepared = prepareWikiRunChecks(message, observed), final = finishWikiRunChecks(prepared);
      checks = { rubricHash: rubric.hash, prepared };
      // 'reached' still means a reply awaits judging, not a pass. Code-only
      // pass/fail is already decisive; unknown syntax remains invalid.
      if (outcome.status !== 'error') outcome = { status: prepared.needsReplyJudge ? 'reached' : final.status,
        reason: prepared.needsReplyJudge ? null : final.reason, reply: prepared.reply };
    }
    result = { message, outcome, modelCalls: 1, durationMs: response.durationMs,
      wireRequest: response.wireRequest ? redactTraceKnownValues(response.wireRequest, options.knownKeyValues || []).value : null,
      ...(checks ? { checks } : {}) };
  } catch {
    // No upstream prose, body, path or credentials in error evidence. Never retry.
    result = { message: null, outcome: { status: 'error', reason: 'model_request_failed', reply: null }, modelCalls: null, durationMs: null };
  }
  if (input.reportOnly) {
    result.report = { kind: 'wiki-run-report-v1', rubricHash: rubric.hash, binding: reportBinding };
    // Preserve raw output even on wire/scoring errors. A diagnostic never
    // retries either the worker or an unknown/crashed reservation.
    if (result.modelCalls === 1 && !verifyWikiRunWireRequest(request, result.wireRequest, options.knownKeyValues || [])) {
      result.outcome = { status: 'error', reason: result.wireRequest ? 'wiki_run_wire_request_mismatch' : 'wiki_run_wire_request_missing', reply: result.outcome.reply };
    } else if (result.message && result.outcome.status !== 'error') {
      try {
        const scored = await scoreWikiRunChecks({ message: result.message, rubric, binding: reportBinding, task: reportTask, expected: item.expected,
          ...(sceneReport ? { sceneReport: true } : {}) }, options.judge);
        Object.assign(result.report, scored);
        result.outcome = { status: scored.checks.status, reason: scored.checks.reason, reply: result.checks.prepared.reply };
      } catch (e: any) {
        result.outcome = { status: 'error', reason: /^wiki_[a-z_]{1,80}$/.test(e?.code || '') ? e.code : 'wiki_run_scoring_failed', reply: result.outcome.reply };
      }
    }
  }
  return runs.finish(reservation.id, { ...result, toolExecutions: 0 });
}
export async function replayWikiRunReport(input: any, options: any) {
  return replayWikiRun({ ...input, reportOnly: true }, options);
}
