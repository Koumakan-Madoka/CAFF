// Dialect/baseURL consistency diagnostics for catalog import and the provider
// editor. Diagnostics are advisory only: they never rewrite a value, and a
// suggestion is applied solely when the user explicitly accepts it.
//
// Two tiers, deliberately narrow:
//
// 1. Verified combinations (`VERIFIED_ENDPOINTS` below). A mismatch diagnostic
//    with an explicit suggestion is produced only when the (dialect, host,
//    path) triple matches a documented, checkable fact — the `basis` field
//    names the evidence and tests pin it:
//      - Kimi For Coding anthropic-messages: pi's vendored model registry
//        (node_modules/@earendil-works/pi-ai/dist/providers/data/kimi-coding.json)
//        ships anthropic-messages + https://api.kimi.com/coding, and the
//        vendored @anthropic-ai/sdk appends a literal "/v1/messages" to the
//        configured baseURL (mock-fetch pinned in
//        tests/runtime/endpoint-diagnostics.test.js).
//      - Kimi For Coding openai-completions: models.dev's kimi-code-plan-cn
//        entry pairs @ai-sdk/openai-compatible with
//        https://api.kimi.com/coding/v1, and the vendored openai client
//        appends "/chat/completions" to the configured baseURL (mock-fetch
//        pinned in the same test file).
//
// 2. Unverified hints. Every well-formed combination that is not a
//    verified match earns a hint, so silence can never read as "checked and
//    fine":
//      - anthropic-messages with a base URL ending in "/v1": a verify hint
//        stating the factual request path (the double-/v1 pattern).
//      - other anthropic-messages / openai-completions / openai-responses
//        endpoints: a neutral hint stating the pinned SDK path fact.
//      - everything else (google, unknown dialects): a generic hint without
//        path claims — CAFF does not guess client behavior it has not pinned.
//    None of these ever carry a suggestion: SDK path appending says nothing
//    about a gateway's routing rules, so unknown endpoints never receive a
//    guessed address. Incomplete or unparseable inputs stay silent.
//
// The browser mirror in public/shared/endpoint-diagnostics.js must produce
// identical verdicts; the symmetry is pinned by the same test file.

function text(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface NormalizedEndpoint {
  url: URL;
  host: string;
  path: string;
  rawUrl: string;
}

function normalizeEndpoint(rawUrl: string): NormalizedEndpoint | null {
  let url: URL;
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
  return { url, host: url.hostname.toLowerCase(), path: pathname, rawUrl };
}

interface EndpointShape {
  path: string;
  baseUrl: string;
  basis: string;
}

// A verified basis covers exactly the official endpoint form. Scheme, host,
// default port, absence of credentials/query/fragment, and the path must all
// match: a custom port, scheme, query, or credential is a different endpoint
// the evidence says nothing about.
function endpointMatchesShape(endpoint: NormalizedEndpoint, shape: EndpointShape): boolean {
  let verifiedUrl: URL;
  try {
    verifiedUrl = new URL(shape.baseUrl);
  } catch {
    return false;
  }
  return endpoint.url.protocol === verifiedUrl.protocol
    && endpoint.url.host === verifiedUrl.host
    && !endpoint.url.search
    && !endpoint.url.hash
    && !endpoint.url.username
    && !endpoint.url.password
    && endpoint.path === shape.path;
}

interface VerifiedEndpoint {
  id: string;
  label: string;
  host: string;
  anthropic: { path: string; baseUrl: string; basis: string };
  openaiCompletions: { path: string; baseUrl: string; basis: string };
}

// Verified (dialect, host, path) combinations. Extend only with a checkable
// basis; never by analogy.
const VERIFIED_ENDPOINTS: VerifiedEndpoint[] = [
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

export interface EndpointDiagnostic {
  status: 'mismatch' | 'unverified';
  code: 'verified_endpoint_protocol_mismatch' | 'anthropic_base_url_version_suffix' | 'endpoint_not_verified';
  suggestion?: string;
  basis: string;
  message: string;
}

/**
 * Inspect a (dialect, baseUrl) pair. Returns null only for verified matches
 * and for incomplete/unparseable inputs; every other well-formed combination
 * produces a diagnostic. Only a verified combination (exact official endpoint
 * form) produces a `mismatch` diagnostic carrying an explicit suggestion; all
 * unverified combinations produce an `unverified` hint without any
 * suggestion. Legal "/v1" paths and custom gateways are never rewritten or
 * rejected.
 */
export function inspectDialectEndpoint(dialect: any, baseUrl: any): EndpointDiagnostic | null {
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
        if (endpointMatchesShape(endpoint, verified.anthropic)) {
          return null;
        }
        if (endpointMatchesShape(endpoint, verified.openaiCompletions)) {
          return {
            status: 'mismatch',
            code: 'verified_endpoint_protocol_mismatch',
            suggestion: verified.anthropic.baseUrl,
            basis: verified.anthropic.basis,
            message: `已核实的 ${verified.label} 端点：Anthropic 协议应使用 ${verified.anthropic.baseUrl}。Anthropic 客户端会自动在 Base URL 后追加 /v1/messages，当前地址实际会请求 ${bareUrl}/v1/messages。建议改为 ${verified.anthropic.baseUrl}。`,
          };
        }
      } else {
        if (endpointMatchesShape(endpoint, verified.openaiCompletions)) {
          return null;
        }
        if (endpointMatchesShape(endpoint, verified.anthropic)) {
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

  if (api === 'anthropic-messages') {
    if (/\/v1$/iu.test(endpoint.path)) {
      return {
        status: 'unverified',
        code: 'anthropic_base_url_version_suffix',
        basis: 'vendored-anthropic-sdk-appends-v1-messages',
        message: `Anthropic 协议客户端会自动在 Base URL 后追加 /v1/messages，当前地址实际会请求 ${bareUrl}/v1/messages。该端点不在已核实清单内，CAFF 不提供建议地址；请自行核对该网关是否接受此路径。`,
      };
    }
    return {
      status: 'unverified',
      code: 'endpoint_not_verified',
      basis: 'vendored-anthropic-sdk-appends-v1-messages',
      message: `该端点不在 CAFF 已核实清单内；Anthropic 协议客户端会自动在 Base URL 后追加 /v1/messages，当前地址实际会请求 ${bareUrl}/v1/messages。请自行核对协议与地址是否匹配；CAFF 不会自动修改该地址。`,
    };
  }

  // Unknown OpenAI endpoints keep a neutral verify hint so that silence stays
  // reserved for verified matches. The message only states pinned SDK path
  // facts (mock-fetch tests in tests/runtime/endpoint-diagnostics.test.js);
  // it never guesses an address and never rewrites or rejects the URL.
  if (api === 'openai-completions' || api === 'openai-responses') {
    const pathSuffix = api === 'openai-completions' ? '/chat/completions' : '/responses';
    const basis = api === 'openai-completions'
      ? 'vendored-openai-client-appends-chat-completions'
      : 'vendored-openai-client-appends-responses';
    const clientLabel = api === 'openai-completions' ? 'OpenAI 兼容客户端' : 'OpenAI Responses 客户端';
    return {
      status: 'unverified',
      code: 'endpoint_not_verified',
      basis,
      message: `该端点不在 CAFF 已核实清单内；${clientLabel}会请求 ${bareUrl}${pathSuffix}。请自行核对网关路径；CAFF 不会自动修改该地址。`,
    };
  }

  // Every other dialect (google, custom protocol strings, ...) gets the
  // generic hint without path claims: CAFF does not guess client behavior it
  // has not pinned, but silence must not read as a verified match either.
  return {
    status: 'unverified',
    code: 'endpoint_not_verified',
    basis: 'unverified-endpoint',
    message: '该端点不在 CAFF 已核实清单内，请自行核对协议与地址是否匹配；CAFF 不会自动修改该地址。',
  };
}
