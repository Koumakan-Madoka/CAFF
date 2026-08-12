// @ts-check

(function registerApiClient() {
  const shared = window.CaffShared || (window.CaffShared = {});

  async function parseJsonResponse(response) {
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { rawText: text };
      }
    }

    if (!response.ok) {
      const structuredError = data.error && typeof data.error === 'object' ? data.error : null;
      const message = structuredError && typeof structuredError.message === 'string' && structuredError.message.trim()
        ? structuredError.message.trim()
        : typeof data.error === 'string' && data.error.trim()
          ? data.error.trim()
          : `Request failed with status ${response.status}`;
      /** @type {Error & { status?: number; payload?: any; issues?: any[]; code?: string }} */
      const error = new Error(message);
      error.status = response.status;
      error.payload = data;
      error.code = structuredError && structuredError.code
        ? String(structuredError.code)
        : data.code
          ? String(data.code)
          : '';
      if (Array.isArray(data.issues)) {
        error.issues = data.issues;
      }
      throw error;
    }

    return data;
  }

  shared.fetchJson = async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return parseJsonResponse(response);
  };

  shared.fetchFormDataJson = async function fetchFormDataJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'POST',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      body: options.body,
    });
    return parseJsonResponse(response);
  };
})();
