// @ts-check

(function registerApiClient() {
  const shared = window.CaffShared || (window.CaffShared = {});

  shared.fetchJson = async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

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
      const message = typeof data.error === 'string' && data.error.trim()
        ? data.error.trim()
        : `Request failed with status ${response.status}`;
      /** @type {Error & { status?: number; payload?: any; issues?: any[] }} */
      const error = new Error(message);
      error.status = response.status;
      error.payload = data;
      if (Array.isArray(data.issues)) {
        error.issues = data.issues;
      }
      throw error;
    }

    return data;
  };
})();
