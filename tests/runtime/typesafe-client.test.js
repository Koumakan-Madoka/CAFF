const assert = require('node:assert/strict');
const test = require('node:test');

const { createTypeSafeClient, TypeSafeClientError } = require('../../build/server/domain/integrations/typesafe/typesafe-client');

function makeResponse(status, payload, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    text: async () => (payload == null ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))),
  };
}

function okPayload(questionIds) {
  const answers = {};
  for (const id of questionIds) {
    answers[id] = { type: 'noul', noul: 0.5 };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 120, output_tokens: 8 } };
}

function noulQuestion() {
  return { type: 'noul', instructions: 'Is this a test?' };
}

function makeClient(overrides = {}) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = overrides.fetch || (async () => makeResponse(200, okPayload(['q1'])));
  const client = createTypeSafeClient({
    apiKey: 'test-key',
    sleep: async (ms) => { sleeps.push(ms); },
    ...overrides,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
  });
  return { client, calls, sleeps };
}

test('typesafe client throws not_configured without an API key', async () => {
  const client = createTypeSafeClient({ apiKey: '', fetch: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => {
      assert.ok(error instanceof TypeSafeClientError);
      assert.equal(error.code, 'typesafe_not_configured');
      return true;
    }
  );
});

test('typesafe client rejects a score question with fewer than 2 levels before sending', async () => {
  const { client, calls } = makeClient();
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: { type: 'score', instructions: 'Rate it', criteria: ['only'] } } }),
    (error) => error.code === 'typesafe_validation_failed' && error.fields[0].path === 'questions.q1.criteria'
  );
  assert.equal(calls.length, 0);
});

test('typesafe client rejects a score question with more than 10 levels before sending', async () => {
  const { client, calls } = makeClient();
  const criteria = Array.from({ length: 11 }, (_, index) => `level ${index}`);
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: { type: 'score', instructions: 'Rate it', criteria } } }),
    (error) => error.code === 'typesafe_validation_failed'
  );
  assert.equal(calls.length, 0);
});

test('typesafe client rejects a choice question with more than 255 options before sending', async () => {
  const { client, calls } = makeClient();
  const criteria = {};
  for (let index = 0; index < 256; index += 1) {
    criteria[`opt_${index}`] = null;
  }
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: { type: 'choice', instructions: 'Pick one', criteria } } }),
    (error) => error.code === 'typesafe_validation_failed'
  );
  assert.equal(calls.length, 0);
});

test('typesafe client rejects too many questions before sending', async () => {
  const { client, calls } = makeClient({ maxQuestions: 2 });
  await assert.rejects(
    () => client.ask({
      state: 'x',
      questions: { q1: noulQuestion(), q2: noulQuestion(), q3: noulQuestion() },
    }),
    (error) => error.code === 'typesafe_validation_failed'
  );
  assert.equal(calls.length, 0);
});

test('typesafe client rejects an oversized state before sending', async () => {
  const { client, calls } = makeClient({ maxStateChars: 10 });
  await assert.rejects(
    () => client.ask({ state: 'this state is definitely longer than ten characters', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_validation_failed' && error.fields[0].path === 'state'
  );
  assert.equal(calls.length, 0);
});

test('typesafe client sends the documented wire format and records usage', async () => {
  const questions = {
    is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
    department: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', technical: null } },
    frustration: { type: 'score', instructions: 'How frustrated?', criteria: ['Calm', 'Angry'] },
  };
  const payload = {
    model: 'jev-1.13.0',
    answers: {
      is_urgent: { type: 'noul', noul: 0.95 },
      department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.8 },
      frustration: { type: 'score', score: 1.0, legend: { 0: 'Calm', 1: 'Angry' }, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.85 },
    },
    usage: { input_tokens: 300, output_tokens: 40 },
  };
  const { client, calls } = makeClient({ fetch: async () => makeResponse(200, payload) });
  const result = await client.ask({ state: 'Help! My payouts failed.', questions });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(Object.keys(body.questions).sort(), ['department', 'frustration', 'is_urgent']);
  assert.equal(result.answers.department.choice, 'billing');

  const budget = client.getBudgetStatus();
  assert.equal(budget.requestsUsed, 1);
  assert.equal(budget.tokensUsed, 340);
});

test('typesafe client maps 401 to an explicit auth failure', async () => {
  const { client } = makeClient({ fetch: async () => makeResponse(401, { detail: 'unauthorized' }) });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_auth_failed'
  );
});

test('typesafe client sanitizes 422 field details without echoing input values', async () => {
  const secretState = 'super-secret-state-content';
  const { client } = makeClient({
    fetch: async () => makeResponse(422, {
      detail: [
        { loc: ['body', 'questions', 'q1', 'criteria'], msg: `value is not valid: ${secretState}`, input: secretState },
      ],
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => {
      assert.equal(error.code, 'typesafe_unprocessable');
      assert.equal(error.fields.length, 1);
      assert.equal(error.fields[0].path, 'body.questions.q1.criteria');
      // The reason text is truncated and the error must never echo the raw body
      // or structured input values beyond a short plain-text reason.
      assert.ok(!JSON.stringify(error.fields).includes('input'));
      return true;
    }
  );
});

test('typesafe client honors retry-after on 429 and counts retries against the request budget', async () => {
  const payload = okPayload(['q1']);
  let attempt = 0;
  const { client, calls, sleeps } = makeClient({
    fetch: async () => {
      attempt += 1;
      return attempt === 1 ? makeResponse(429, { detail: 'slow down' }, { 'retry-after': '2' }) : makeResponse(200, payload);
    },
    maxRetryWaitMs: 5_000,
  });
  const result = await client.ask({ state: 'x', questions: { q1: noulQuestion() } });
  assert.equal(result.answers.q1.noul, 0.5);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(client.getBudgetStatus().requestsUsed, 2);
});

test('typesafe client caps retry-after waits at maxRetryWaitMs', async () => {
  const payload = okPayload(['q1']);
  let attempt = 0;
  const { client, sleeps } = makeClient({
    fetch: async () => {
      attempt += 1;
      return attempt === 1 ? makeResponse(529, 'overloaded', { 'retry-after': '60' }) : makeResponse(200, payload);
    },
    maxRetryWaitMs: 1_000,
  });
  await client.ask({ state: 'x', questions: { q1: noulQuestion() } });
  assert.deepEqual(sleeps, [1000]);
});

test('typesafe client fails explicitly after exhausting retries on 429', async () => {
  const { client, calls } = makeClient({
    fetch: async () => makeResponse(429, { detail: 'slow down' }),
    maxRetries: 2,
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_rate_limited' && /after 3 attempts/u.test(error.message)
  );
  assert.equal(calls.length, 3);
});

test('typesafe client reports an explicit timeout when the attempt is aborted', async () => {
  const { client } = makeClient({
    timeoutMs: 50,
    fetch: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_timeout'
  );
});

test('typesafe client rejects invalid JSON responses explicitly', async () => {
  const { client } = makeClient({ fetch: async () => makeResponse(200, 'not-json{{') });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_invalid_response'
  );
});

test('typesafe client never fabricates an answer when the response omits one', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 10, output_tokens: 0 } }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_invalid_response'
  );
});

test('typesafe client enforces the request-count hard limit before sending', async () => {
  const { client, calls } = makeClient({ maxRequests: 1 });
  await client.ask({ state: 'x', questions: { q1: noulQuestion() } });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_budget_exceeded' && /request budget/u.test(error.message)
  );
  assert.equal(calls.length, 1);
});

test('typesafe client opens the token circuit breaker after crossing the known-usage threshold', async () => {
  const { client, calls } = makeClient({ tokenBudget: 100 });
  // First response reports 128 tokens, crossing the 100-token threshold.
  await client.ask({ state: 'x', questions: { q1: noulQuestion() } });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_budget_exceeded' && /token threshold/u.test(error.message)
  );
  assert.equal(calls.length, 1);
  assert.equal(client.getBudgetStatus().tokensUsed, 128);
});
