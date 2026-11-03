// Bounded replay I/O. JSON hashing preserves JSON.stringify byte identity;
// safety scanning never concatenates variants, files, archives or blobs.
const fs = require('node:fs'), crypto = require('node:crypto');
const CHUNK_SIZE = 64 * 1024;
function blockSize(n) { if (!Number.isSafeInteger(n) || n < 4 || n > 1024 * 1024) throw Error('replay_chunk_size_invalid'); return n; }
function* jsonChunks(value, chunkSize = CHUNK_SIZE) {
  blockSize(chunkSize);
  const ancestors = new Set();
  function* encode(v, key = '') {
    if (v && typeof v.toJSON === 'function') v = v.toJSON(key);
    if (typeof v === 'string') {
      yield '"';
      for (let i = 0; i < v.length;) {
        let end = Math.min(i + chunkSize, v.length);
        // Never split a UTF16 surrogate pair: native stringify preserves pairs
        // but escapes lone surrogates. Hash updates must preserve this too.
        if (end < v.length && /[\uD800-\uDBFF]/.test(v[end - 1]) && /[\uDC00-\uDFFF]/.test(v[end])) end--;
        yield JSON.stringify(v.slice(i, end)).slice(1, -1); i = end;
      }
      yield '"'; return;
    }
    if (v === null || typeof v !== 'object') { yield JSON.stringify(v); return; }
    if (ancestors.has(v)) throw new TypeError('Circular JSON'); ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        yield '[';
        for (let i = 0; i < v.length; i++) { if (i) yield ','; const item = v[i]; yield* encode(item === undefined || typeof item === 'function' || typeof item === 'symbol' ? null : item, String(i)); }
        yield ']';
      } else {
        yield '{'; let first = true;
        for (const k of Object.keys(v)) {
          const item = v[k]; if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
          if (!first) yield ','; first = false; yield* encode(k); yield ':'; yield* encode(item, k);
        }
        yield '}';
      }
    } finally { ancestors.delete(v); }
  }
  yield* encode(value);
}
function hashJson(value, size) {
  const hash = crypto.createHash('sha256'); for (const chunk of jsonChunks(value, size)) if (chunk !== undefined) hash.update(chunk); return hash.digest('hex');
}
function* fileChunks(file, chunkSize = CHUNK_SIZE) {
  blockSize(chunkSize);
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('replay_file_invalid');
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile()) throw Error('replay_file_invalid');
    const buffer = Buffer.allocUnsafe(chunkSize); let offset = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, offset))) { offset += n; yield buffer.subarray(0, n); }
    if (offset !== stat.size || fs.fstatSync(fd).size !== stat.size) throw Error('replay_file_changed');
  } finally { fs.closeSync(fd); }
}
function hashFile(file) { const hash = crypto.createHash('sha256'); for (const bytes of fileChunks(file)) hash.update(bytes); return hash.digest('hex'); }
function writeChunks(file, chunks) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { for (const chunk of chunks) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); let offset = 0; while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset); } }
  finally { fs.closeSync(fd); }
}
function* bufferChunks(bytes, size = CHUNK_SIZE) { blockSize(size); for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size); }
function* base64Chunks(text, size = CHUNK_SIZE) {
  blockSize(size); const chars = Math.floor(size / 4) * 4;
  for (let i = 0; i < text.length; i += chars) yield Buffer.from(text.slice(i, i + chars), 'base64');
}
function createKnownValueScanner(values, { chunkSize = CHUNK_SIZE } = {}) {
  blockSize(chunkSize);
  const needles = [...new Set(values.filter(v => typeof v === 'string' && v).flatMap(v => [v, JSON.stringify(v).slice(1, -1), Buffer.from(v).toString('base64')]))].map(v => Buffer.from(v));
  // Full longest spelling (in bytes), including escaped/base64 variants. A key
  // can span multiple short chunks; carry is bounded independently of input.
  const overlap = Math.max(0, ...needles.map(n => n.length));
  function chunks(input) {
    if (!needles.length) return false;
    let tail = Buffer.alloc(0);
    for (const part of input) {
      if (part === undefined) continue;
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      const window = tail.length ? Buffer.concat([tail, bytes]) : bytes;
      if (needles.some(n => window.includes(n))) return true;
      tail = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    }
    return false;
  }
  function* textChunks(text) {
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + chunkSize, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
      yield text.slice(i, end); i = end;
    }
  }
  function fields(v) {
    if (typeof v === 'string') return chunks(textChunks(v));
    if (Buffer.isBuffer(v)) return chunks(bufferChunks(v, chunkSize));
    if (!v || typeof v !== 'object') return false;
    return Object.keys(v).some(k => chunks(textChunks(k)) || fields(v[k]));
  }
  return { chunks, value: v => chunks(jsonChunks(v, chunkSize)) || fields(v), bytes: b => chunks(bufferChunks(b, chunkSize)),
    base64: text => chunks(base64Chunks(text, chunkSize)), file: file => chunks(fileChunks(file, chunkSize)) };
}
module.exports = { CHUNK_SIZE, jsonChunks, hashJson, fileChunks, hashFile, writeChunks, bufferChunks, base64Chunks, createKnownValueScanner };
