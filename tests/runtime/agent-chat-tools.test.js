const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  conversationNotify,
  conversationRequest,
  forgetMemory,
  formatCommandResult,
  main,
  resolveMessageContent,
  searchMemory,
  searchMessages,
  sendPublic,
  shouldEchoContent,
  suggestGoal,
  updateGoalChecklist,
  updateMemory,
} = require('../../build/lib/agent-chat-tools');

test('write-experience command is retired before any HTTP request', async (t) => {
  const originalArgv = process.argv;
  const originalInvocationId = process.env.CAFF_CHAT_INVOCATION_ID;
  const originalCallbackToken = process.env.CAFF_CHAT_CALLBACK_TOKEN;
  let fetchCalls = 0;

  process.argv = ['node', 'agent-chat-tools.js', 'write-experience'];
  process.env.CAFF_CHAT_INVOCATION_ID = 'retired-experience-invocation';
  process.env.CAFF_CHAT_CALLBACK_TOKEN = 'retired-experience-token';
  t.mock.method(global, 'fetch', async () => {
    fetchCalls += 1;
    throw new Error('retired command must not call fetch');
  });
  t.after(() => {
    process.argv = originalArgv;
    if (originalInvocationId === undefined) delete process.env.CAFF_CHAT_INVOCATION_ID;
    else process.env.CAFF_CHAT_INVOCATION_ID = originalInvocationId;
    if (originalCallbackToken === undefined) delete process.env.CAFF_CHAT_CALLBACK_TOKEN;
    else process.env.CAFF_CHAT_CALLBACK_TOKEN = originalCallbackToken;
  });

  await assert.rejects(() => main(), /Unknown command/u);
  assert.equal(fetchCalls, 0);
});

test('conversation notify and request CLI helpers call only the fixed Agent delivery routes', async (t) => {
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, delivery: { id: `delivery-${requests.length}` } });
      },
    };
  });
  const config = {
    apiUrl: 'http://127.0.0.1:3100',
    invocationId: 'invocation-cross-delivery',
    callbackToken: 'token-cross-delivery',
  };

  await conversationNotify(config, {
    'target-conversation': 'target-conversation',
    'target-agent': 'target-agent',
    content: 'Notify the target Agent.',
    'idempotency-key': 'notify-cli-key',
  });
  await conversationRequest(config, {
    'target-conversation': 'target-conversation',
    'target-agent': 'target-agent',
    content: 'Request a bounded response.',
    'idempotency-key': 'request-cli-key',
    'deadline-seconds': '45',
  });

  assert.equal(requests[0].url, 'http://127.0.0.1:3100/api/agent-tools/conversation-notify');
  assert.deepEqual(requests[0].body, {
    invocationId: 'invocation-cross-delivery',
    callbackToken: 'token-cross-delivery',
    targetConversationId: 'target-conversation',
    targetAgentId: 'target-agent',
    content: 'Notify the target Agent.',
    idempotencyKey: 'notify-cli-key',
  });
  assert.equal(requests[1].url, 'http://127.0.0.1:3100/api/agent-tools/conversation-request');
  assert.equal(requests[1].body.deadlineSeconds, 45);
  assert.equal('sourceConversationId' in requests[1].body, false);
  assert.equal('projectScopeId' in requests[1].body, false);
});

test('conversation request CLI rejects invalid explicit deadlines before HTTP', async () => {
  await assert.rejects(
    () => conversationRequest(
      { apiUrl: 'http://127.0.0.1:3100', invocationId: 'invocation-1', callbackToken: 'token-1' },
      {
        'target-conversation': 'target-conversation',
        'target-agent': 'target-agent',
        content: 'Request a response.',
        'idempotency-key': 'request-cli-invalid-deadline',
        'deadline-seconds': '1.5',
      }
    ),
    /deadline-seconds must be a positive integer/
  );
});

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

test('send-public forwards no-finalize when requested', async (t) => {
  let requestUrl = '';
  let requestOptions = null;

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, visibility: 'public', message: { id: 'message-public-no-finalize' } });
      },
    };
  });

  await sendPublic(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-public-no-finalize',
      callbackToken: 'token-public-no-finalize',
    },
    {
      content: 'Progress update before continuing work',
      mode: 'append',
      'no-finalize': true,
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/post-message');
  assert.equal(requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-public-no-finalize',
    callbackToken: 'token-public-no-finalize',
    visibility: 'public',
    content: 'Progress update before continuing work',
    mode: 'append',
    noFinalize: true,
  });
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
    dispatch: [{
      agentId: 'agent-a',
      outcome: 'launched',
      detail: 'Recipient started immediately in this turn.',
    }],
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
    dispatch: [{
      agentId: 'agent-a',
      outcome: 'launched',
      detail: 'Recipient started immediately in this turn.',
    }],
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

test('search-memory forwards bounded long-term memory search payload', async (t) => {
  let requestUrl = '';
  let requestOptions = null;

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, scope: 'summary-segments', results: [] });
      },
    };
  });

  await searchMemory(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-search-memory',
      callbackToken: 'token-search-memory',
    },
    {
      query: 'conversation digest regression',
      limit: 4,
      'include-current': true,
      'current-task': true,
      task: 'digest-v2',
      kind: 'rollup',
      conversation: 'Digest Planning Notes',
      since: '2026-05-01',
      until: '2026-05-04',
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/search-memory');
  assert.equal(requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-search-memory',
    callbackToken: 'token-search-memory',
    query: 'conversation digest regression',
    limit: 4,
    includeCurrentConversation: true,
    useCurrentTask: true,
    taskName: 'digest-v2',
    sourceKind: 'rollup',
    conversationTitle: 'Digest Planning Notes',
    updatedAfter: '2026-05-01',
    updatedBefore: '2026-05-04',
  });
});

test('search-memory forwards latest lookup without requiring a query', async (t) => {
  let requestUrl = '';
  let requestOptions = null;

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;

    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, scope: 'summary-segments', searchMode: 'like_latest', results: [] });
      },
    };
  });

  await searchMemory(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-search-memory-latest',
      callbackToken: 'token-search-memory-latest',
    },
    {
      latest: true,
      limit: 2,
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/search-memory');
  assert.equal(requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-search-memory-latest',
    callbackToken: 'token-search-memory-latest',
    latest: true,
    limit: 2,
  });
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
  });
});

test('suggest-goal forwards checklist payload for pending set proposals', async (t) => {
  let requestUrl = '';
  let requestOptions = null;

  t.mock.method(global, 'fetch', async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return {
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, proposal: { action: 'set' } });
      },
    };
  });

  await suggestGoal(
    {
      apiUrl: 'http://127.0.0.1:3100',
      invocationId: 'inv-goal-set-checklist',
      callbackToken: 'token-goal-set-checklist',
    },
    {
      action: 'set',
      objective: 'Ship a goal with visible checklist',
      'checklist-text': '[ ] Plan\n[~] Build\n[x] Validate',
    }
  );

  assert.equal(requestUrl, 'http://127.0.0.1:3100/api/agent-tools/goal/suggest');
  assert.deepEqual(JSON.parse(String(requestOptions.body)), {
    invocationId: 'inv-goal-set-checklist',
    callbackToken: 'token-goal-set-checklist',
    action: 'set',
    objective: 'Ship a goal with visible checklist',
    checklistText: '[ ] Plan\n[~] Build\n[x] Validate',
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
