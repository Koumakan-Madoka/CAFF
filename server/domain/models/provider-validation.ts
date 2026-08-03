import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_BODY_LIMIT = 64 * 1024;

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export class ProviderValidationError extends Error {
  code: string;
  path: string;

  constructor(code: string, path: string) {
    super(code);
    this.name = 'ProviderValidationError';
    this.code = code;
    this.path = path;
  }
}

function normalizePositiveInteger(value: any, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), maximum);
}

function ipv4ToNumber(address: string) {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function matchesIpv4Cidr(value: number, base: string, prefixLength: number) {
  const baseValue = ipv4ToNumber(base);
  if (baseValue === null) {
    return false;
  }

  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isPublicIpv4(address: string) {
  const value = ipv4ToNumber(address);
  if (value === null) {
    return false;
  }

  const forbidden = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as Array<[string, number]>;

  return !forbidden.some(([base, prefixLength]) => matchesIpv4Cidr(value, base, prefixLength));
}

function expandIpv6(address: string) {
  const normalized = address.toLowerCase().split('%')[0];
  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }

  function parseHalf(value: string) {
    if (!value) {
      return [] as number[];
    }

    const parts = value.split(':');
    const result: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const ipv4 = ipv4ToNumber(part);
        if (ipv4 === null) {
          return null;
        }
        result.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/u.test(part)) {
        return null;
      }
      result.push(Number.parseInt(part, 16));
    }
    return result;
  }

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if (!left || !right) {
    return null;
  }

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }

  return [...left, ...new Array(missing).fill(0), ...right];
}

function isPublicIpv6(address: string) {
  const groups = expandIpv6(address);
  if (!groups || groups.length !== 8) {
    return false;
  }

  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00;
  const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
  const multicast = (groups[0] & 0xff00) === 0xff00;
  const documentation = groups[0] === 0x2001 && groups[1] === 0x0db8;
  if (allZero || loopback || uniqueLocal || linkLocal || multicast || documentation) {
    return false;
  }

  const embeddedIpv4 = groups.slice(0, 5).every((group) => group === 0)
    && (groups[5] === 0 || groups[5] === 0xffff);
  if (embeddedIpv4) {
    const ipv4 = `${groups[6] >>> 8}.${groups[6] & 0xff}.${groups[7] >>> 8}.${groups[7] & 0xff}`;
    return isPublicIpv4(ipv4);
  }

  return true;
}

export function isPublicProviderAddress(address: any) {
  const normalized = String(address || '').trim().split('%')[0];
  const family = net.isIP(normalized);
  if (family === 4) {
    return isPublicIpv4(normalized);
  }
  if (family === 6) {
    return isPublicIpv6(normalized);
  }
  return false;
}

function normalizeResolvedAddresses(addresses: any[]) {
  const normalized: ResolvedAddress[] = [];
  const seen = new Set<string>();

  for (const entry of Array.isArray(addresses) ? addresses : []) {
    const address = String(entry && entry.address ? entry.address : '').trim().split('%')[0];
    const family = net.isIP(address);
    const key = `${family}:${address}`;
    if ((family !== 4 && family !== 6) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ address, family });
  }

  return normalized;
}

function statusClass(statusCode: any) {
  const value = Number(statusCode);
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    return 'other';
  }
  return `${Math.floor(value / 100)}xx`;
}

function createPinnedLookup(hostname: string, addresses: ResolvedAddress[]) {
  return function pinnedLookup(requestedHostname: string, lookupOptions: any, callback?: any) {
    const actualCallback = typeof lookupOptions === 'function' ? lookupOptions : callback;
    const options = typeof lookupOptions === 'object' && lookupOptions ? lookupOptions : {};

    if (typeof actualCallback !== 'function') {
      return;
    }

    if (String(requestedHostname || '').toLowerCase() !== hostname.toLowerCase()) {
      actualCallback(new Error('provider validation lookup hostname mismatch'));
      return;
    }

    if (options.all) {
      actualCallback(null, addresses.map((entry) => ({ ...entry })));
      return;
    }

    const preferred = addresses.find((entry) => !options.family || entry.family === Number(options.family)) || addresses[0];
    actualCallback(null, preferred.address, preferred.family);
  };
}

function defaultRequest(url: URL, options: any, onResponse: any) {
  return url.protocol === 'https:'
    ? https.request(url, options, onResponse)
    : http.request(url, options, onResponse);
}

export async function validateModelProviderConnection(providerId: any, provider: any, dependencies: any = {}) {
  const pathPrefix = `providers.${String(providerId || '').trim() || 'unknown'}`;
  const baseUrl = String(provider && provider.baseUrl ? provider.baseUrl : '').trim();
  let url: URL;

  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderValidationError('provider_validation_url_invalid', `${pathPrefix}.baseUrl`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderValidationError('provider_validation_scheme_invalid', `${pathPrefix}.baseUrl`);
  }

  if (url.username || url.password) {
    throw new ProviderValidationError('provider_validation_userinfo_forbidden', `${pathPrefix}.baseUrl`);
  }

  const rawHostname = url.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  if (!hostname) {
    throw new ProviderValidationError('provider_validation_url_invalid', `${pathPrefix}.baseUrl`);
  }

  const resolveHostname = typeof dependencies.resolveHostname === 'function'
    ? dependencies.resolveHostname
    : (value: string) => dns.promises.lookup(value, { all: true, verbatim: true });
  let addresses: ResolvedAddress[];

  try {
    addresses = net.isIP(hostname)
      ? normalizeResolvedAddresses([{ address: hostname }])
      : normalizeResolvedAddresses(await resolveHostname(hostname));
  } catch {
    return { ok: false, status: 'network_error', httpStatusClass: null };
  }

  if (addresses.length === 0 || addresses.some((entry) => !isPublicProviderAddress(entry.address))) {
    throw new ProviderValidationError('provider_validation_address_forbidden', `${pathPrefix}.baseUrl`);
  }

  const request = typeof dependencies.request === 'function' ? dependencies.request : defaultRequest;
  const timeoutMs = normalizePositiveInteger(dependencies.timeoutMs, DEFAULT_TIMEOUT_MS, 5000);
  const bodyLimit = normalizePositiveInteger(dependencies.bodyLimit, DEFAULT_BODY_LIMIT, 1024 * 1024);
  const lookup = createPinnedLookup(hostname, addresses);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let responseClass: string | null = null;

    function finish(result: any) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    let req: any;
    try {
      req = request(url, {
        agent: false,
        headers: {
          Accept: 'application/json',
        },
        lookup,
        maxRedirects: 0,
        method: 'GET',
      }, (res: any) => {
        responseClass = statusClass(res && res.statusCode);
        let received = 0;
        let tooLarge = false;

        res.on('data', (chunk: any) => {
          if (tooLarge || settled) {
            return;
          }
          received += Buffer.byteLength(chunk);
          if (received > bodyLimit) {
            tooLarge = true;
            finish({ ok: false, status: 'response_too_large', httpStatusClass: responseClass });
            if (typeof res.destroy === 'function') {
              res.destroy();
            }
          }
        });
        res.on('end', () => {
          if (tooLarge) {
            return;
          }

          if (responseClass === '3xx') {
            finish({ ok: false, status: 'redirect', httpStatusClass: responseClass });
            return;
          }

          finish({ ok: true, status: 'reachable', httpStatusClass: responseClass });
        });
        res.on('error', () => {
          if (!tooLarge) {
            finish({ ok: false, status: 'network_error', httpStatusClass: responseClass });
          }
        });
      });
    } catch {
      finish({ ok: false, status: 'network_error', httpStatusClass: null });
      return;
    }

    req.on('error', () => {
      finish({
        ok: false,
        status: timedOut ? 'timeout' : 'network_error',
        httpStatusClass: responseClass,
      });
    });
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error('provider validation timeout'));
    });
    req.end();
  });
}
