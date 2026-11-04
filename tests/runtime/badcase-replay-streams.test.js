// Streaming safety primitives: only synthetic data; no models or host secrets.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { jsonChunks, hashJson, createKnownValueScanner, fileChunks, hashFile, writeChunks } = require('../../scripts/badcase-capture/replay-streams.cjs');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
test('incremental JSON preserves exact native serialization and digest, including boundary surrogates', () => {
  for (const value of [null, [1, undefined, NaN, , Infinity], { omit: undefined, a: 'x'.repeat(15) + '😀\ud800\n"\\', b: 2 }, { buf: Buffer.from('bytes') }, { n: new Date(0) }]) {
    const expected = JSON.stringify(value);
    assert.equal([...jsonChunks(value, 16)].join(''), expected);
    assert.equal(hashJson(value, 16), hash(expected));
  }
  const circular = {}; circular.self = circular;
  assert.throws(() => [...jsonChunks(circular)], TypeError);
  assert.throws(() => [...jsonChunks(1n)], TypeError);
});
test('scanner detects raw/escaped/base64 values and UTF8 keys spanning exactly one block boundary', () => {
  const value = 'synthetic-密钥-"\\\n-marker', scan = createKnownValueScanner([value], { chunkSize: 16 });
  for (const spelling of [value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString('base64')]) {
    const bytes = Buffer.from('x'.repeat(15) + spelling + 'tail');
    assert.equal(scan.bytes(bytes), true);
    assert.equal(scan.value({ file: bytes.toString('utf8') }), true);
    assert.equal(scan.base64(bytes.toString('base64')), true);
  }
  assert.equal(scan.bytes(Buffer.from('safe')), false);
  assert.equal(scan.chunks([Buffer.from(value.slice(0, 4)), Buffer.from(value.slice(4))]), true);
  assert.equal(scan.value({ [value]: 'safe' }), true);
  assert.equal(scan.value({ safe: ['no match'] }), false);
  assert.equal(createKnownValueScanner(['']).value({ a: 'safe' }), false);
});
test('file scanner and hash read fixed-size blocks, and never readFile the whole artifact', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-stream-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'source'), copy = path.join(root, 'copy'), key = 'synthetic-file-boundary-marker';
  const bytes = Buffer.from('x'.repeat(31) + key + 'end'); fs.writeFileSync(file, bytes);
  const scan = createKnownValueScanner([key], { chunkSize: 32 });
  assert.equal(scan.file(file), true); assert.equal(hashFile(file), hash(bytes));
  assert.ok([...fileChunks(file, 16)].every(b => b.length <= 16));
  writeChunks(copy, fileChunks(file, 16)); assert.deepEqual(fs.readFileSync(copy), bytes);
  assert.throws(() => writeChunks(copy, []), /EEXIST/);
});
