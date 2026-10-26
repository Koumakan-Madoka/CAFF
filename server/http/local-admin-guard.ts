import { createHttpError } from './http-errors';
import { formatAuthority, isLoopbackAddress, normalizeHostLiteral, singleHeader, validatedRequestAuthority } from './request-authority';
import { getAuthenticatedPrincipal } from './planner-authentication';
export { isLoopbackAddress } from './request-authority';

export function createLocalAdminGuard(options: any = {}) {
  const configuredHost = normalizeHostLiteral(options.host);
  const issuePrefix = String(options.issuePrefix || 'provider_config').trim() || 'provider_config';
  const errorMessage = String(options.errorMessage || 'Model provider administration request was rejected').trim();
  function guardError(statusCode: number, suffix: string, path: string) {
    return createHttpError(statusCode, errorMessage, { issues: [{ code: `${issuePrefix}_${suffix}`, path }] });
  }
  const csrfToken = String(options.csrfToken || '');
  const getAuthority = typeof options.getAuthority === 'function'
    ? options.getAuthority : () => formatAuthority(configuredHost, Number(options.port));

  function assertRead(req: any) {
    if (!isLoopbackAddress(configuredHost) || !isLoopbackAddress(req?.socket?.remoteAddress)) {
      throw guardError(403, 'local_only', 'request.socket');
    }
    const authority = validatedRequestAuthority(req, configuredHost, getAuthority());
    if (!authority) throw guardError(403, 'host_mismatch', 'headers.host');
    return { authority };
  }
  function assertMutation(req: any) {
    const { authority } = assertRead(req);
    if (!/^application\/json(?:\s*;|$)/iu.test(singleHeader(req, 'content-type'))) {
      throw guardError(415, 'json_required', 'headers.content-type');
    }
    // Only the symbol written by successful central authentication is trusted;
    // body fields and a mere Authorization/claimed-principal header are not.
    if (getAuthenticatedPrincipal(req)?.kind === 'planner') return { authority };
    if (singleHeader(req, 'origin').toLowerCase() !== new URL(`http://${authority}`).origin) {
      throw guardError(403, 'origin_mismatch', 'headers.origin');
    }
    if (!csrfToken || singleHeader(req, 'x-caff-csrf-token') !== csrfToken) {
      throw guardError(403, 'csrf_invalid', 'headers.x-caff-csrf-token');
    }
    return { authority };
  }
  return { assertMutation, assertRead };
}
