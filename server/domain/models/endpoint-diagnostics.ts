// Dialect/baseURL consistency diagnostics for catalog import and the provider
// editor. Diagnostics are advisory only: they never rewrite a value, and the
// suggestion is applied solely when the user explicitly accepts it.
//
// The one rule implemented today is a protocol-level invariant, not a
// host-specific guess: the vendored @anthropic-ai/sdk (bundled with pi)
// appends a literal "/v1/messages" to the configured baseURL, so an
// anthropic-messages base URL must not already end in "/v1". When it does,
// the deterministic fix is to drop that trailing version segment. Pinned by
// tests/runtime/endpoint-diagnostics.test.js against the real SDK with a mock
// fetch (`basis` below names that evidence).

function text(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Remove a single trailing "/v1" path segment (with optional trailing slash).
 * Returns null when the URL is not http(s) or does not end in the version
 * segment. Query and hash fragments are preserved.
 */
export function stripTrailingApiVersionSegment(rawUrl: string): string | null {
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
  if (!pathname.toLowerCase().endsWith('/v1')) {
    return null;
  }
  const stripped = pathname.slice(0, -'/v1'.length);
  url.pathname = stripped || '/';
  let result = url.toString();
  // url.toString() keeps a trailing "/" for the root path; drop it when the
  // original path had content so "…/coding/v1" suggests "…/coding".
  if (stripped && result.endsWith('/') && !rawUrl.split(/[?#]/u)[0].endsWith('/v1/')) {
    result = result.slice(0, -1);
  }
  return result;
}

export interface EndpointDiagnostic {
  status: 'mismatch';
  code: 'anthropic_base_url_version_suffix';
  suggestion: string;
  basis: 'vendored-anthropic-sdk-appends-v1-messages';
  message: string;
}

/**
 * Inspect a (dialect, baseUrl) pair. Returns null for consistent, unknown, or
 * unverifiable combinations — only a verified protocol-contract violation
 * produces a diagnostic, and only ever as an explicit, user-applied
 * suggestion. Legal "/v1" paths for openai dialects and custom gateways are
 * intentionally left alone.
 */
export function inspectDialectEndpoint(dialect: any, baseUrl: any): EndpointDiagnostic | null {
  const api = text(dialect);
  const url = text(baseUrl);
  if (!api || !url) {
    return null;
  }
  if (api !== 'anthropic-messages') {
    return null;
  }
  const suggestion = stripTrailingApiVersionSegment(url);
  if (!suggestion) {
    return null;
  }
  return {
    status: 'mismatch',
    code: 'anthropic_base_url_version_suffix',
    suggestion,
    basis: 'vendored-anthropic-sdk-appends-v1-messages',
    message: `Base URL 以 /v1 结尾，但 Anthropic 协议客户端会自动在其后追加 /v1/messages，实际请求路径会变成 ${url.replace(/\/+$/u, '')}/v1/messages。建议使用 ${suggestion}（Anthropic 端点不含 /v1 前缀）。`,
  };
}
