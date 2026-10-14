import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

// Same-OS-user administration (Goal D10), not human authentication or an
// agent tool. POST records annotations then seals existing evidence; it never
// enables capture. GET remains read-only.
export function createBadcaseFlagsController(options: any = {}): RouteHandler<any> {
  const guard = createLocalAdminGuard({ ...options, issuePrefix: 'badcase_flag', errorMessage: 'Badcase flag request was rejected' });
  const issue = (code: string, status = 422) => createHttpError(status, 'Badcase flag request was rejected', { issues: [{ code, path: 'badcaseFlag' }] });
  const knownFailures: Record<string, number> = {
    flag_message_not_found: 404, flag_assistant_required: 422, flag_message_not_terminal: 409,
    flag_invalid_identifier: 422, flag_invalid_annotation: 422, flag_contains_secret: 422,
    flag_unknown_field: 422, flag_invalid_run_id: 409, flag_checkpoint_mismatch: 409,
    flag_already_exists: 409, flag_record_invalid: 409, flag_record_too_large: 422,
    flag_write_failed: 503, capture_writer_busy: 409,
  };
  return async function handleBadcaseFlags({ req, res, pathname }: any) {
    const match = pathname.match(/^\/api\/projects\/([^/]+)\/conversations\/([^/]+)\/messages\/([^/]+)\/badcase-flag$/);
    if (!match || !['GET', 'POST'].includes(req.method)) return false;
    if (req.method === 'POST') guard.assertMutation(req); else guard.assertRead(req);
    let scope;
    try {
      const [projectId, conversationId, messageId] = match.slice(1).map(decodeURIComponent);
      if (![projectId, conversationId, messageId].every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw Error();
      scope = { projectId, conversationId, messageId };
    } catch { throw issue('flag_invalid_identifier'); }
    if (!options.projectManager?.listProjects().some((project: any) => project.id === scope.projectId)) {
      throw issue('badcase_flag_project_missing', 404);
    }
    if (!options.service) throw issue('badcase_flag_unavailable', 503);
    let input;
    if (req.method === 'POST') {
      // Parser limit is in decoded UTF-16 units; the service separately enforces
      // 8192 UTF-8 bytes per annotation. Neither error includes submitted text.
      const body = await readRequestJson(req, { bodyLimit: 64 * 1024 });
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw issue('badcase_flag_invalid_body');
      if (Object.keys(body).some(key => !['confirmed', 'actual', 'expected'].includes(key))) throw issue('badcase_flag_unknown_field');
      if (body.confirmed !== true) throw issue('badcase_flag_confirmation_required');
      input = { ...scope, actual: body.actual, expected: body.expected };
    }
    let result;
    try {
      result = req.method === 'GET'
        ? (options.sealingService ? options.sealingService.get(scope) : { flag: options.service.get(scope) })
        : await (options.sealingService || options.service).mark(input);
    } catch (failure: any) {
      // Only enumerated service codes leave this boundary, never filesystem
      // paths, raw exceptions or user-controlled strings from a dependency.
      const code = typeof failure?.code === 'string' && Object.hasOwn(knownFailures, failure.code) ? failure.code : 'badcase_flag_unavailable';
      throw issue(code, knownFailures[code] || 503);
    }
    sendJson(res, req.method === 'POST' && result.created ? 201 : 200, result);
    return true;
  };
}
