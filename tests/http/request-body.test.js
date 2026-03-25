const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { readRequestJson } = require('../../server/http/request-body');

test('readRequestJson parses JSON request bodies', async () => {
  const req = new PassThrough();
  const promise = readRequestJson(req);

  req.end(JSON.stringify({ ok: true, count: 2 }));

  const result = await promise;
  assert.deepEqual(result, { ok: true, count: 2 });
});

test('readRequestJson rejects oversized bodies', async () => {
  const req = new PassThrough();
  const promise = readRequestJson(req, { bodyLimit: 8 });

  req.end('{"too":"large"}');

  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, 413);
    return true;
  });
});
