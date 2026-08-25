const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createSseBus } = require('../../build/server/http/sse-bus');

function createFakeResponse() {
  const res = new EventEmitter();
  res.writableLength = 0;
  res.frames = [];
  res.writeHead = () => {};
  res.write = (chunk) => {
    const text = String(chunk);
    res.frames.push(text);
    res.writableLength += Buffer.byteLength(text);
    return true;
  };
  res.end = () => {};
  res.destroy = () => {};
  return res;
}

function parseEventPayloads(res, eventName) {
  const frames = res.frames.join('');
  const blocks = frames.split('\n\n');
  return blocks
    .filter((block) => block.includes(`event: ${eventName}\n`))
    .map((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      return JSON.parse(data);
    });
}

function createMessage(status) {
  return {
    id: `sse-message-${status}`,
    conversationId: 'sse-contract-conversation',
    turnId: 'turn-sse-contract',
    role: 'assistant',
    agentId: 'role-family-gpt',
    senderName: 'GPT',
    content: status === 'queued' ? 'Thinking...' : 'done',
    status,
    taskId: 'task-sse-contract',
    runId: status === 'queued' ? null : 'run-sse-contract',
    errorMessage: null,
    metadata: {
      provider: 'test-provider',
      model: 'test-model',
      tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      agentContextSnapshot: {
        schemaVersion: 1,
        snapshotId: 'snapshot-sse-contract',
        capturedAt: '2026-08-25T08:00:00.000Z',
        conversationId: 'sse-contract-conversation',
        turnId: 'turn-sse-contract',
        messageId: `sse-message-${status}`,
        agentId: 'role-family-gpt',
        agentName: 'GPT',
        promptVersion: 'contract-sse-test',
        immutable: true,
        totalApproxTokens: 1000,
        totalByteSize: 8192,
        sections: [{
          sectionKey: 'conversation_history',
          title: 'Conversation History',
          source: 'conversation/messages',
          visibility: 'full',
          contentHash: 'content-sse-contract',
          displayContentHash: 'display-sse-contract',
          approxTokens: 1000,
          byteSize: 8192,
          truncated: false,
          redacted: false,
          contentPreview: 'sse-secret-preview',
          displayContent: `sse-secret-display-${'x'.repeat(8192)}`,
        }],
      },
      modelUsage: {
        modelCallCount: 2,
        coldStartModelCallCount: 1,
        postColdModelCallCount: 1,
        providerMissCount: 1,
        calls: [{ sequence: 1, responseId: 'sse-secret-call-1' }, { sequence: 2, responseId: 'sse-secret-call-2' }],
      },
      crossConversation: { deliveryId: 'delivery-sse' },
    },
    createdAt: '2026-08-25T08:00:00.000Z',
  };
}

test('created and updated SSE message payloads share the lightweight metadata projection', (t) => {
  const bus = createSseBus();
  const req = new EventEmitter();
  const res = createFakeResponse();
  bus.openStream(req, res, { conversationId: 'sse-contract-conversation' });
  t.after(() => bus.closeAll());

  const createdSourceMessage = createMessage('queued');
  const updatedSourceMessage = createMessage('completed');
  bus.broadcast('conversation_message_created', {
    conversationId: 'sse-contract-conversation',
    message: createdSourceMessage,
  });
  bus.broadcast('conversation_message_updated', {
    conversationId: 'sse-contract-conversation',
    message: updatedSourceMessage,
  });
  assert.equal(createdSourceMessage.metadata.agentContextSnapshot.sections[0].displayContent.includes('sse-secret-display'), true);
  assert.equal(updatedSourceMessage.metadata.modelUsage.calls.length, 2);

  const created = parseEventPayloads(res, 'conversation_message_created');
  const updated = parseEventPayloads(res, 'conversation_message_updated');
  assert.equal(created.length, 1);
  assert.equal(updated.length, 1);

  for (const payload of [...created, ...updated]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('displayContent'), false);
    assert.equal(serialized.includes('sse-secret-display'), false);
    assert.equal(serialized.includes('"calls"'), false);
    assert.equal(serialized.includes('sse-secret-call-1'), false);
    assert.equal(payload.message.metadata.agentContextSnapshot.snapshotId, 'snapshot-sse-contract');
    assert.equal(payload.message.metadata.agentContextSnapshot.sectionCount, 1);
    assert.equal(Object.hasOwn(payload.message.metadata.agentContextSnapshot, 'sections'), false);
    assert.deepEqual(payload.message.metadata.modelUsage, {
      modelCallCount: 2,
      coldStartModelCallCount: 1,
      postColdModelCallCount: 1,
      providerMissCount: 1,
      callsTruncated: false,
      retainedCallCount: 2,
      droppedCallCount: 0,
    });
    assert.equal(payload.message.metadata.crossConversation.deliveryId, 'delivery-sse');
    assert.equal(payload.message.metadata.tokenUsage.totalTokens, 120);
  }
});
