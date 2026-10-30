const nativeFetch = globalThis.fetch;

// Explicit legitimate-browser client for legacy integration fixtures. Security
// rejection tests use raw fetch/http, not this convenience helper. Refresh the
// bootstrap BEFORE a write; never auto-replay a request after it was sent.
async function browserFetch(input, options = {}) {
  const url = new URL(input);
  const method = String(options.method || 'GET').toUpperCase();
  const nativeDomain = url.pathname.startsWith('/api/agent-tools/')
    || (method === 'POST' && url.pathname === '/api/integrations/feishu/webhook');
  if (['GET', 'HEAD', 'OPTIONS'].includes(method) || nativeDomain || !url.pathname.startsWith('/api/')) return nativeFetch(input, options);
  const headers = new Headers(options.headers || {});
  if (!headers.has('Origin')) headers.set('Origin', url.origin);
  if (!headers.has('X-CAFF-CSRF-Token')) {
    const response = await nativeFetch(url.origin + '/api/bootstrap');
    if (!response.ok) throw Error('Test browser bootstrap failed');
    const data = await response.json();
    const token = data.apiSecurity?.csrfToken || data.localAdmin?.systemServices?.csrfToken || data.localAdmin?.modelProviders?.csrfToken;
    if (!token) throw Error('Test browser bootstrap missing CSRF token');
    headers.set('X-CAFF-CSRF-Token', token);
  }
  const multipart = options.body instanceof FormData;
  if (!headers.has('Content-Type') && !multipart) headers.set('Content-Type', 'application/json');
  return nativeFetch(input, { ...options, headers, body: options.body === undefined && !multipart ? '{}' : options.body });
}
module.exports = { browserFetch };
