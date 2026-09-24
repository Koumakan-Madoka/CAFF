// @ts-check

// Browser mirror of server/domain/models/endpoint-diagnostics.js. Keep the
// verified table, verdict shape, and messages identical — the symmetry is
// pinned by tests/runtime/endpoint-diagnostics.test.js. Advisory only: this
// module never rewrites a value; suggestions apply only on explicit click.

(function registerEndpointDiagnostics() {
  const shared = window.CaffShared || (window.CaffShared = {});

  /** Verified (dialect, host, path) combinations. Extend only with a
   * checkable basis; never by analogy. */
  const VERIFIED_ENDPOINTS = [
    {
      id: 'kimi-for-coding',
      label: 'Kimi For Coding',
      host: 'api.kimi.com',
      anthropic: {
        path: '/coding',
        baseUrl: 'https://api.kimi.com/coding',
        basis: 'pi-vendored-registry:kimi-coding',
      },
      openaiCompletions: {
        path: '/coding/v1',
        baseUrl: 'https://api.kimi.com/coding/v1',
        basis: 'models.dev:kimi-code-plan-cn',
      },
    },
  ];

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeEndpoint(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    return { host: url.hostname.toLowerCase(), path: pathname, rawUrl };
  }

  function inspectDialectEndpoint(dialect, baseUrl) {
    const api = text(dialect);
    const rawUrl = text(baseUrl);
    if (!api || !rawUrl) {
      return null;
    }
    const endpoint = normalizeEndpoint(rawUrl);
    if (!endpoint) {
      return null;
    }
    const bareUrl = rawUrl.replace(/\/+$/u, '');

    if (api === 'anthropic-messages' || api === 'openai-completions') {
      for (const verified of VERIFIED_ENDPOINTS) {
        if (endpoint.host !== verified.host) {
          continue;
        }
        if (api === 'anthropic-messages') {
          if (endpoint.path === verified.anthropic.path) {
            return null;
          }
          if (endpoint.path === verified.openaiCompletions.path) {
            return {
              status: 'mismatch',
              code: 'verified_endpoint_protocol_mismatch',
              suggestion: verified.anthropic.baseUrl,
              basis: verified.anthropic.basis,
              message: `已核实的 ${verified.label} 端点：Anthropic 协议应使用 ${verified.anthropic.baseUrl}。Anthropic 客户端会自动在 Base URL 后追加 /v1/messages，当前地址实际会请求 ${bareUrl}/v1/messages。建议改为 ${verified.anthropic.baseUrl}。`,
            };
          }
        } else {
          if (endpoint.path === verified.openaiCompletions.path) {
            return null;
          }
          if (endpoint.path === verified.anthropic.path) {
            return {
              status: 'mismatch',
              code: 'verified_endpoint_protocol_mismatch',
              suggestion: verified.openaiCompletions.baseUrl,
              basis: verified.openaiCompletions.basis,
              message: `已核实的 ${verified.label} 端点：OpenAI 兼容协议应使用 ${verified.openaiCompletions.baseUrl}。OpenAI 客户端会请求 <Base URL>/chat/completions，当前地址实际会请求 ${bareUrl}/chat/completions。建议改为 ${verified.openaiCompletions.baseUrl}。`,
            };
          }
        }
      }
    }

    if (api === 'anthropic-messages' && /\/v1$/iu.test(endpoint.path)) {
      return {
        status: 'unverified',
        code: 'anthropic_base_url_version_suffix',
        basis: 'vendored-anthropic-sdk-appends-v1-messages',
        message: `Anthropic 协议客户端会自动在 Base URL 后追加 /v1/messages，当前地址实际会请求 ${bareUrl}/v1/messages。该端点不在已核实清单内，CAFF 不提供建议地址；请自行核对该网关是否接受此路径。`,
      };
    }

    return null;
  }

  shared.endpointDiagnostics = { inspectDialectEndpoint };
})();
