import net from 'node:net';

import { createHttpError } from './http-errors';

const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/iu;

function normalizeHeader(value: any) {
  if (Array.isArray(value)) {
    return String(value[0] || '').trim();
  }
  return String(value || '').trim();
}

function normalizeHostLiteral(value: any) {
  const host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

export function isLoopbackAddress(value: any) {
  const address = normalizeHostLiteral(value).split('%')[0];
  if (!address) {
    return false;
  }

  if (address === 'localhost' || address === '::1') {
    return true;
  }

  if (address.startsWith('::ffff:')) {
    return isLoopbackAddress(address.slice('::ffff:'.length));
  }

  if (net.isIP(address) === 4) {
    return address.startsWith('127.');
  }

  return false;
}

function formatAuthority(host: string, port: number) {
  const normalizedHost = normalizeHostLiteral(host);
  const formattedHost = net.isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return `${formattedHost}:${port}`.toLowerCase();
}

export function createLocalAdminGuard(options: any = {}) {
  const configuredHost = normalizeHostLiteral(options.host);
  const issuePrefix = String(options.issuePrefix || 'provider_config').trim() || 'provider_config';
  const errorMessage = String(options.errorMessage || 'Model provider administration request was rejected').trim();
  function guardError(statusCode: number, suffix: string, path: string) {
    return createHttpError(statusCode, errorMessage, {
      issues: [{ code: `${issuePrefix}_${suffix}`, path }],
    });
  }
  const configuredPort = Number(options.port);
  const csrfToken = String(options.csrfToken || '');
  const getAuthority = typeof options.getAuthority === 'function'
    ? options.getAuthority
    : () => formatAuthority(configuredHost, configuredPort);

  function expectedAuthority() {
    return String(getAuthority() || '').trim().toLowerCase();
  }

  function assertRead(req: any) {
    if (!isLoopbackAddress(configuredHost) || !isLoopbackAddress(req && req.socket && req.socket.remoteAddress)) {
      throw guardError(403, 'local_only', 'request.socket');
    }

    const authority = expectedAuthority();
    const hostHeader = normalizeHeader(req && req.headers && req.headers.host).toLowerCase();
    if (!authority || hostHeader !== authority) {
      throw guardError(403, 'host_mismatch', 'headers.host');
    }

    return { authority };
  }

  function assertMutation(req: any) {
    const { authority } = assertRead(req);
    const contentType = normalizeHeader(req && req.headers && req.headers['content-type']);
    if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
      throw guardError(415, 'json_required', 'headers.content-type');
    }

    const origin = normalizeHeader(req && req.headers && req.headers.origin).toLowerCase();
    if (origin !== `http://${authority}`) {
      throw guardError(403, 'origin_mismatch', 'headers.origin');
    }

    const suppliedToken = normalizeHeader(req && req.headers && req.headers['x-caff-csrf-token']);
    if (!csrfToken || suppliedToken !== csrfToken) {
      throw guardError(403, 'csrf_invalid', 'headers.x-caff-csrf-token');
    }

    return { authority };
  }

  return {
    assertMutation,
    assertRead,
  };
}
