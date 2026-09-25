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

test('typesafe client sanitizes 422 field details into safe categories without echoing input values', async () => {
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
      // Reasons are fixed safe categories, never upstream free text (decision d5).
      assert.equal(error.fields[0].reason, 'value has an invalid type or format');
      // The sentinel input value must appear NOWHERE in the error output.
      const serialized = JSON.stringify({ message: error.message, fields: error.fields });
      assert.ok(!serialized.includes(secretState));
      return true;
    }
  );
});

test('typesafe client maps unknown 422 reasons to a fixed generic reason', async () => {
  const sentinel = 'xyzzy-input-echo-sentinel';
  const { client } = makeClient({
    fetch: async () => makeResponse(422, {
      detail: [{ loc: ['body', 'state'], msg: `frobnicate failed near ${sentinel}` }],
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => {
      assert.equal(error.code, 'typesafe_unprocessable');
      assert.equal(error.fields[0].reason, 'value rejected by the TypeSafe API validator');
      assert.ok(!JSON.stringify({ message: error.message, fields: error.fields }).includes(sentinel));
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

test('typesafe client enforces the request-count hard limit under concurrent asks', async () => {
  const { client, calls } = makeClient({
    maxRequests: 3,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return makeResponse(200, okPayload(['q1']));
    },
  });
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }))
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const budgetRejected = results.filter(
    (result) => result.status === 'rejected' && result.reason && result.reason.code === 'typesafe_budget_exceeded'
  );
  assert.equal(fulfilled.length, 3);
  assert.equal(budgetRejected.length, 5);
  assert.equal(calls.length, 3);
  assert.equal(client.getBudgetStatus().requestsUsed, 3);
});

test('typesafe client applies the overall timeout while reading a slow response body', async () => {
  const { client } = makeClient({
    timeoutMs: 40,
    fetch: async () => ({
      status: 200,
      headers: { get: () => null },
      text: () => new Promise(() => {}), // headers arrive, body never does
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_timeout'
  );
});

test('typesafe client rejects an answer whose type does not match the question', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'choice', choice: 'a', probabilities: { a: 1 } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_invalid_response' && /type/u.test(error.message)
  );
});

test('typesafe client rejects out-of-range noul probabilities', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'noul', noul: 1.5 } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_invalid_response'
  );
});

test('typesafe client rejects a choice answer outside the declared options', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'choice', choice: 'unlisted', probabilities: { unlisted: 0.9 } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  await assert.rejects(
    () => client.ask({
      state: 'x',
      questions: { q1: { type: 'choice', instructions: 'Pick one', criteria: { a: null, b: null } } },
    }),
    (error) => error.code === 'typesafe_invalid_response' && /declared options/u.test(error.message)
  );
});

test('typesafe client rejects out-of-range probabilities in answer maps', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'choice', choice: 'a', probabilities: { a: 1.7, b: -0.7 } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  await assert.rejects(
    () => client.ask({
      state: 'x',
      questions: { q1: { type: 'choice', instructions: 'Pick one', criteria: { a: null, b: null } } },
    }),
    (error) => error.code === 'typesafe_invalid_response' && /probability/u.test(error.message)
  );
});

test('typesafe client projects answers through a whitelist and drops unverified extra fields', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'noul', noul: 0.4, debug_trace: 'unverified-upstream-field', extra: { nested: true } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  const result = await client.ask({ state: 'x', questions: { q1: noulQuestion() } });
  assert.deepEqual(result.answers.q1, { type: 'noul', noul: 0.4 });
});

test('typesafe client records known usage even when answer validation fails', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: {},
      usage: { input_tokens: 128, output_tokens: 0 },
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_invalid_response'
  );
  assert.equal(client.getBudgetStatus().tokensUsed, 128);
});

test('typesafe client token circuit breaker blocks a retry send after the threshold is crossed mid-backoff', async () => {
  let client;
  let attempt = 0;
  const made = makeClient({
    tokenBudget: 100,
    maxRetries: 2,
    maxRetryWaitMs: 50,
    fetch: async () => {
      attempt += 1;
      if (attempt === 1) {
        return makeResponse(429, { detail: 'slow down' });
      }
      return makeResponse(200, okPayload(['q1'])); // 128 tokens, crosses the 100 threshold
    },
    sleep: async () => {
      // While the first ask backs off, a sibling ask completes and crosses the
      // token threshold on the same process-local counter.
      await client.ask({ state: 'x', questions: { q1: noulQuestion() } });
    },
  });
  client = made.client;
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_budget_exceeded' && /token threshold/u.test(error.message)
  );
  // The retry was refused BEFORE sending: only the first 429 attempt and the
  // sibling request ever hit the wire.
  assert.equal(made.calls.length, 2);
});

test('typesafe client never echoes upstream-controlled 422 path segments (sentinel in loc)', async () => {
  const locSentinel = 'SYNTHETIC_INPUT_SENTINEL_9281';
  const { client } = makeClient({
    fetch: async () => makeResponse(422, {
      detail: [{ loc: ['body', 'state', locSentinel], msg: 'field is required' }],
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => {
      assert.equal(error.code, 'typesafe_unprocessable');
      // Trusted schema keys survive; the upstream-controlled segment is dropped.
      assert.equal(error.fields[0].path, 'body.state');
      const serialized = JSON.stringify({ message: error.message, fields: error.fields });
      assert.ok(!serialized.includes(locSentinel));
      return true;
    }
  );
});

test('typesafe client degrades a fully unrecognized 422 path to a fixed placeholder', async () => {
  const locSentinel = 'LOC_SENTINEL_7717';
  const { client } = makeClient({
    fetch: async () => makeResponse(422, {
      detail: [{ loc: [locSentinel], msg: 'something failed' }],
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => {
      assert.equal(error.fields[0].path, '(redacted)');
      assert.ok(!JSON.stringify({ message: error.message, fields: error.fields }).includes(locSentinel));
      return true;
    }
  );
});

test('typesafe client keeps client-sent question ids in 422 paths but drops other dynamic segments', async () => {
  const locSentinel = 'DYNAMIC_SEGMENT_SENTINEL_5519';
  const { client } = makeClient({
    fetch: async () => makeResponse(422, {
      detail: [{ loc: ['body', 'questions', 'q1', 'criteria', locSentinel, 2], msg: 'value is required' }],
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => {
      assert.equal(error.fields[0].path, 'body.questions.q1.criteria[2]');
      assert.ok(!JSON.stringify({ message: error.message, fields: error.fields }).includes(locSentinel));
      return true;
    }
  );
});

test('typesafe client rejects non-number noul values instead of coercing them', async () => {
  for (const bad of [null, false, true, '', '0.5', [], {}, Number.NaN]) {
    const { client, calls } = makeClient({
      fetch: async () => makeResponse(200, {
        model: 'jev-1.13.0',
        answers: { q1: { type: 'noul', noul: bad } },
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    });
    await assert.rejects(
      () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
      (error) => error.code === 'typesafe_invalid_response',
      `noul=${JSON.stringify(bad)} must be rejected`
    );
    assert.equal(calls.length, 1);
  }
});

test('typesafe client rejects non-number confidence instead of coercing it', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'noul', noul: 0.5, confidence: '' } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  await assert.rejects(
    () => client.ask({ state: 'x', questions: { q1: noulQuestion() } }),
    (error) => error.code === 'typesafe_invalid_response' && /confidence/u.test(error.message)
  );
});

test('typesafe client rejects non-number probability entries instead of coercing them', async () => {
  const { client } = makeClient({
    fetch: async () => makeResponse(200, {
      model: 'jev-1.13.0',
      answers: { q1: { type: 'choice', choice: 'a', probabilities: { a: null, b: true } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }),
  });
  await assert.rejects(
    () => client.ask({
      state: 'x',
      questions: { q1: { type: 'choice', instructions: 'Pick one', criteria: { a: null, b: null } } },
    }),
    (error) => error.code === 'typesafe_invalid_response' && /probability/u.test(error.message)
  );
});

test('typesafe client rejects scores impossible under both 0-based and 1-based conventions', async () => {
  const twoLevels = { type: 'score', instructions: 'Rate it', criteria: ['low', 'high'] };
  for (const bad of [-1000000, 99999, 3, -0.5]) {
    const { client } = makeClient({
      fetch: async () => makeResponse(200, {
        model: 'jev-1.13.0',
        answers: { q1: { type: 'score', score: bad } },
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    });
    await assert.rejects(
      () => client.ask({ state: 'x', questions: { q1: twoLevels } }),
      (error) => error.code === 'typesafe_invalid_response',
      `score=${bad} must be rejected for a 2-level question`
    );
  }
});

test('typesafe client rejects non-number score values instead of coercing them', async () => {
  const twoLevels = { type: 'score', instructions: 'Rate it', criteria: ['low', 'high'] };
  for (const bad of [null, '1', '', [], {}, false]) {
    const { client } = makeClient({
      fetch: async () => makeResponse(200, {
        model: 'jev-1.13.0',
        answers: { q1: { type: 'score', score: bad } },
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    });
    await assert.rejects(
      () => client.ask({ state: 'x', questions: { q1: twoLevels } }),
      (error) => error.code === 'typesafe_invalid_response',
      `score=${JSON.stringify(bad)} must be rejected`
    );
  }
});

test('typesafe client accepts scores inside the union of 0-based and 1-based conventions', async () => {
  const twoLevels = { type: 'score', instructions: 'Rate it', criteria: ['low', 'high'] };
  for (const good of [0, 1, 2, 1.5]) {
    const { client } = makeClient({
      fetch: async () => makeResponse(200, {
        model: 'jev-1.13.0',
        answers: { q1: { type: 'score', score: good } },
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    });
    const result = await client.ask({ state: 'x', questions: { q1: twoLevels } });
    assert.equal(result.answers.q1.score, good);
  }
});

test('typesafe client caps the full serialized request body before sending', async () => {
  const { client, calls } = makeClient({ maxRequestChars: 200 });
  await assert.rejects(
    () => client.ask({
      state: 'x',
      questions: { q1: { type: 'noul', instructions: `rate this: ${'y'.repeat(1_000)}` } },
    }),
    (error) => error.code === 'typesafe_validation_failed' && error.fields[0].path === 'request'
  );
  assert.equal(calls.length, 0);
  assert.equal(client.getBudgetStatus().requestsUsed, 0);
});
