// @ts-check

(function registerApiClient() {
  const shared = window.CaffShared || (window.CaffShared = {});
  let csrfToken = '';
  /** @type {Promise<void> | null} */
  let securityLoad = null;

  function apiPath(url) {
    const value = String(url || '');
    if (value.startsWith('/api/')) return value.split(/[?#]/)[0];
    try {
      const target = new URL(value, window.location.href);
      return target.origin === window.location.origin && target.pathname.startsWith('/api/') ? target.pathname : '';
    } catch { return ''; }
  }
  function isMutation(method) { return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase()); }
  function rememberSecurity(data) {
    const token = data && (data.apiSecurity && data.apiSecurity.csrfToken
      || data.localAdmin && data.localAdmin.systemServices && data.localAdmin.systemServices.csrfToken
      || data.localAdmin && data.localAdmin.modelProviders && data.localAdmin.modelProviders.csrfToken);
    if (typeof token === 'string' && token.trim()) csrfToken = token.trim();
  }

  async function parseJsonResponse(response) {
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { rawText: text }; }
    }
    if (!response.ok) {
      const structuredError = data.error && typeof data.error === 'object' ? data.error : null;
      const message = structuredError && typeof structuredError.message === 'string' && structuredError.message.trim()
        ? structuredError.message.trim()
        : typeof data.error === 'string' && data.error.trim() ? data.error.trim() : `Request failed with status ${response.status}`;
      /** @type {Error & { status?: number; payload?: any; issues?: any[]; code?: string }} */
      const error = new Error(message);
      error.status = response.status;
      error.payload = data;
      error.code = structuredError && structuredError.code ? String(structuredError.code) : data.code ? String(data.code) : '';
      if (Array.isArray(data.issues)) error.issues = data.issues;
      throw error;
    }
    return data;
  }
  async function ensureApiSecurity() {
    if (csrfToken) return;
    if (!securityLoad) {
      securityLoad = (async () => {
        const response = await fetch('/api/bootstrap', { headers: { Accept: 'application/json' } });
        rememberSecurity(await parseJsonResponse(response));
        if (!csrfToken) throw new Error('API security bootstrap did not provide a CSRF token');
      })().finally(() => { securityLoad = null; });
    }
    await securityLoad;
  }
  async function requestHeaders(url, options, multipart) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    const write = isMutation(options.method);
    const keys = Object.keys(headers);
    if (multipart) {
      // Let fetch generate the real boundary, even if a caller supplied a stale one.
      for (const key of keys) if (key.toLowerCase() === 'content-type') delete headers[key];
    } else if ((write || options.body !== undefined) && !keys.some(key => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (write && apiPath(url)) {
      const suppliedKey = keys.find(key => key.toLowerCase() === 'x-caff-csrf-token');
      const supplied = suppliedKey ? String(headers[suppliedKey] || '') : '';
      if (!csrfToken && !supplied) await ensureApiSecurity();
      for (const key of keys) if (key.toLowerCase() === 'x-caff-csrf-token') delete headers[key];
      headers['X-CAFF-CSRF-Token'] = csrfToken || supplied;
    }
    return headers;
  }
  async function finishResponse(response, url, method) {
    try {
      const data = await parseJsonResponse(response);
      if (apiPath(url) === '/api/bootstrap') rememberSecurity(data);
      return data;
    } catch (error) {
      if (apiPath(url) && isMutation(method) && error.status === 403 && error.code === 'api_csrf_invalid') {
        csrfToken = '';
        // Refresh for the NEXT user action, never replay a possibly committed write.
        try { await ensureApiSecurity(); } catch {}
      }
      throw error;
    }
  }
  shared.fetchJson = async function fetchJson(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const response = await fetch(url, {
      method,
      headers: await requestHeaders(url, { ...options, method }, false),
      body: options.body !== undefined ? JSON.stringify(options.body) : isMutation(method) ? '{}' : undefined,
    });
    return finishResponse(response, url, method);
  };
  shared.fetchFormDataJson = async function fetchFormDataJson(url, options = {}) {
    const method = String(options.method || 'POST').toUpperCase();
    const response = await fetch(url, { method, headers: await requestHeaders(url, { ...options, method }, true), body: options.body });
    return finishResponse(response, url, method);
  };
})();
