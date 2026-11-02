import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

// Production supplies no workbench: launch/material routes remain absent. Only
// an isolated operator composition may inject that capability, never HTTP input.
export function createBadcaseEvaluationsController(options: any = {}): RouteHandler<any> {
  const guard = createLocalAdminGuard({ ...options, issuePrefix: 'badcase_evaluation' });
  const issue = (code: string, status = 422) => createHttpError(status, 'Offline evaluation request was rejected', {
    issues: [{ code, path: 'offlineEvaluation' }],
  });
  const errors: Record<string, number> = { evaluation_admin_invalid: 422, evaluation_plan_invalid: 422,
    evaluation_offline_only: 422, evaluation_preview_stale: 409, evaluation_preview_busy: 429,
    evaluation_approval_invalid: 409, evaluation_approval_conflict: 409, evaluation_clock_invalid: 409,
    evaluation_record_invalid: 409, evaluation_record_write_failed: 503,
    evaluation_workbench_invalid: 422, evaluation_material_missing: 404, evaluation_material_invalid: 409,
    evaluation_review_stale: 409, evaluation_review_invalid: 409, evaluation_review_write_failed: 503, evaluation_start_attempted: 409, evaluation_workbench_busy: 429, evaluation_start_failed: 409 };
  return async ({ req, res, pathname }: any) => {
    const match = pathname.match(/^\/api\/projects\/([^/]+)\/badcase-evaluations\/(preview|approve|records\/([^/]+)|reviews\/([^/]+)|materials|material-preview|material-approve|start)$/);
    if (!match) return false;
    const operation = match[2], review = operation.startsWith('reviews/');
    const workbench = review || ['materials', 'material-preview', 'material-approve', 'start'].includes(operation);
    if (workbench && !options.workbench) return false;
    const record = operation.startsWith('records/'), read = record || review || operation === 'materials';
    if (req.method !== (read ? 'GET' : 'POST')) return false;
    if (read) guard.assertRead(req); else guard.assertMutation(req);
    let projectId: string, approvalId: string;
    try { projectId = decodeURIComponent(match[1]); approvalId = record ? decodeURIComponent(match[3]) : review ? decodeURIComponent(match[4]) : ''; }
    catch { throw issue('evaluation_admin_invalid'); }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw issue('evaluation_admin_invalid');
    if (!options.projectManager?.listProjects().some((p: any) => p.id === projectId)) throw issue('badcase_evaluation_project_missing', 404);
    if (!options.service) throw issue('badcase_evaluation_unavailable', 503);
    const body = read ? null : await readRequestJson(req, { bodyLimit: 16384 });
    let result;
    try {
      result = workbench
        ? await (review ? options.workbench.readReview(projectId, approvalId) : operation === 'materials' ? options.workbench.materials(projectId)
          : operation === 'material-preview' ? options.workbench.preview(projectId, body)
          : operation === 'material-approve' ? options.workbench.approve(projectId, body) : options.workbench.start(projectId, body))
        : record ? options.service.read(projectId, approvalId)
          : operation === 'preview' ? options.service.preview(projectId, body) : options.service.approve(projectId, body);
    } catch (error: any) {
      const code = typeof error?.code === 'string' && Object.hasOwn(errors, error.code) ? error.code : 'badcase_evaluation_unavailable';
      throw issue(code, errors[code] || 503);
    }
    sendJson(res, 200, result);
    return true;
  };
}
