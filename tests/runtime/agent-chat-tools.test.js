const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { formatCommandResult, resolveMessageContent, shouldEchoContent } = require('../../agent-chat-tools');

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
