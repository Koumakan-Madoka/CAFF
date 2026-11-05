import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { createWikiStore } from '../domain/runtime/badcase-capture/wiki-store';
import { listWikiTargets } from '../domain/runtime/badcase-capture/wiki-targets';
import { collectWikiCandidateFiles } from '../domain/runtime/badcase-capture/wiki-candidate-files';
import { createWikiComparisonStore } from '../domain/runtime/badcase-capture/wiki-comparison-store';
import { wikiComparisonDisplay } from '../domain/runtime/badcase-capture/wiki-comparison-scoring';
import { wikiDisplayCases } from '../domain/runtime/badcase-capture/wiki-suite';
import { createWikiExecutionStore } from '../domain/runtime/badcase-capture/wiki-execution-store';
import { createWikiBatchExecutionStore } from '../domain/runtime/badcase-capture/wiki-batch-execution-store';
import { resolveWikiStorageOptions } from '../domain/runtime/badcase-capture/wiki-data-directory';
import { assertWikiEligibleModel, readWikiEligibleJudges } from '../domain/runtime/badcase-capture/wiki-judge-catalog';
import { WIKI_RUBRIC_MODEL } from '../domain/runtime/badcase-capture/wiki-rubric';

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
    wiki_rubric_invalid: 422, wiki_rubric_assertion_required: 422, wiki_rubric_model_invalid: 422,
    wiki_rubric_not_found: 404, wiki_rubric_frozen: 409, wiki_rubric_hash_changed: 409, wiki_rubric_source_changed: 409,
    wiki_judge_not_eligible: 409, wiki_judge_catalog_invalid: 503,
    wiki_rubric_drafting_unavailable: 503, wiki_rubric_model_output_invalid: 422, wiki_rubric_request_failed: 503,
    evaluation_batch_task_unavailable: 409,
  };
  return async ({ req, res, pathname }: any) => {
    const match = pathname.match(/^\/api\/wikiskill(?:\/(review|confirm-candidate|candidate|confirm-global-candidate|induct|suggestion|membership|executions|comparison-review|experience|rubric|draft-rubric|confirm-rubric))?$/);
    const readOnly = !match?.[1] || match[1] === 'executions';
    if (!match || (readOnly ? req.method !== 'GET' : req.method !== 'POST')) return false;
    if (readOnly) guard.assertRead(req); else guard.assertMutation(req);
    let input: any;
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
        rubric: ['confirmed', 'caseId', 'questions', 'scoringModel', 'expectedRevision'],
        'draft-rubric': ['confirmed', 'caseId', 'expectedRevision'],
        'confirm-rubric': ['confirmed', 'rubricId', 'hash', 'expectedRevision'],
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
      if (match[1] === 'executions') { sendJson(res, 200, { executions: executions(), comparisons: createWikiComparisonStore(scope).read().map(wikiComparisonDisplay) }); return true; }
      const store = createWikiStore(scope);
      const eligibleJudges = readWikiEligibleJudges(options.judgeCatalogFile);
      if (['rubric', 'draft-rubric', 'confirm-rubric'].includes(match[1])) {
        const state = store.read();
        if (!Number.isSafeInteger(input.expectedRevision)) throw Object.assign(Error(), { code: 'wiki_invalid_input' });
        if (input.expectedRevision !== state.revision) throw Object.assign(Error(), { code: 'wiki_revision_conflict' });
        if (match[1] === 'confirm-rubric') {
          const rubric = state.rubrics?.find((r: any) => r.id === input.rubricId);
          if (!rubric) throw Object.assign(Error(), { code: 'wiki_rubric_not_found' });
          assertWikiEligibleModel(rubric.scoringModel, eligibleJudges);
          store.confirmRubric({ rubricId: input.rubricId, hash: input.hash,
            confirmationRecord: 'WikiSkill 页面明确确认断言全文及所选打分模型（同 OS 用户管理边界）。' }, input.expectedRevision);
        } else {
          if (!state.cases.some((c: any) => c.id === input.caseId)) throw Object.assign(Error(), { code: 'wiki_unknown_case' });
          if (match[1] === 'rubric') {
            if (input.scoringModel != null) assertWikiEligibleModel(input.scoringModel, eligibleJudges);
            store.saveRubricDraft({ caseId: input.caseId, questions: input.questions, scoringModel: input.scoringModel ?? null, model: WIKI_RUBRIC_MODEL }, input.expectedRevision);
          } else {
            if (typeof options.runRubricDraft !== 'function') throw Object.assign(Error(), { code: 'wiki_rubric_drafting_unavailable' });
            await options.runRubricDraft({ store, caseId: input.caseId, expectedRevision: input.expectedRevision, scope });
          }
        }
      }
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
      sendJson(res, 200, { ...state, cases: wikiDisplayCases(state.cases), caseStates: store.getCaseStates(), comparisons: createWikiComparisonStore(scope).read().map(wikiComparisonDisplay), executions: executions(), targets: listWikiTargets(), eligibleJudges, trustBoundary: 'same_os_user' });
    } catch (e: any) {
      const code = Object.hasOwn(errors, e?.code || '') ? e.code : 'wiki_unavailable';
      throw issue(code, errors[code] || 503);
    }
    return true;
  };
}
