const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createHttpError } = require('../../build/server/http/http-errors');
const { readRequestJson } = require('../../build/server/http/request-body');
const { buildErrorJsonPayload } = require('../../build/server/http/response');

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

test('buildErrorJsonPayload keeps allowed http error details only', () => {
  const error = createHttpError(400, 'Validation failed', {
    issues: [{ code: 'bad_input', severity: 'error', path: 'payload.name', message: 'name is required' }],
    caseSchemaStatus: 'invalid',
    derivedFromLegacy: true,
    references: [{ type: 'agent', id: 'agent-1' }],
    debug: { secret: 'should-not-leak' },
  });

  assert.deepEqual(buildErrorJsonPayload(error), {
    error: 'Validation failed',
    issues: [{ code: 'bad_input', severity: 'error', path: 'payload.name', message: 'name is required' }],
    caseSchemaStatus: 'invalid',
    derivedFromLegacy: true,
    references: [{ type: 'agent', id: 'agent-1' }],
  });
});

test('buildErrorJsonPayload drops enumerable fields from generic errors and survives circular details', () => {
  const genericError = new Error('boom');
  genericError.sessionPath = '/tmp/private/session.jsonl';
  genericError.runId = 42;

  assert.deepEqual(buildErrorJsonPayload(genericError), {
    error: 'boom',
  });

  const circular = { id: 'ref-1' };
  circular.self = circular;
  const httpError = createHttpError(409, 'Still referenced', {
    references: [circular],
  });

  assert.deepEqual(buildErrorJsonPayload(httpError), {
    error: 'Still referenced',
    references: [{ id: 'ref-1', self: '[Circular]' }],
  });
});
