const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withTempDir } = require('../helpers/temp-dir');
const {
  MAX_RECOVERY_CAPSULE_BYTES,
  MAX_RECOVERY_SESSION_BYTES,
  buildMechanicalRecoveryMessage,
  buildRecoveryCapsule,
} = require('../../build/server/domain/conversation/recovery-capsule');

function writeSession(sessionPath, messages) {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    `${messages.map((message, index) => JSON.stringify({
      type: 'message',
      id: `entry-${index + 1}`,
      message,
    })).join('\n')}\n`,
    'utf8'
  );
}

function sourceFixture(tempDir, sessionPath) {
  return {
    agentDir: tempDir,
    sessionPath,
    message: {
      id: 'failed-message-1',
      conversationId: 'conversation-1',
      taskId: 'source-task-1',
      runId: 42,
      agentId: 'agent-1',
      senderName: 'Agent One',
      status: 'failed',
      createdAt: '2026-08-25T23:26:57.905Z',
      errorMessage: 'provider failed with Authorization: Bearer message-secret',
    },
    task: {
      id: 'source-task-1',
      status: 'failed',
      runId: 42,
      errorMessage: 'task failed token=task-secret-value',
      metadata: {
        visiblePathRoots: [path.join(tempDir, 'project')],
      },
    },
    run: {
      id: 42,
      status: 'failed',
      terminationType: 'provider_error',
      errorMessage: 'stream_read_error password=run-secret-value',
      assistantErrors: ['stream_read_error api_key=assistant-secret-value'],
    },
    contextSnapshot: {
      snapshotId: 'snapshot-1',
      sections: [
        {
          sectionKey: 'session_goal',
          title: 'Session goal',
          displayContent: 'Objective: repair the deployment. Acceptance: rollout succeeds. secret=goal-secret-value',
          truncated: false,
        },
        {
          sectionKey: 'conversation_history',
          title: 'Conversation history',
          displayContent: 'User: deploy the worker and verify the zero-model path.\nAssistant: I will inspect first.',
          truncated: false,
        },
        {
          sectionKey: 'private_mailbox',
          title: 'Private mailbox',
          displayContent: 'This section must not enter a recovery capsule.',
          truncated: false,
        },
      ],
    },
  };
}

test('recovery capsule pairs tool results, grades side-effect uncertainty, and redacts source text', (t) => {
  const tempDir = withTempDir('caff-recovery-capsule-');
  const sessionPath = path.join(tempDir, 'named-sessions', 'failed.jsonl');
  const projectPath = path.join(tempDir, 'project', 'deployment.yaml');

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  writeSession(sessionPath, [
    {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{
        type: 'toolCall',
        id: 'call-success',
        name: 'bash',
        arguments: {
          command: `TOKEN=command-secret-value kubectl apply -f ${projectPath}`,
        },
      }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-success',
      toolName: 'bash',
      isError: false,
      content: [{
        type: 'text',
        text: [
          'Authorization: Bearer output-secret-value',
          'statefulset.apps/worker configured',
          'line 3',
          'line 4',
          'line 5',
          'line 6',
          'line 7',
          'line 8',
          'rollout complete',
        ].join('\n'),
      }],
      details: { exitCode: 0 },
    },
    {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{
        type: 'toolCall',
        id: 'call-read-failed',
        name: 'read',
        arguments: { path: projectPath, offset: 1, limit: 20 },
      }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-read-failed',
      toolName: 'read',
      isError: true,
      content: [{ type: 'text', text: 'ENOENT: file was not found' }],
    },
    {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        {
          type: 'toolCall',
          id: 'call-write-missing-result',
          name: 'write',
          arguments: { path: projectPath, content: 'password=write-secret-value' },
        },
        {
          type: 'toolCall',
          id: 'call-read-missing-result',
          name: 'read',
          arguments: { path: projectPath },
        },
      ],
    },
    {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'stream_read_error',
      content: [],
    },
  ]);

  const capsule = buildRecoveryCapsule(sourceFixture(tempDir, sessionPath));
  const serialized = JSON.stringify(capsule);
  const byId = new Map(capsule.tools.map((tool) => [tool.toolCallId, tool]));

  assert.equal(capsule.version, 1);
  assert.equal(capsule.source.messageId, 'failed-message-1');
  assert.equal(capsule.source.taskId, 'source-task-1');
  assert.equal(capsule.source.runId, 42);
  assert.equal(capsule.objective.contextSections.some((section) => section.key === 'private_mailbox'), false);
  assert.equal(byId.get('call-success').status, 'completed');
  assert.equal(byId.get('call-success').evidence, 'tool_result');
  assert.equal(byId.get('call-success').exitCode, 0);
  assert.equal(byId.get('call-success').outputHead.length <= 6, true);
  assert.equal(byId.get('call-success').outputTail.length <= 6, true);
  assert.equal(byId.get('call-read-failed').status, 'not_completed');
  assert.equal(byId.get('call-write-missing-result').status, 'possibly_effective');
  assert.equal(byId.get('call-read-missing-result').status, 'unknown');
  assert.equal(capsule.evidenceSummary.completed.length, 1);
  assert.equal(capsule.evidenceSummary.possiblyEffective.length, 1);
  assert.equal(capsule.evidenceSummary.notCompleted.length, 1);
  assert.equal(capsule.evidenceSummary.unknown.length, 1);
  assert.equal(Buffer.byteLength(serialized, 'utf8') <= MAX_RECOVERY_CAPSULE_BYTES, true);

  for (const secret of [
    'message-secret',
    'task-secret',
    'run-secret',
    'assistant-secret',
    'goal-secret',
    'command-secret',
    'output-secret',
    'write-secret',
  ]) {
    assert.equal(serialized.includes(secret), false, `capsule must redact ${secret}`);
  }
  assert.equal(serialized.includes(tempDir), false, 'capsule must hide the agent sandbox path');
  assert.match(serialized, /\[redacted\]/iu);
});

test('recovery capsule remains bounded with synthetic large tool output and preserves newest evidence', (t) => {
  const tempDir = withTempDir('caff-recovery-capsule-large-');
  const sessionPath = path.join(tempDir, 'named-sessions', 'large.jsonl');
  const messages = [];

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (let index = 0; index < 140; index += 1) {
    const toolCallId = `call-${String(index + 1).padStart(3, '0')}`;
    messages.push({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{
        type: 'toolCall',
        id: toolCallId,
        name: 'bash',
        arguments: { command: `printf tool-${index + 1}` },
      }],
    });
    messages.push({
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      isError: false,
      content: [{
        type: 'text',
        text: Array.from({ length: 300 }, (_, line) => `tool-${index + 1}-line-${line + 1}-${'x'.repeat(80)}`).join('\n'),
      }],
      details: { exitCode: 0 },
    });
  }

  writeSession(sessionPath, messages);
  const fixture = sourceFixture(tempDir, sessionPath);
  fixture.contextSnapshot.sections[1].displayContent = 'history '.repeat(20_000);
  const capsule = buildRecoveryCapsule(fixture);
  const serialized = JSON.stringify(capsule);

  assert.equal(Buffer.byteLength(serialized, 'utf8') <= MAX_RECOVERY_CAPSULE_BYTES, true);
  assert.equal(capsule.tools.length <= 80, true);
  assert.equal(capsule.tools.some((tool) => tool.toolCallId === 'call-140'), true);
  assert.equal(capsule.truncation.truncated, true);
  assert.equal(capsule.truncation.droppedToolCount > 0, true);
  assert.equal(capsule.truncation.droppedChars > 0, true);
});

test('oversized session tail without a complete call/result pair fails closed', (t) => {
  const tempDir = withTempDir('caff-recovery-capsule-incomplete-tail-');
  const sessionPath = path.join(tempDir, 'named-sessions', 'incomplete-tail.jsonl');

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  writeSession(sessionPath, [
    {
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{
        type: 'toolCall',
        id: 'call-before-tail',
        name: 'bash',
        arguments: { command: 'external mutation' },
      }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-before-tail',
      toolName: 'bash',
      isError: false,
      content: [{ type: 'text', text: 'x'.repeat(MAX_RECOVERY_SESSION_BYTES + 1024) }],
    },
    {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'stream_read_error',
      content: [],
    },
  ]);

  assert.throws(
    () => buildRecoveryCapsule(sourceFixture(tempDir, sessionPath)),
    /no complete tool call\/result evidence/iu
  );
});

test('mechanical recovery message is structured and explicitly non-executing', () => {
  const capsule = {
    version: 1,
    source: { messageId: 'failed-message-1', taskId: 'source-task-1', runId: 42 },
    failure: { messageError: 'stream_read_error', taskError: '', runError: '', assistantErrors: [] },
    tools: [
      { toolName: 'bash', status: 'completed', command: 'npm run build' },
      { toolName: 'bash', status: 'possibly_effective', command: 'kubectl apply -f deployment.yaml' },
    ],
    evidenceSummary: {
      completed: ['bash: npm run build'],
      possiblyEffective: ['bash: kubectl apply -f deployment.yaml'],
      notCompleted: [],
      unknown: [],
    },
  };

  const message = buildMechanicalRecoveryMessage(capsule);
  assert.match(message, /已经完成/u);
  assert.match(message, /失败位置/u);
  assert.match(message, /可能已生效但需核验/u);
  assert.match(message, /建议恢复点/u);
  assert.match(message, /只读现场整理/u);
  assert.match(message, /不会执行或重放原任务/u);
  assert.equal(message.length <= 8000, true);
});
