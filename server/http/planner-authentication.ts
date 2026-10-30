import type { PlannerCredential, PlannerPrincipal } from '../domain/security/planner-credential';
import { createHttpError } from './http-errors';

export type HttpPrincipal = { kind: 'user' } | PlannerPrincipal;
const AUTHENTICATED_PRINCIPAL = Symbol('caff.authenticatedPrincipal');
export function getAuthenticatedPrincipal(req: any): HttpPrincipal | null | undefined { return req[AUTHENTICATED_PRINCIPAL]; }
export function isNativeApiDomain(method: string, pathname: string) {
  return pathname.startsWith('/api/agent-tools/') || (method === 'POST' && pathname === '/api/integrations/feishu/webhook');
}

function headerPresent(req: any, name: string) {
  return Object.prototype.hasOwnProperty.call(req.headers || {}, name);
}
function headerCount(req: any, name: string) {
  if (!Array.isArray(req.rawHeaders)) return headerPresent(req, name) ? 1 : 0;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (String(req.rawHeaders[i]).toLowerCase() === name) count++;
  return count;
}
function invalidCredential(): never {
  throw createHttpError(401, 'Planner credential is missing or invalid', { code: 'planner_credential_invalid' });
}

// null means a native trust domain, NOT a user. Its existing controller must
// still authenticate the invocation or webhook. A bearer never replaces that.
export function authenticateApiRequest(req: any, pathname: string, credential: PlannerCredential): HttpPrincipal | null {
  delete req[AUTHENTICATED_PRINCIPAL];
  const principal = derivePrincipal(req, pathname, credential);
  Object.defineProperty(req, AUTHENTICATED_PRINCIPAL, { value: principal, configurable: true });
  return principal;
}
function derivePrincipal(req: any, pathname: string, credential: PlannerCredential): HttpPrincipal | null {
  const claimed = headerPresent(req, 'x-caff-principal');
  if (isNativeApiDomain(req.method, pathname)) {
    if (claimed) invalidCredential();
    return null;
  }
  const hasAuthorization = headerPresent(req, 'authorization');
  const intent = hasAuthorization || claimed || pathname === '/api/planner' || pathname.startsWith('/api/planner/');
  if (!intent) return { kind: 'user' };
  if (claimed && (headerCount(req, 'x-caff-principal') !== 1 || req.headers['x-caff-principal'] !== 'planner')) invalidCredential();
  if (!hasAuthorization || headerCount(req, 'authorization') !== 1 || typeof req.headers.authorization !== 'string') invalidCredential();
  // HTTP auth scheme is case-insensitive; the opaque token is not. Exactly one
  // token, no comma-joined or duplicate headers, no fallback after any failure.
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization);
  if (!match || match[0].length !== req.headers.authorization.length) invalidCredential();
  const principal = credential.authenticate(match[1]);
  if (!principal) invalidCredential();
  return principal;
}
