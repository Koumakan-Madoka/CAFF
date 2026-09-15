// @ts-nocheck
//
// Whitelist outbound proxy routing for CAFF server processes.
//
// Node's built-in fetch does not read the Windows system proxy, and
// NODE_USE_ENV_PROXY routes *every* outbound request through HTTP(S)_PROXY.
// For deployments behind a local VPN proxy (e.g. Clash) that should only
// carry traffic for non-domestic model providers, we instead install a
// routing dispatcher: by default requests connect directly, and only
// requests whose host matches the PROXY_ONLY_HOSTS whitelist go through the
// proxy. When PROXY_ONLY_HOSTS is unset or empty the feature is fully
// disabled and process behavior is unchanged.
//
// Configuration (read at install time, so .env.local values work):
//   PROXY_ONLY_HOSTS  comma/space separated hostnames. A bare domain matches
//                     itself and every subdomain ("foo.com" covers
//                     "a.foo.com"); a leading dot or "*." is stripped, so
//                     ".foo.com" and "*.foo.com" equal "foo.com". An optional
//                     ":port" suffix restricts the entry to that port.
//   HTTP_PROXY / http_proxy, HTTPS_PROXY / https_proxy — proxy URLs, same
//                     meaning as undici's EnvHttpProxyAgent (http: requests
//                     use HTTP_PROXY, https: requests use HTTPS_PROXY with
//                     HTTP_PROXY as fallback).
//
// PROXY_ONLY_HOSTS takes priority over the NODE_USE_ENV_PROXY repair in
// pi-sdk-host.mjs: when it is configured, this module owns the global
// dispatcher and NO_PROXY is ignored (the whitelist alone decides routing).

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROXY_ONLY_HOSTS_ENV = 'PROXY_ONLY_HOSTS';
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

/**
 * Parse a PROXY_ONLY_HOSTS value into normalized entries. Matching semantics
 * intentionally mirror undici's EnvHttpProxyAgent NO_PROXY parsing so both
 * lists behave the same way for the same text. A lone "*" is meaningless for
 * a whitelist (it would match no real hostname) and is dropped. Bare IPv6
 * literals cannot be expressed ("::1" parses as host ":" port 1) — the same
 * limitation undici's NO_PROXY parser has.
 *
 * @param {string} raw the raw environment value
 * @returns {Array<{hostname: string, port: number}>} normalized entries
 */
export function parseProxyOnlyHosts(raw) {
  const value = typeof raw === 'string' ? raw : '';
  const entries = [];

  for (const entry of value.split(/[,\s]/u)) {
    if (!entry) {
      continue;
    }
    const parsed = entry.match(/^(.+):(\d+)$/u);
    const hostname = (parsed ? parsed[1] : entry).replace(/^\*?\./u, '').toLowerCase();
    if (!hostname || hostname === '*') {
      continue;
    }
    entries.push({
      hostname,
      port: parsed ? Number.parseInt(parsed[2], 10) : 0,
    });
  }

  return entries;
}

/**
 * Whether a request host matches the whitelist. A bare domain matches itself
 * and all subdomains; entries with an explicit port only match that port.
 *
 * @param {string} hostname request hostname (case-insensitive, no port)
 * @param {Array<{hostname: string, port: number}>} entries parsed entries
 * @param {number} [port] effective request port (0 = any/default)
 * @returns {boolean} true when the request should go through the proxy
 */
export function matchesProxyOnlyHost(hostname, entries, port = 0) {
  const host = String(hostname || '').toLowerCase();
  if (!host) {
    return false;
  }

  for (const entry of entries) {
    if (entry.port && entry.port !== port) {
      continue;
    }
    if (host === entry.hostname || host.endsWith(`.${entry.hostname}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the routing-relevant parts of a request origin. Ports are stripped
 * manually (instead of via URL#hostname) so IPv6 brackets survive, matching
 * undici's EnvHttpProxyAgent behavior.
 *
 * @param {string|URL} origin request origin
 * @returns {{protocol: string, hostname: string, port: number}|null}
 */
export function extractOriginHost(origin) {
  try {
    const url = new URL(origin);
    const hostname = url.host.replace(/:\d*$/u, '').toLowerCase();
    const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;
    return { protocol: url.protocol, hostname, port };
  } catch {
    return null;
  }
}

function readEnvProxy(env, names) {
  for (const name of names) {
    const value = typeof env === 'object' && typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) {
      return value;
    }
  }
  return '';
}

/**
 * undici's ProxyAgent only speaks http(s) proxy URIs; anything else (socks5,
 * malformed text) throws at construction time. Reject such values up front so
 * callers get a structured reason instead of an exception.
 */
function isValidHttpProxyUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Create a dispatcher that routes whitelisted hosts through the configured
 * proxy and everything else directly. Built on the same primitives as
 * undici's EnvHttpProxyAgent, but with the match direction inverted.
 *
 * @param {{Dispatcher: Function, Agent: Function, ProxyAgent: Function}} undici undici copy to build on
 * @param {object} options
 * @param {Array<{hostname: string, port: number}>} options.hosts parsed whitelist
 * @param {string} [options.httpProxy] proxy URI for http: requests (direct when empty)
 * @param {string} [options.httpsProxy] proxy URI for https: requests (falls back to httpProxy)
 * @returns {object} the routing dispatcher
 */
export function createProxyOnlyRoutingAgent(undici, options = {}) {
  const entries = Array.isArray(options.hosts) ? options.hosts : [];
  const httpProxy = typeof options.httpProxy === 'string' ? options.httpProxy : '';
  const httpsProxy = typeof options.httpsProxy === 'string' ? options.httpsProxy : '';

  class ProxyOnlyRoutingAgent extends undici.Dispatcher {
    #entries = entries;
    #directAgent = new undici.Agent();
    #httpProxyAgent = httpProxy ? new undici.ProxyAgent({ uri: httpProxy }) : this.#directAgent;
    #httpsProxyAgent = httpsProxy
      ? new undici.ProxyAgent({ uri: httpsProxy })
      : this.#httpProxyAgent;
    #closed = false;
    #destroyed = false;

    dispatch(opts, handler) {
      const origin = extractOriginHost(opts && opts.origin);
      const agent = origin && matchesProxyOnlyHost(origin.hostname, this.#entries, origin.port)
        ? (origin.protocol === 'https:' ? this.#httpsProxyAgent : this.#httpProxyAgent)
        : this.#directAgent;
      return agent.dispatch(opts, handler);
    }

    async #closeChildren() {
      await this.#directAgent.close();
      if (this.#httpProxyAgent !== this.#directAgent) {
        await this.#httpProxyAgent.close();
      }
      if (this.#httpsProxyAgent !== this.#httpProxyAgent) {
        await this.#httpsProxyAgent.close();
      }
    }

    async #destroyChildren(err) {
      await this.#directAgent.destroy(err);
      if (this.#httpProxyAgent !== this.#directAgent) {
        await this.#httpProxyAgent.destroy(err);
      }
      if (this.#httpsProxyAgent !== this.#httpProxyAgent) {
        await this.#httpsProxyAgent.destroy(err);
      }
    }

    // Lifecycle semantics follow undici's DispatcherBase: repeated close /
    // destroy are no-ops, and a callback invocation returns undefined while a
    // callback-less call returns a promise.
    close(callback) {
      if (this.#destroyed || this.#closed) {
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(null, null));
        }
        return undefined;
      }
      this.#closed = true;
      const closed = this.#closeChildren();
      if (typeof callback === 'function') {
        closed.then(() => callback(null, null), (error) => callback(error, null));
        return undefined;
      }
      return closed;
    }

    destroy(err, callback) {
      if (typeof err === 'function') {
        callback = err;
        err = null;
      }
      if (this.#destroyed) {
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(null, null));
        }
        return undefined;
      }
      this.#destroyed = true;
      const destroyed = this.#destroyChildren(err);
      if (typeof callback === 'function') {
        destroyed.then(() => callback(null, null), (error) => callback(error, null));
        return undefined;
      }
      return destroyed;
    }
  }

  return new ProxyOnlyRoutingAgent();
}

let routingDispatcherInstalled = false;

/**
 * Whether the whitelist routing dispatcher was actually installed in this
 * process (not merely configured). pi-sdk-host.mjs uses this so the
 * NODE_USE_ENV_PROXY repair defers only on a successful install — if the
 * routing install failed, the repair still gets its chance.
 */
export function isProxyOnlyRoutingDispatcherInstalled() {
  return routingDispatcherInstalled;
}

function resolveSdkEntryUrl() {
  try {
    return import.meta.resolve('@earendil-works/pi-coding-agent');
  } catch {
    return pathToFileURL(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)), '..', '..',
        'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'
      )
    ).href;
  }
}

let sdkUndici = null;

/**
 * Resolve the undici copy bundled next to the pinned pi-coding-agent SDK.
 * Its setGlobalDispatcher writes both the modern (undici.globalDispatcher.2)
 * and the legacy (undici.globalDispatcher.1) symbols — the latter is what
 * Node's built-in fetch reads — so installing through this copy keeps the
 * routing stable even when other undici graphs load later.
 */
export function resolveSdkUndici() {
  if (sdkUndici) {
    return sdkUndici;
  }
  try {
    const sdkRequire = createRequire(resolveSdkEntryUrl());
    sdkUndici = sdkRequire('undici');
  } catch {
    sdkUndici = null;
  }
  return sdkUndici;
}

/**
 * Install the whitelist routing dispatcher as the process-global dispatcher.
 * No-op (and no global mutation) when PROXY_ONLY_HOSTS is unset/empty, no
 * proxy URL is configured, the proxy URL is not a valid http(s) URI
 * (`invalid_proxy_url`), or undici cannot be resolved (`undici_unavailable`).
 * Idempotent: later calls keep the first install.
 *
 * @param {object} [options]
 * @param {object} [options.env] environment to read (defaults to process.env)
 * @param {object} [options.undici] undici copy to use (defaults to the SDK's)
 * @returns {{installed: boolean, reason?: string, hosts?: Array<{hostname: string, port: number}>}}
 */
export function installProxyOnlyRoutingDispatcher(options = {}) {
  if (routingDispatcherInstalled) {
    return { installed: true, alreadyInstalled: true };
  }

  const env = options.env || process.env;
  const hosts = parseProxyOnlyHosts(env[PROXY_ONLY_HOSTS_ENV]);
  if (hosts.length === 0) {
    return { installed: false, reason: 'disabled' };
  }

  const httpProxy = readEnvProxy(env, ['http_proxy', 'HTTP_PROXY']);
  const httpsProxy = readEnvProxy(env, ['https_proxy', 'HTTPS_PROXY']);
  if (!httpProxy && !httpsProxy) {
    return { installed: false, reason: 'no_proxy_url' };
  }
  if ((httpProxy && !isValidHttpProxyUrl(httpProxy)) || (httpsProxy && !isValidHttpProxyUrl(httpsProxy))) {
    return { installed: false, reason: 'invalid_proxy_url' };
  }

  const undici = options.undici || resolveSdkUndici();
  if (
    !undici
    || typeof undici.Dispatcher !== 'function'
    || typeof undici.Agent !== 'function'
    || typeof undici.ProxyAgent !== 'function'
    || typeof undici.setGlobalDispatcher !== 'function'
  ) {
    return { installed: false, reason: 'undici_unavailable' };
  }

  try {
    undici.setGlobalDispatcher(
      createProxyOnlyRoutingAgent(undici, {
        hosts,
        httpProxy,
        httpsProxy,
      })
    );
  } catch {
    return { installed: false, reason: 'invalid_proxy_url' };
  }
  routingDispatcherInstalled = true;
  return { installed: true, hosts };
}
