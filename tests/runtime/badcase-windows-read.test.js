// Native NT tests are required on Windows, not replaced by Linux fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Windows NTFS constrained-read primitive (real native handles)', {
  skip: process.platform !== 'win32' ? 'real Windows NTFS required' : false,
  timeout: 30000,
}, () => {
  const script = path.join(__dirname, 'badcase-windows-read.test.py');
  const run = spawnSync('python', ['-B', script], {
    encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /Ran 7 tests/);
  assert.match(run.stderr, /\nOK\s*$/);
  assert.doesNotMatch(run.stderr, /skipped=/);
});
