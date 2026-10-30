import net from 'node:net';

export function normalizeHostLiteral(value: any) {
  const host = String(value || '').trim().toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
export function isLoopbackAddress(value: any): boolean {
  const address = normalizeHostLiteral(value).split('%')[0];
  if (!address) return false;
  if (address === 'localhost' || address === '::1') return true;
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice('::ffff:'.length));
  return net.isIP(address) === 4 && address.startsWith('127.');
}
export function formatAuthority(host: string, port: number) {
  const normalized = normalizeHostLiteral(host);
  return `${net.isIP(normalized) === 6 ? `[${normalized}]` : normalized}:${port}`;
}
export function singleHeader(req: any, name: string) {
  const value = req?.headers?.[name];
  if (typeof value !== 'string') return '';
  let count = 0;
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (String(req.rawHeaders[i]).toLowerCase() === name) count++;
  }
  return count > 1 ? '' : value.trim();
}

// No DNS resolution, forwarded headers, URL hostname canonicalization of an
// untrusted authority, or attacker-controlled base for deciding Host trust.
export function validatedRequestAuthority(req: any, configuredHost: string, expected: string) {
  const supplied = singleHeader(req, 'host').toLowerCase();
  const authority = String(expected || '').trim().toLowerCase();
  if (!supplied || !authority) return '';
  let port: string;
  try { port = new URL(`http://${authority}`).port || '80'; } catch { return ''; }
  const allowed = isLoopbackAddress(configuredHost)
    ? ['127.0.0.1', 'localhost', '[::1]'].flatMap(host => port === '80' ? [host, `${host}:80`] : [`${host}:${port}`])
    : [authority, ...(port === '80' && authority.endsWith(':80') ? [authority.slice(0, -3)] : [])];
  return allowed.includes(supplied) ? supplied : '';
}
