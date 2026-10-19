import path from 'node:path';
import crypto from 'node:crypto';
import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { createLocalAdminGuard } from '../http/local-admin-guard';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';
import { realpathOrResolved, isSameOrUnderPathString } from '../domain/runtime/badcase-capture/capture-policy';
import { normalizeWindowsExternalGitSelection } from '../domain/runtime/badcase-capture/windows-external-selection';

// Local administration only, not an agent tool. Under Goal D10 the same OS user
// is trusted: these guards/confirmation fields do not authenticate a human.
export function createBadcaseCaptureController(options: any = {}): RouteHandler<any> {
  const service = options.service;
  const projectManager = options.projectManager;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const guard = createLocalAdminGuard({ ...options, issuePrefix: 'badcase_capture' });
  // A receipt records a successful estimate in THIS process, not an atomic
  // snapshot or a permission credential. Restart requires another estimate.
  const receipts = new Map<string, { id: string; fingerprint: string; expiresAt: number }>();
  const operations = new Map<string, symbol>();
  function invalidate(projectId: string) {
    receipts.delete(projectId);
    const operation = Symbol();
    operations.set(projectId, operation);
    return operation;
  }
  const fingerprint = (policy: any) => crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  function assertCurrent(projectId: string, operation: symbol, policy: any) {
    // A policy hash alone misses ABA changes (e.g. disable an already disabled
    // project). The generation also invalidates in-flight work on each action.
    if (operations.get(projectId) !== operation || fingerprint(service.loadPolicy(projectId)) !== fingerprint(policy)) {
      throw issue('badcase_capture_operation_stale', 409);
    }
  }
  const issue = (code: string, status = 422, field = 'body') => createHttpError(status, 'Badcase capture request was rejected', {
    issues: [{ code, path: field }],
  });
  function fields(body: any, allowed: string[]) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw issue('badcase_capture_invalid_body');
    if (Object.keys(body).some(key => !allowed.includes(key))) throw issue('badcase_capture_unknown_field');
  }
  function confirmed(body: any) {
    if (body.confirmed !== true) throw issue('badcase_capture_confirmation_required');
  }
  function directories(value: any, required: boolean) {
    if (!Array.isArray(value) || value.length > 32 || (required && !value.length)) throw issue('badcase_capture_invalid_directories');
    const captureRoot = realpathOrResolved(service.captureRoot);
    return value.map((dir: any) => {
      if (typeof dir !== 'string' || !dir.trim() || dir.length > 4096 || dir.includes('\0') || !path.isAbsolute(dir.trim())) {
        throw issue('badcase_capture_invalid_directories');
      }
      const resolved = realpathOrResolved(dir.trim());
      // Never authorize capture state itself or an ancestor of it, including
      // aliases; authorization of an input root has the same restriction.
      if (isSameOrUnderPathString(resolved, captureRoot) || isSameOrUnderPathString(captureRoot, resolved)) {
        throw issue('badcase_capture_invalid_directories');
      }
      return path.resolve(dir.trim());
    });
  }
  function patterns(value: any) {
    if (!Array.isArray(value) || value.length > 256 || value.some((p: any) => typeof p !== 'string' || !p.trim() || p.length > 4096
      || p.includes('\0') || path.isAbsolute(p) || p.replace(/\\/g, '/').split('/').includes('..'))) {
      throw issue('badcase_capture_invalid_patterns');
    }
    return value;
  }
  function state(projectId: string) {
    // Policy is independently observable even if the inventory is unreadable.
    // Catch only the inventory's sanitized failure, never policy/save errors;
    // a successful mutation must not look failed merely due to its usage view.
    const policy = service.loadPolicy(projectId);
    let usage;
    try { usage = service.computeUsage(projectId); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'capture_usage_unavailable') throw error;
      return { policy, usage: null, usageError: 'capture_usage_unavailable', trustBoundary: 'same_os_user' };
    }
    return { policy, usage, usageError: null, trustBoundary: 'same_os_user' };
  }
  async function estimates(projectId: string, policy: any, operation: symbol) {
    if (!policy.authorizedDirs.length) throw issue('badcase_capture_not_authorized', 409);
    const results = [];
    for (const targetDir of policy.authorizedDirs) {
      assertCurrent(projectId, operation, policy);
      const result = await service.estimateDirectoryAsync(projectId, targetDir);
      assertCurrent(projectId, operation, policy);
      results.push({ targetDir, ...result });
    }
    return results;
  }
  async function handleBadcaseCapture(context: any) {
    const { req, res, pathname } = context;
    const match = pathname.match(/^\/api\/projects\/([^/]+)\/badcase-capture(?:\/(authorize|estimate|enable|disable|settings))?$/);
    if (!match) return false;
    const action = match[2] || '';
    if ((!action && req.method !== 'GET') || (action && req.method !== 'POST')) return false;
    if (action) guard.assertMutation(req); else guard.assertRead(req);
    let projectId: string;
    try { projectId = decodeURIComponent(match[1]); } catch { throw issue('badcase_capture_project_missing', 404); }
    // Store path encoding must not alias project IDs. Registered project IDs
    // use this conservative grammar; arbitrary paths are not project IDs.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)
      || !projectManager?.listProjects().some((project: any) => project.id === projectId)) {
      throw issue('badcase_capture_project_missing', 404);
    }
    if (!service) throw issue('badcase_capture_unavailable', 503);
    if (!action) { sendJson(res, 200, state(projectId)); return true; }
    const body = await readRequestJson(req);
    const policy = service.loadPolicy(projectId);
    if (action === 'authorize') {
      fields(body, ['confirmed', 'authorizedDirs', 'authorizedInputDirs', 'includedIgnoredPatterns', 'excludedPatterns', 'windowsExternalGit', 'callbackInputAuthorized']);
      confirmed(body);
      if (body.callbackInputAuthorized !== undefined && typeof body.callbackInputAuthorized !== 'boolean') {
        throw issue('badcase_capture_invalid_context_consent');
      }
      const next = { ...policy,
        authorizedDirs: directories(body.authorizedDirs, true),
        authorizedInputDirs: directories(body.authorizedInputDirs, false),
        includedIgnoredPatterns: patterns(body.includedIgnoredPatterns),
        excludedPatterns: patterns(body.excludedPatterns),
        status: 'disabled', suspendReason: '',
      };
      const windowsExternalGit = normalizeWindowsExternalGitSelection(body.windowsExternalGit, next);
      Object.assign(next, { windowsExternalGit });
      invalidate(projectId);
      // Disable first. Any failure while pinning leaves capture disabled, not
      // enabled with a partly changed authorization scope.
      service.savePolicy(projectId, next, { authorizeCallbackInput: body.callbackInputAuthorized === true });
      service.authorizeProject(projectId);
    } else if (action === 'settings') {
      fields(body, ['stagingRetentionDays', 'stagingQuotaBytes']);
      for (const value of Object.values(body)) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw issue('badcase_capture_invalid_limit');
      }
      invalidate(projectId);
      service.savePolicy(projectId, { ...policy, ...body });
    } else if (action === 'disable') {
      fields(body, []);
      invalidate(projectId);
      service.savePolicy(projectId, { ...policy, status: 'disabled', suspendReason: '' });
    } else if (action === 'estimate') {
      fields(body, []);
      const operation = invalidate(projectId);
      const results = await estimates(projectId, policy, operation);
      assertCurrent(projectId, operation, policy);
      const complete = results.every((result: any) => result.ok === true && result.complete === true);
      const captureAvailable = results.every((result: any) => result.captureAvailable !== false);
      const receipt = complete && captureAvailable ? { id: crypto.randomUUID(), fingerprint: fingerprint(policy), expiresAt: now() + 10 * 60 * 1000 } : null;
      if (receipt) receipts.set(projectId, receipt);
      sendJson(res, 200, { estimates: results, estimateId: receipt?.id || null, expiresAt: receipt?.expiresAt || null,
        totalBytes: results.reduce((sum: number, result: any) => sum + (result.totalBytes || 0), 0), complete, captureAvailable,
        costScope: 'file_metadata_upper_estimate_excludes_session_image_and_manifest_costs' });
      return true;
    } else if (action === 'enable') {
      fields(body, ['confirmed', 'estimateId']);
      confirmed(body);
      const receipt = receipts.get(projectId);
      if (!receipt || receipt.id !== body.estimateId || receipt.expiresAt <= now() || receipt.fingerprint !== fingerprint(policy)) {
        throw issue('badcase_capture_estimate_required', 409);
      }
      const operation = invalidate(projectId);
      // Recheck root identity and enumeration immediately before enabling.
      // This is not a quota guarantee or strict consistency proof.
      const failed = (await estimates(projectId, policy, operation)).find((result: any) => result.ok !== true || result.complete !== true || result.captureAvailable === false);
      assertCurrent(projectId, operation, policy);
      if (receipt.expiresAt <= now()) throw issue('badcase_capture_estimate_required', 409);
      if (failed) throw issue(failed.captureAvailable === false ? 'badcase_capture_collector_unavailable'
        : failed.reason || 'badcase_capture_estimate_incomplete', 409);
      service.savePolicy(projectId, { ...policy, status: 'enabled', suspendReason: '' });
    }
    sendJson(res, 200, state(projectId));
    return true;
  }
  return async context => {
    try { return await handleBadcaseCapture(context); }
    catch (error) {
      // A competing cooperative writer is retryable, not an internal error.
      // Match only the structured lock code; preserve all other failures.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'capture_external_git_selection_invalid') {
        throw issue('capture_external_git_selection_invalid');
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'capture_writer_busy') {
        throw issue('capture_writer_busy', 409);
      }
      if (error && typeof error === 'object' && 'code' in error
          && (error.code === 'windows_authorization_unavailable' || error.code === 'windows_authorization_root_rejected')) {
        throw issue(error.code, 409);
      }
      throw error;
    }
  };
}
