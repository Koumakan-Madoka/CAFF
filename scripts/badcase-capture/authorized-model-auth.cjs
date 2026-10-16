// Explicit local, nonproduction model-key reuse. No default discovery, CAFF DB,
// auth.json/OAuth, command execution, environment expansion or file writes.
// The operator's purpose declaration is NOT machine proof of key provenance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { httpsExchangeEndpoint } = require('../../build/server/domain/runtime/badcase-capture/https-exchange');
const { modelIdentifier } = require('../../build/server/domain/runtime/badcase-capture/model-identifier');
const { detectApiKeyMode } = require('../../build/server/domain/models/model-provider-config');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => object(v) && Object.hasOwn(v, k) ? v[k] : undefined;
const same = (a, b) => a.isFile() && b.isFile() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
const fail = () => { throw Error('model_auth_reuse_failed'); };
function readSource(file) {
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 2n || before.size > 1048576n) fail();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail();
    const bytes = Buffer.alloc(Number(before.size) + 1); let n = 0;
    while (n < bytes.length) { const got = fs.readSync(fd, bytes, n, bytes.length - n, n); if (!got) break; n += got; }
    if (n !== Number(before.size) || !same(before, fs.fstatSync(fd, { bigint: true }))
      || !same(before, fs.lstatSync(file, { bigint: true }))) fail();
    const value = bytes.subarray(0, n), text = value.toString('utf8');
    if (!Buffer.from(text).equals(value)) fail();
    return { document: JSON.parse(text.replace(/^\uFEFF/, '')), checksum: hash(value) };
  } catch { fail(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function createAuthorizedModelCredential(input) {
  try {
    if (!object(input) || Object.keys(input).sort().join('|') !== ['file', 'provider', 'model', 'endpoint', 'confirmedNonProduction'].sort().join('|')
      || input.confirmedNonProduction !== true || typeof input.file !== 'string' || !path.isAbsolute(input.file)
      || typeof input.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.provider) || !modelIdentifier(input.model)) fail();
    // Copy all caller-owned selection values. Never trust later mutation.
    const file = path.resolve(input.file), provider = input.provider, model = input.model;
    const { endpoint, endpointHash } = httpsExchangeEndpoint(input.endpoint);
    const declaration = Object.freeze({ kind: 'explicit-nonproduction-model-auth-reuse-v1', provider, model, endpointHash,
      sourcePathHash: hash(file), confirmedNonProduction: true });
    let checksum;
    return { declaration, credential(scope) {
      try {
        if (scope !== endpointHash) fail(); // before reading any source, including wrong-endpoint failures
        const source = readSource(file);
        if (checksum !== undefined && source.checksum !== checksum) fail();
        const p = own(own(source.document, 'providers'), provider);
        if (!object(p) || !Array.isArray(p.models)) fail();
        const matches = p.models.filter(m => own(m, 'id') === model);
        if (matches.length !== 1) fail();
        const m = matches[0];
        for (const entry of [p, m]) {
          if (Object.hasOwn(entry, 'headers') && (!object(entry.headers) || Object.keys(entry.headers).length !== 0)) fail();
        }
        if ((m.api || p.api) !== 'openai-completions' || detectApiKeyMode(p.apiKey) !== 'literal') fail();
        const url = new URL(m.baseUrl || p.baseUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
          || url.hostname !== endpoint.hostname || url.pathname.replace(/\/$/, '') + '/chat/completions' !== endpoint.path) fail();
        const key = p.apiKey;
        if (typeof key !== 'string' || key.length > 4096 || !/^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(key)) fail();
        checksum = source.checksum; // in-memory only; no secret/source-content hash is persisted
        return { value: key, expiresAt: Date.now() + 30000 };
      } catch { fail(); }
    } };
  } catch { fail(); }
}
module.exports = { createAuthorizedModelCredential };
