const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const test = require('node:test');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');
const { authenticateApiRequest } = require('../../build/server/http/planner-authentication');

function request(headers = {}, rawHeaders) {
  return { method: 'POST', headers, rawHeaders: rawHeaders || Object.entries(headers).flat() };
}
function fixture() {
  const token = randomBytes(32).toString('base64url');
  const credential = createInMemoryPlannerCredential({ token, plannerName: 'Test Planner' });
  credential.initialize();
  return { token, credential };
}

test('planner intent cannot downgrade to user on missing, wrong, malformed or duplicate credentials', () => {
  const { token, credential } = fixture();
  const invalid = [
    request({ 'x-caff-principal': 'planner' }), request({ authorization: '' }),
    request({ authorization: 'Basic abc' }), request({ authorization: 'Bearer ' + 'z'.repeat(43) }),
    request({ authorization: 'Bearer ' + token + ', Bearer ' + token }),
    request({ authorization: ['Bearer ' + token] }),
    request({ authorization: 'Bearer ' + token }, ['Authorization', 'Bearer ' + token, 'Authorization', 'Bearer ' + token]),
    request({ authorization: 'Bearer ' + token, 'x-caff-principal': 'user' }),
  ];
  for (const req of invalid) {
    req.headers['x-caff-csrf-token'] = 'a-valid-browser-token-does-not-rescue-planner-intent';
    assert.throws(() => authenticateApiRequest(req, '/api/conversations', credential),
      error => error.statusCode === 401 && error.code === 'planner_credential_invalid');
  }
  assert.throws(() => authenticateApiRequest(request(), '/api/planner/portfolio', credential), error => error.statusCode === 401);
  assert.deepEqual(authenticateApiRequest(request(), '/api/conversations', credential), { kind: 'user' });
  assert.deepEqual(authenticateApiRequest(request({ authorization: 'Bearer ' + token }), '/api/conversations', credential),
    { kind: 'planner', plannerId: 'local-planner', plannerName: 'Test Planner' });
});

test('native agent/Feishu trust domains never gain user/planner authority from a bearer', () => {
  const { token, credential } = fixture();
  for (const pathname of ['/api/agent-tools/goal', '/api/integrations/feishu/webhook']) {
    assert.equal(authenticateApiRequest(request({ authorization: 'Bearer ' + token }), pathname, credential), null);
    assert.throws(() => authenticateApiRequest(request({ authorization: 'Bearer ' + token, 'x-caff-principal': 'planner' }), pathname, credential),
      error => error.statusCode === 401);
  }
});

test('HTTP missing/wrong/malformed planner credentials reject before body processing and all writes', async (t) => {
  const { token, credential } = fixture();
  let writes = 0;
  const server = http.createServer((req, res) => {
    try {
      const principal = authenticateApiRequest(req, '/api/conversations', credential);
      writes++;
      res.end(JSON.stringify(principal));
    } catch (error) { res.statusCode = error.statusCode || 500; res.end(JSON.stringify({ code: error.code })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/conversations`;
  for (const headers of [
    { 'X-CAFF-Principal': 'planner' }, { Authorization: 'Bearer ' + 'b'.repeat(43) }, { Authorization: 'not-a-bearer' },
  ]) {
    const response = await fetch(url, { method: 'POST', headers, body: '{invalid-json' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'planner_credential_invalid');
    assert.equal(writes, 0);
  }
  const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).kind, 'planner');
  assert.equal(writes, 1);
});
