import { createHttpError } from './http-errors';
import { extractMultipartBoundary } from './multipart';
import { formatAuthority, singleHeader, validatedRequestAuthority } from './request-authority';
import { isNativeApiDomain, type HttpPrincipal } from './planner-authentication';
export function createApiMutationGuard(options: any = {}) {
  const getAuthority = typeof options.getAuthority === 'function' ? options.getAuthority : () => formatAuthority(options.host, options.port);
  function reject(status: number, code: string): never { throw createHttpError(status, 'API mutation request was rejected', { code }); }
  function assertMutation(req: any, pathname: string, principal: HttpPrincipal | null) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || isNativeApiDomain(req.method, pathname)) return;
    const authority = validatedRequestAuthority(req, options.host, getAuthority());
    if (!authority) reject(403, 'api_host_mismatch');
    const contentType = singleHeader(req, 'content-type');
    const imageUpload = req.method === 'POST' && /^\/api\/conversations\/[^/]+\/images$/.test(pathname);
    if (imageUpload) {
      if (!extractMultipartBoundary(contentType)) reject(415, 'api_multipart_required');
    } else if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) reject(415, 'api_json_required');
    if (principal?.kind === 'planner') return;
    if (singleHeader(req, 'origin').toLowerCase() !== new URL(`http://${authority}`).origin) reject(403, 'api_origin_mismatch');
    if (!options.csrfToken || singleHeader(req, 'x-caff-csrf-token') !== options.csrfToken) reject(403, 'api_csrf_invalid');
  }
  return { assertMutation };
}
