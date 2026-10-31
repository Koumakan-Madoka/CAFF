import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { createWikiStore } from '../domain/runtime/badcase-capture/wiki-store';

// Review/confirmation only. Neither loading, approving a guideline nor
// confirming a candidate starts a model request or edits a production role.
export function createBadcaseWikiController(options: any = {}): RouteHandler<any> {
  const guard = createLocalAdminGuard({ ...options, issuePrefix: 'badcase_wiki' });
  const issue = (code: string, status = 422) => createHttpError(status, 'Wiki request was rejected', { issues: [{ code, path: 'wiki' }] });
  const errors: Record<string, number> = {
    wiki_invalid_identifier: 422, wiki_invalid_input: 422, wiki_invalid_text: 422, wiki_contains_secret: 422,
    wiki_guideline_too_long: 422, wiki_membership_edit_unsupported: 422, wiki_unknown_case: 422,
    wiki_invalid_case_ids: 422, wiki_revision_conflict: 409, wiki_entry_reviewed: 409, wiki_entry_not_found: 404,
    wiki_collection_too_large: 422, wiki_record_invalid: 409, wiki_write_failed: 503, capture_writer_busy: 409,
    wiki_candidate_invalid: 422, wiki_candidate_leak: 422, wiki_candidate_not_found: 404,
    wiki_candidate_approved_required: 409, wiki_candidate_confirmation_required: 409, wiki_candidate_role_mismatch: 409,
  };
  return async ({ req, res, pathname }: any) => {
    const match = pathname.match(/^\/api\/wikiskill(?:\/(review|confirm-candidate))?$/);
    if (!match || (match[1] ? req.method !== 'POST' : req.method !== 'GET')) return false;
    if (match[1]) guard.assertMutation(req); else guard.assertRead(req);
    let input;
    if (match[1]) {
      input = await readRequestJson(req, { bodyLimit: 64 * 1024 });
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(k => !(match[1] === 'confirm-candidate'
          ? ['confirmed', 'candidateId', 'candidateRoleHash', 'expectedRevision']
          : ['confirmed', 'versionId', 'entryId', 'expectedRevision', 'patch', 'decision']).includes(k))) throw issue('wiki_invalid_input');
      if (input.confirmed !== true) throw issue('wiki_confirmation_required');
      const { confirmed, ...mutation } = input; input = mutation;
    }
    try {
      const store = createWikiStore({ globalRoot: options.globalRoot, sourceWorktree: options.sourceWorktree,
        sourceWorktrees: options.projectManager?.listProjects().map((p: any) => p.path) || [] });
      if (match[1] === 'review') store.review(input);
      if (match[1] === 'confirm-candidate') store.confirmCandidate(input);
      sendJson(res, 200, { ...store.read(), trustBoundary: 'same_os_user' });
    } catch (e: any) {
      const code = Object.hasOwn(errors, e?.code || '') ? e.code : 'wiki_unavailable';
      throw issue(code, errors[code] || 503);
    }
    return true;
  };
}
