const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  WINDOWS_HELPER_SOURCE, WINDOWS_HELPER_SOURCE_SHA256,
} = require('../../build/server/domain/runtime/badcase-capture/windows-helper-source');
const {
  encodeWindowsHelperRequest: encode, parseWindowsHelperResponse: parse, invokeWindowsHelper: invoke,
  WINDOWS_HELPER_LIMITS: limits,
} = require('../../build/server/domain/runtime/badcase-capture/windows-helper');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const identity = { volumeSerial: '18446744073709551615', fileId: 'a'.repeat(32), creationTime: '9223372036854775807' };
const content = Buffer.from([0, 255, 10, 13, 0]);
function fixture() {
  const request = { version: 1, op: 'capture', root: 'C:/authorized', expected: { ...identity }, excluded: ['private'], paths: ['sub/a', 'sub/empty'] };
  const entry = (p, type, size) => ({ path: p, type, size, identity: { ...identity }, lastWriteTime: '-9223372036854775808', changeTime: '0' });
  const header = { version: 1, ok: true, identity: { ...identity },
    entries: [entry('huge-unread', 'file', '9007199254740993'), entry('sub', 'directory', '0'),
      entry('sub/a', 'file', '5'), entry('sub/empty', 'file', '0'),
      entry('\ue000', 'file', '0'), entry('😀', 'file', '0')],
    files: [
      { path: 'sub/a', size: '5', sha256: sha(content), identity: { ...identity } },
      { path: 'sub/empty', size: '0', sha256: sha(Buffer.alloc(0)), identity: { ...identity } },
    ],
  };
  return { request, header };
}
function wire(h, body = content) {
  return Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), body]);
}
function invalid(result) {
  assert.deepEqual(result, { ok: false, reason: 'helper_output_invalid' });
}

test('Windows embedded helper source is exact LF-normalized audited source', () => {
  const original = fs.readFileSync(path.join(__dirname, '../../helpers/badcase-capture/windows_read.py'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(WINDOWS_HELPER_SOURCE, original);
  assert.equal(WINDOWS_HELPER_SOURCE_SHA256, sha(Buffer.from(original)));
});

test('Windows wire encoding validates closed schema, exact identities and bounded paths', () => {
  const { request } = fixture();
  assert.deepEqual(JSON.parse(encode(request)), request);
  assert.ok(encode({ version: 1, op: 'identity', root: 'C:/' }));
  const changes = [
    { version: true }, { op: 'read' }, { extra: 'x' }, { root: '\\\\host\\share' },
    { root: 'C:relative' }, { root: 'C:/sub/..' }, { expected: null },
    { expected: { ...identity, volumeSerial: 123 } },
    { expected: { ...identity, volumeSerial: '18446744073709551616' } },
    { expected: { ...identity, creationTime: '9223372036854775808' } },
    { expected: { ...identity, creationTime: '-9223372036854775809' } },
    { expected: { ...identity, fileId: 'A'.repeat(32) } },
    { excluded: 'private' }, { excluded: ['x/**'] }, { excluded: Array(257).fill('x') },
    { paths: ['x', 'x'] }, { paths: Array(2049).fill('x') },
    ...['', '..', 'x//y', 'x\\y', 'x:y', 'x.', 'x ', 'NUL', 'COM¹', '\ud800', 'x'.repeat(256)].map(p => ({ paths: [p] })),
  ];
  for (const changeset of changes) assert.equal(encode({ ...request, ...changeset }), null, JSON.stringify(changeset));
  assert.ok(encode({ ...request, paths: Array.from({ length: 2048 }, (_, i) => `x${i}`) }));
  const long = Array.from({ length: 2048 }, (_, i) => `${i}/${'a'.repeat(250)}/${'b'.repeat(250)}/${'c'.repeat(250)}`);
  assert.equal(encode({ ...request, paths: long }), null, 'overall 1 MiB cap, independently of path count');
});

test('Windows response parser preserves binary bodies, empty files and 64-bit strings', () => {
  const { request, header } = fixture();
  const output = parse(wire(header), request);
  assert.equal(output.ok, true);
  assert.deepEqual(output.identity, identity);
  assert.deepEqual(output.entries, header.entries);
  assert.deepEqual(output.files[0].content, content);
  assert.deepEqual(output.files[1].content, Buffer.alloc(0));
  assert.equal(output.entries[0].size, '9007199254740993');
  const query = { version: 1, op: 'identity', root: 'C:/' };
  assert.deepEqual(parse(wire({ version: 1, ok: true, identity }, Buffer.alloc(0)), query), { ok: true, identity });
  invalid(parse(wire({ version: 1, ok: true, identity }), query));
});

test('Windows response parser refuses corrupt framing without partial file exposure', () => {
  const { request, header } = fixture();
  for (const body of [content.subarray(0, 4), Buffer.concat([content, Buffer.from('x')]), Buffer.from('wrong')]) {
    invalid(parse(wire(header, body), request));
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from('{}'), Buffer.from([255, 10]), Buffer.from('null\n'),
    Buffer.from('[]\n'), Buffer.from('{"version":1,"ok":true}\n'), Buffer.alloc(limits.headerBytes + 1, 32)]) invalid(parse(bytes, request));
  invalid(parse(wire(header).toString('utf8'), request));
  invalid(parse(wire(header), { ...request, version: 2 }));
});

test('Windows response schema and manifest checks reject malformed or mismatched fields', () => {
  const { request } = fixture();
  const mutations = [
    h => { h.extra = 'x'; }, h => { h.version = true; }, h => { h.ok = 1; },
    h => { h.identity.fileId = 'b'.repeat(32); }, h => { h.identity.volumeSerial = 1; },
    h => { h.entries = null; }, h => { h.files = []; }, h => { h.entries.reverse(); },
    h => { h.entries.splice(1, 1); }, h => { h.entries.splice(1, 0, h.entries[0]); },
    h => { h.entries[0].size = 1; }, h => { h.entries[0].size = '01'; },
    h => { h.entries[0].size = '9223372036854775808'; },
    h => { h.entries[0].changeTime = '-9223372036854775809'; },
    h => { h.entries[0].lastWriteTime = 'NaN'; }, h => { h.entries[0].identity.fileId = 'X'.repeat(32); },
    h => { h.entries[0].identity.volumeSerial = '1'; }, h => { h.entries[0].path = '../escape'; },
    h => { h.entries[0].type = 'symlink'; }, h => { h.entries[1].size = '1'; },
    h => { h.entries[1].type = 'file'; }, h => { h.entries[0].extra = 'x'; },
    h => { h.files[0].path = 'sub/other'; }, h => { h.files[0].size = '4'; },
    h => { h.files[0].size = String(limits.fileBytes + 1); h.entries[2].size = h.files[0].size; },
    h => { h.files[0].identity.creationTime = '1'; }, h => { h.files[0].extra = 'x'; },
    h => { h.files[0].sha256 = 'f'.repeat(64); }, h => { delete h.files[0].sha256; },
  ];
  for (const change of mutations) {
    const { header } = fixture();
    change(header);
    invalid(parse(wire(header), request));
  }
  const { header } = fixture();
  header.entries = Array(limits.entries + 1).fill(header.entries[0]);
  invalid(parse(wire(header), request));
});

function isolatedTransport({ replace = s => s, platform = 'win32', child, disk } = {}) {
  // Test-only VM fixture, no runtime injection seam. Exercise real transport
  // code with synthetic process outcomes and reduced allocation limits.
  const vm = require('node:vm');
  const file = path.join(__dirname, '../../build/server/domain/runtime/badcase-capture/windows-helper.js');
  const localRequire = require('node:module').createRequire(file);
  const exports = {};
  vm.runInNewContext(replace(fs.readFileSync(file, 'utf8')), {
    exports, module: { exports }, Buffer, process: { platform },
    require: name => name === 'node:child_process' && child ? child
      : name === 'node:fs' && disk ? disk : localRequire(name),
  }, { filename: file });
  return exports;
}

test('Windows output byte limits use exact boundaries (small test-only VM limits)', () => {
  const { request, header } = fixture();
  const bytes = wire(header), n = Buffer.byteLength(JSON.stringify(header));
  assert.equal(limits.headerBytes, 32 * 1024 * 1024);
  assert.equal(limits.bodyBytes, 128 * 1024 * 1024);
  assert.equal(limits.fileBytes, 64 * 1024 * 1024);
  for (const [name, original, boundary] of [
    ['headerBytes', '32 * 1024 * 1024', n], ['bodyBytes', '128 * 1024 * 1024', content.length],
    ['fileBytes', '64 * 1024 * 1024', content.length],
  ]) {
    for (const [value, expected] of [[boundary, true], [boundary - 1, false]]) {
      const api = isolatedTransport({ replace: src => {
        const old = `${name}: ${original}`;
        assert.ok(src.includes(old));
        return src.replace(old, `${name}: ${value}`);
      } });
      assert.equal(api.parseWindowsHelperResponse(bytes, request).ok, expected, `${name}:${value}`);
    }
  }
});

test('Windows process boundary verifies source, sends pins only on stdin and discards bad process output', () => {
  const { request, header } = fixture();
  const good = { status: 0, stdout: wire(header), stderr: Buffer.alloc(0) };
  let calls = 0;
  const disk = { statSync: () => ({ size: Buffer.byteLength(WINDOWS_HELPER_SOURCE) }),
    readFileSync: () => Buffer.from(WINDOWS_HELPER_SOURCE) };
  const run = result => isolatedTransport({ disk, child: { spawnSync(python, args, options) {
    calls++;
    assert.equal(python, 'chosen-python');
    assert.deepEqual(Array.from(args), ['-I', '-B', 'trusted-helper.py']);
    assert.deepEqual(JSON.parse(options.input), request);
    assert.equal(options.timeout, limits.timeoutMs);
    assert.equal(options.windowsHide, true);
    assert.equal(options.maxBuffer, limits.headerBytes + limits.bodyBytes + 1);
    return result;
  } } }).invokeWindowsHelper('chosen-python', 'trusted-helper.py', request);
  assert.equal(run(good).ok, true);
  for (const result of [{ ...good, error: { code: 'ETIMEDOUT' } }, { ...good, status: 1 },
    { ...good, status: null }, { ...good, stderr: Buffer.from('PRIVATE_SENTINEL') },
    { ...good, stdout: Buffer.from('PRIVATE_SENTINEL') }]) {
    const output = run(result);
    assert.equal(output.ok, false);
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_SENTINEL/);
  }
  assert.equal(calls, 6);
  const child = { spawnSync() { throw new Error('must not spawn'); } };
  assert.equal(isolatedTransport({ disk, child }).invokeWindowsHelper('python', 'helper', {}).reason, 'request_invalid');
  assert.equal(isolatedTransport({ child, disk: { ...disk, readFileSync: () => Buffer.from('changed') } })
    .invokeWindowsHelper('python', 'helper', request).reason, 'helper_integrity_failed');
  assert.equal(isolatedTransport({ child, disk: { ...disk, statSync: () => ({ size: 1024 * 1024 + 1 }) } })
    .invokeWindowsHelper('python', 'helper', request).reason, 'helper_integrity_failed');
  assert.equal(isolatedTransport({ platform: 'linux', child, disk: { statSync() { throw new Error('must not touch'); } } })
    .invokeWindowsHelper('python', 'helper', request).reason, 'windows_required');
});

test('Windows identity operations have a separate bounded management timeout', () => {
  const request = { version: 1, op: 'identity', root: 'C:/authorized' };
  const api = isolatedTransport({
    disk: { statSync: () => ({ size: Buffer.byteLength(WINDOWS_HELPER_SOURCE) }), readFileSync: () => Buffer.from(WINDOWS_HELPER_SOURCE) },
    child: { spawnSync(python, args, options) {
      assert.equal(options.timeout, 10000);
      assert.equal(options.timeout, limits.identityTimeoutMs);
      assert.deepEqual(JSON.parse(options.input), request);
      return { status: 0, stdout: wire({ version: 1, ok: true, identity }, Buffer.alloc(0)), stderr: Buffer.alloc(0) };
    } },
  });
  assert.equal(api.invokeWindowsHelper('python', 'helper', request).ok, true);
});

test('Windows snapshot/classification operations each use a bounded 25-second synchronous timeout', () => {
  let timeout, sent;
  const request = { version: 1, op: 'snapshot', root: 'C:/authorized', expected: identity, excluded: [] };
  const api = isolatedTransport({
    disk: { statSync: () => ({ size: Buffer.byteLength(WINDOWS_HELPER_SOURCE) }), readFileSync: () => Buffer.from(WINDOWS_HELPER_SOURCE) },
    child: { spawnSync(python, args, options) {
      timeout = options.timeout; sent = JSON.parse(options.input);
      return { status: 0, stdout: wire({ version: 1, ok: true, identity, entries: [], files: [] }, Buffer.alloc(0)), stderr: Buffer.alloc(0) };
    } },
  });
  for (const op of ['snapshot', 'gitMetadata', 'selectedSnapshot']) {
    const value = { ...request, op, ...(op === 'selectedSnapshot' ? { paths: [] } : {}) };
    assert.equal(api.invokeWindowsHelper('python', 'helper', value).ok, true);
    assert.equal(timeout, 25000); assert.deepEqual(sent, value);
  }
});

test('Windows helper refusals use fixed closed reason strings and never bodies', () => {
  const { request } = fixture();
  for (const code of ['root_identity_mismatch', 'path_not_in_manifest', 'helper_failed', 'changed_during_read']) {
    assert.deepEqual(parse(wire({ version: 1, ok: false, code }, Buffer.alloc(0)), request), { ok: false, reason: code });
  }
  for (const header of [{ version: 1, ok: false, code: 'PRIVATE_SENTINEL' },
    { version: 1, ok: false, code: 'helper_failed', extra: 'x' }]) invalid(parse(wire(header, Buffer.alloc(0)), request));
  invalid(parse(wire({ version: 1, ok: false, code: 'helper_failed' }), request));
});

test('Windows native embedded-helper transport: pinned tree, binary bytes and replaced root', {
  skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false,
}, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-winwire-'));
  try {
    const helper = path.join(base, 'helper.py');
    const root = path.join(base, 'authorized');
    fs.writeFileSync(helper, WINDOWS_HELPER_SOURCE, 'utf8');
    fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub/a'), content);
    fs.writeFileSync(path.join(root, 'sub/empty'), '');
    fs.mkdirSync(path.join(root, 'Private'));
    fs.writeFileSync(path.join(root, 'Private/secret'), 'PRIVATE_SENTINEL');
    const pin = invoke('python', helper, { version: 1, op: 'identity', root });
    assert.equal(pin.ok, true);
    const request = { version: 1, op: 'capture', root, expected: pin.identity, excluded: ['private'], paths: ['sub/a', 'sub/empty'] };
    const result = invoke('python', helper, request);
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries.map(e => e.path), ['sub', 'sub/a', 'sub/empty']);
    assert.deepEqual(result.files.map(f => f.content), [content, Buffer.alloc(0)]);
    assert.deepEqual(invoke('python', helper, { ...request, paths: ['PRIVATE/secret'] }), { ok: false, reason: 'path_not_in_manifest' });
    assert.deepEqual(invoke('python', helper, { ...request, paths: ['SUB/a'] }), { ok: false, reason: 'path_not_in_manifest' });
    fs.renameSync(root, path.join(base, 'old'));
    fs.mkdirSync(root);
    assert.deepEqual(invoke('python', helper, request), { ok: false, reason: 'root_identity_mismatch' });
    fs.appendFileSync(helper, '\n# changed\n');
    assert.deepEqual(invoke('python', helper, request), { ok: false, reason: 'helper_integrity_failed' });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
