const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  forgetMemory,
  formatCommandResult,
  resolveMessageContent,
  searchMessages,
  shouldEchoContent,
  suggestGoal,
  updateGoalChecklist,
  updateMemory,
  withSkillTestScope,
} = require('../../build/lib/agent-chat-tools');

test('send-public tool results are compact by default', () => {
  const result = formatCommandResult('send-public', {
    ok: true,
    visibility: 'public',
    message: {
      id: 'message-public-1',
      content: 'This should not be echoed back into the session',
      status: 'streaming',
      publicPostCount: 2,
      publicPostMode: 'replace',
      publicPostedAt: '2026-03-25T00:00:00.000Z',
    },
  });

  assert.deepEqual(result, {
    ok: true,
    visibility: 'public',
    message: {
      id: 'message-public-1',
      status: 'streaming',
      publicPostCount: 2,
      publicPostMode: 'replace',
      publicPostedAt: '2026-03-25T00:00:00.000Z',
    },
  });
  assert.equal('content' in result.message, false);
});

test('send-private tool results are compact by default', () => {
  const result = formatCommandResult('send-private', {
    ok: true,
    visibility: 'private',
    message: {
      id: 'message-private-1',
      content: 'This should stay out of the tool result echo',
      recipientAgentIds: ['agent-a', '', null, 'agent-b'],
    },
    handoffRequested: true,
    enqueuedAgentIds: ['agent-a'],
  });

  assert.deepEqual(result, {
    ok: true,
    visibility: 'private',
    message: {
      id: 'message-private-1',
      recipientAgentIds: ['agent-a', 'agent-b'],
      recipientCount: 2,
    },
    handoffRequested: true,
    enqueuedAgentIds: ['agent-a'],
  });
  assert.equal('content' in result.message, false);
});

test('include-content flag keeps the original tool response', () => {
  const original = {
    ok: true,
    visibility: 'public',
    message: {
      id: 'message-public-2',
      content: 'Keep me',
      status: 'completed',
    },
  };

  const result = formatCommandResult('send-public', original, { 'include-content': true });

  assert.equal(result, original);
  assert.equal(shouldEchoContent({ 'include-content': true }, {}), true);
});

test('search-messages tool results stay fully visible by default', () => {
  const original = {
    ok: true,
    query: 'Hermes',
    scope: 'conversation-public',
    searchMode: 'fts5',
    resultCount: 1,
    results: [{ messageId: 'm-1', snippet: 'Hermes retrieval result' }],
    diagnostics: [],
  };

  const result = formatCommandResult('search-messages', original);

  assert.equal(result, original);
});

test('memory tool results stay fully visible by default', () => {
  const original = {
    ok: true,
    scope: 'agent-visible',
    scopes: ['conversation-agent', 'local-user-agent'],
    cardCount: 1,
    budget: { maxCards: 6, maxCardsPerScope: 6 },
    cards: [{ id: 'mem-1', scope: 'local-user-agent', title: 'preference', content: 'User prefers retrieval-first rollouts.' }],
  };

  const result = formatCommandResult('list-memories', original);

  assert.equal(result, original);
});

test('agent-chat-tools attaches skill-test run and case scope when present', () => {
  assert.deepEqual(
    withSkillTestScope(
      {
        skillTestRunId: 'run-1',
        skillTestCaseId: 'case-1',
      },
      {
        invocationId: 'inv-1',
        callbackToken: 'token-1',
      }
    ),
    {
      invocationId: 'inv-1',
      callbackToken: 'token-1',
      skillTestRunId: 'run-1',
      skillTestCaseId: 'case-1',
    }
  );
});

test('search-messages forwards speaker filters without requiring a query', async (t) => {
  let requestUrl = '';
  let requestOptions = null;

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, scope: 'conversation-public', results: [] });
      },
    };
  });

  await searchMessages(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-search-filters',
      callbackToken: 'token-search-filters',
      skillTestRunId: 'run-search-scope',
      skillTestCaseId: 'case-search-scope',
    },
    {
      speaker: 'doro',
      'agent-id': 'agent-critic',
      limit: 3,
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/search-messages');
  assert.equal(requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-search-filters',
    callbackToken: 'token-search-filters',
    speaker: 'doro',
    agentId: 'agent-critic',
    limit: 3,
    skillTestRunId: 'run-search-scope',
    skillTestCaseId: 'case-search-scope',
  });
});

test('suggest-goal forwards a pending goal proposal payload', async (t) => {
  let requestUrl = '';
  let requestOptions = null;

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, proposal: { action: 'complete' } });
      },
    };
  });

  await suggestGoal(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-goal-proposal',
      callbackToken: 'token-goal-proposal',
      skillTestRunId: 'run-goal-scope',
      skillTestCaseId: 'case-goal-scope',
    },
    {
      action: 'complete',
      reason: 'All checks passed',
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/goal/suggest');
  assert.equal(requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-goal-proposal',
    callbackToken: 'token-goal-proposal',
    action: 'complete',
    reason: 'All checks passed',
    skillTestRunId: 'run-goal-scope',
    skillTestCaseId: 'case-goal-scope',
  });
});

test('update-goal-checklist forwards checklist progress payload from stdin', async (t) => {
  let requestUrl = '';
  let requestOptions = null;
  const stream = new PassThrough();
  stream.end('[x] Add API\n[~] Wire UI\n[ ] Validate');

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, checklist: [] });
      },
    };
  });

  await updateGoalChecklist(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-goal-checklist',
      callbackToken: 'token-goal-checklist',
      skillTestRunId: 'run-goal-checklist',
      skillTestCaseId: 'case-goal-checklist',
    },
    { 'content-stdin': true },
    { stream }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/goal/checklist');
  assert.equal(requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-goal-checklist',
    callbackToken: 'token-goal-checklist',
    checklistText: '[x] Add API\n[~] Wire UI\n[ ] Validate',
    skillTestRunId: 'run-goal-checklist',
    skillTestCaseId: 'case-goal-checklist',
  });
});

test('update-memory and forget-memory forward mutation payloads', async (t) => {
  const requests = [];

  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true });
      },
    };
  });

  await updateMemory(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-memory-update',
      callbackToken: 'token-memory-update',
    },
    {
      title: 'preference',
      content: 'User now prefers answer-first replies.',
      reason: 'User corrected this durable preference',
      'expected-updated-at': '2026-04-13T00:00:00.000Z',
    }
  );

  await forgetMemory(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-memory-forget',
      callbackToken: 'token-memory-forget',
    },
    {
      title: 'temporary preference',
      reason: 'User said this should not persist',
      expectedUpdatedAt: '2026-04-13T01:00:00.000Z',
    }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://127.0.0.1:3100/api/agent-tools/memories/update');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0].options.body)), {
    invocationId: 'inv-memory-update',
    callbackToken: 'token-memory-update',
    title: 'preference',
    content: 'User now prefers answer-first replies.',
    reason: 'User corrected this durable preference',
    expectedUpdatedAt: '2026-04-13T00:00:00.000Z',
  });

  assert.equal(requests[1].url, 'http://127.0.0.1:3100/api/agent-tools/memories/forget');
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[1].options.body)), {
    invocationId: 'inv-memory-forget',
    callbackToken: 'token-memory-forget',
    title: 'temporary preference',
    reason: 'User said this should not persist',
    expectedUpdatedAt: '2026-04-13T01:00:00.000Z',
  });
});

test('content-stdin preserves quotes and multiline text without shell parsing loss', async () => {
  const stream = new PassThrough();
  const expected = '第一行 "quoted"\n第二行继续保留';

  stream.end(expected);

  const content = await resolveMessageContent({ 'content-stdin': true }, { stream });

  assert.equal(content, expected);
});

test('explicit --content still wins over stdin fallback', async () => {
  const stream = new PassThrough();

  stream.end('stdin should be ignored');

  const content = await resolveMessageContent(
    {
      content: 'Use this exact value',
      'content-stdin': true,
    },
    { stream }
  );

  assert.equal(content, 'Use this exact value');
});
