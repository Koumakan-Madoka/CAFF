import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson, sendTextDownload } from '../http/response';
import { wikiTraceMarkdown } from '../domain/runtime/badcase-capture/wiki-trace-export';
import { createWikiStore } from '../domain/runtime/badcase-capture/wiki-store';
import { createWikiRunStore } from '../domain/runtime/badcase-capture/wiki-run-store';
import { listWikiTargets } from '../domain/runtime/badcase-capture/wiki-targets';
import { collectWikiCandidateFiles } from '../domain/runtime/badcase-capture/wiki-candidate-files';
import { createWikiComparisonStore } from '../domain/runtime/badcase-capture/wiki-comparison-store';
import { wikiDisplayCases } from '../domain/runtime/badcase-capture/wiki-suite';
import { createWikiExecutionStore } from '../domain/runtime/badcase-capture/wiki-execution-store';
import { createWikiBatchExecutionStore } from '../domain/runtime/badcase-capture/wiki-batch-execution-store';
import { resolveWikiStorageOptions } from '../domain/runtime/badcase-capture/wiki-data-directory';

// Local candidate preparation/review only. Neither loading, approving a guideline nor
// confirming a candidate starts a model request or edits a production role.
export function createBadcaseWikiController(options: any = {}): RouteHandler<any> {
  const guard = createLocalAdminGuard({ ...options, issuePrefix: 'badcase_wiki' });
  const issue = (code: string, status = 422) => createHttpError(status, 'Wiki request was rejected', { issues: [{ code, path: 'wiki' }] });
  const errors: Record<string, number> = {
    wiki_invalid_identifier: 422, wiki_invalid_input: 422, wiki_invalid_text: 422, wiki_contains_secret: 422,
    wiki_guideline_too_long: 422, wiki_membership_edit_unsupported: 422, wiki_unknown_case: 422,
    wiki_invalid_case_ids: 422, wiki_revision_conflict: 409, wiki_entry_reviewed: 409, wiki_entry_not_found: 404,
    wiki_collection_too_large: 422, wiki_record_invalid: 409, wiki_write_failed: 503, capture_writer_busy: 409,
    wiki_trace_invalid: 409, wiki_trace_association_mismatch: 409, wiki_trace_missing: 404,
    wiki_run_record_invalid: 409, wiki_run_not_found: 404,
    wiki_dehydration_frozen: 409, wiki_dehydration_stale: 409, wiki_dehydration_recommendation_required: 409,
    wiki_dehydration_ineligible: 422, wiki_dehydration_cut_invalid: 422, wiki_dehydration_prefix_unavailable: 422,
    wiki_candidate_invalid: 422, wiki_candidate_already_baseline: 409, wiki_candidate_leak: 422, wiki_candidate_not_found: 404, wiki_candidate_deprecated: 409,
    wiki_candidate_approved_required: 409, wiki_candidate_confirmation_required: 409, wiki_candidate_role_mismatch: 409,
    wiki_target_unknown: 422, wiki_candidate_target_mismatch: 409, wiki_candidate_anchor_unsupported: 409,
    wiki_comparison_record_invalid: 409, wiki_comparison_not_found: 404, wiki_comparison_invalid: 422,
    wiki_comparison_review_invalid: 409, wiki_comparison_reviewed: 409, wiki_candidate_not_adopted: 409,
    wiki_migration_location_invalid: 409, wiki_data_dir_invalid: 503,
    wiki_no_pending_cases: 409, wiki_not_pending: 409,
    wiki_experience_invalid: 422, wiki_experience_not_found: 404, wiki_experience_reviewed: 409,
    wiki_experience_conflict: 409, wiki_experience_review_required: 409,
    wiki_suggestion_not_found: 404, wiki_suggestion_resolved: 409, wiki_suggestion_review_required: 409,
    wiki_model_output_invalid: 422, wiki_generation_failed: 503, wiki_unknown_training_case: 422,
    wiki_training_input_too_large: 422, evaluation_caff_auth_unavailable_or_invalid: 503, evaluation_linux_required: 503,
    wiki_runtime_config_required: 503, wiki_runtime_config_invalid: 503,
    evaluation_wsl_host_required: 503, evaluation_wsl_backend_invalid: 503, wiki_execution_record_invalid: 503,
  };
  return async ({ req, res, pathname }: any) => {
    const traceMatch = pathname.match(/^\/api\/wikiskill\/cases\/([^/]+)\/trace(?:\/export\.(json|md))?$/);
    const runMatch = pathname.match(/^\/api\/wikiskill\/cases\/([^/]+)\/run-replays\/([a-f0-9]{64})$/);
    const match = pathname.match(/^\/api\/wikiskill(?:\/(review|confirm-candidate|candidate|confirm-global-candidate|induct|suggestion|membership|executions|comparison-review|experience|dehydration-confirm))?$/)
      || (traceMatch ? [pathname, 'case-trace'] : runMatch ? [pathname, 'run-replay'] : null);
    const readOnly = !match?.[1] || ['executions', 'case-trace', 'run-replay'].includes(match[1]);
    if (!match || (readOnly ? req.method !== 'GET' : req.method !== 'POST')) return false;
    if (readOnly) guard.assertRead(req); else guard.assertMutation(req);
    let input;
    if (!readOnly) {
      input = await readRequestJson(req, { bodyLimit: 64 * 1024 });
      const fields: Record<string, string[]> = {
        'confirm-candidate': ['confirmed', 'candidateId', 'candidateRoleHash', 'expectedRevision'],
        candidate: ['confirmed', 'versionId', 'entryIds', 'targetId', 'expectedRevision'],
        'confirm-global-candidate': ['confirmed', 'candidateId', 'candidateHash', 'expectedRevision'],
        induct: ['confirmed', 'expectedRevision'],
        suggestion: ['confirmed', 'suggestionId', 'decision', 'expectedRevision'],
        membership: ['confirmed', 'caseId', 'entryId', 'expectedRevision'],
        review: ['confirmed', 'versionId', 'entryId', 'expectedRevision', 'patch', 'decision'],
        'comparison-review': ['confirmed', 'comparisonId', 'candidateHash', 'expectedRevision', 'decision', 'reason', 'interpretation'],
        experience: ['confirmed', 'experienceId', 'expectedRevision', 'decision', 'patch'],
        'dehydration-confirm': ['confirmed', 'caseId', 'traceHash', 'recommendationHash', 'kind', 'cutStep', 'expectedRevision'],
      };
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(k => !fields[match[1]].includes(k))) throw issue('wiki_invalid_input');
      if (input.confirmed !== true) throw issue('wiki_confirmation_required');
      const { confirmed, ...mutation } = input; input = mutation;
    }
    try {
      const scope = resolveWikiStorageOptions({ agentDir: options.agentDir, globalRoot: options.globalRoot, sourceWorktree: options.sourceWorktree, instanceCaptureRoot: options.instanceCaptureRoot,
        sourceWorktrees: options.projectManager?.listProjects().map((p: any) => p.path) || [] });
      const executions = () => [...createWikiExecutionStore(scope).read(), ...createWikiBatchExecutionStore(scope).read()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 20);
      if (match[1] === 'executions') { sendJson(res, 200, { executions: executions(), comparisons: createWikiComparisonStore(scope).read() }); return true; }
      const store = createWikiStore(scope), runs = createWikiRunStore(scope);
      if (runMatch) {
        let caseId;
        try { caseId = decodeURIComponent(runMatch[1]); } catch { throw Object.assign(Error(), { code: 'wiki_invalid_identifier' }); }
        if (!store.read().cases.some((c: any) => c.id === caseId)) throw Object.assign(Error(), { code: 'wiki_unknown_case' });
        const packet = runs.read(runMatch[2]);
        if (packet.reservation.request.metadata.caseId !== caseId) throw Object.assign(Error(), { code: 'wiki_run_not_found' });
        sendJson(res, 200, packet); return true;
      }
      if (traceMatch) {
        let caseId;
        try { caseId = decodeURIComponent(traceMatch[1]); } catch { throw Object.assign(Error(), { code: 'wiki_invalid_identifier' }); }
        const packet = store.readCaseTrace(caseId);
        if (traceMatch[2]) {
          if (!packet) throw Object.assign(Error(), { code: 'wiki_trace_missing' });
          const json = traceMatch[2] === 'json';
          sendTextDownload(res, json ? JSON.stringify(packet, null, 2) + '\n' : wikiTraceMarkdown(packet),
            `badcase-${caseId}-trace.${traceMatch[2]}`, json ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
        } else sendJson(res, 200, { traceBundle: packet });
        return true;
      }
      if (match[1] === 'dehydration-confirm') store.confirmDehydration(input);
      if (match[1] === 'review') store.review(input);
      if (match[1] === 'comparison-review') store.reviewComparison(input);
      if (match[1] === 'experience') {
        if (input.decision === 'revise') { const { decision, ...revision } = input; store.reviseExperience(revision); }
        else store.reviewExperience(input);
      }
      if (match[1] === 'suggestion') store.resolveSuggestion(input);
      if (match[1] === 'membership') store.assignCase(input);
      if (match[1] === 'induct') {
        if (typeof options.runInduction !== 'function') throw Object.assign(Error(), { code: 'wiki_induction_unavailable' });
        await options.runInduction({ store, expectedRevision: input.expectedRevision });
      }
      if (match[1] === 'confirm-candidate') store.confirmCandidate(input);
      if (match[1] === 'candidate' || match[1] === 'confirm-global-candidate') {
        const state = store.read();
        if (!Number.isSafeInteger(input.expectedRevision)) throw Object.assign(Error(), { code: 'wiki_invalid_input' });
        if (state.revision !== input.expectedRevision) throw Object.assign(Error(), { code: 'wiki_revision_conflict' });
        const files = collectWikiCandidateFiles(state, scope);
        if (match[1] === 'candidate') store.createGlobalCandidate({ versionId: input.versionId, entryIds: input.entryIds, targetId: input.targetId, files }, input.expectedRevision);
        else store.confirmGlobalCandidate({ ...input, files });
      }
      const state = store.read();
      sendJson(res, 200, { ...state, cases: wikiDisplayCases(state.cases), caseStates: store.getCaseStates(), runReplays: runs.list(), comparisons: createWikiComparisonStore(scope).read(), executions: executions(), targets: listWikiTargets(), trustBoundary: 'same_os_user' });
    } catch (e: any) {
      const code = Object.hasOwn(errors, e?.code || '') ? e.code : 'wiki_unavailable';
      throw issue(code, errors[code] || 503);
    }
    return true;
  };
}
