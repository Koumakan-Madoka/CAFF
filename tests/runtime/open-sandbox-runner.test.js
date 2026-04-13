const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { withTempDir } = require('../helpers/temp-dir');
const { runPi } = require('../../server/domain/skill-test/open-sandbox-runner');

function writeFakePiScript(scriptPath, content) {
  fs.writeFileSync(scriptPath, content, 'utf8');
}

test('runPi records assistant errors for normalized stop reasons', async () => {
  const tempDir = withTempDir('caff-open-sandbox-runner-error-');

  try {
    const fakePiPath = path.join(tempDir, 'fake-pi-error.js');
    writeFakePiScript(fakePiPath, [
      'const event = {',
      "  type: 'message_end',",
      '  message: {',
      "    role: 'assistant',",
      "    responseId: 'response-error',",
      "    stopReason: 'ERROR',",
      "    errorMessage: 'assistant boom',",
      '    content: [],',
      '  },',
      '};',
      "process.stdout.write(JSON.stringify(event) + '\\n');",
      'process.exit(1);',
      '',
    ].join('\n'));

    await assert.rejects(
      () => runPi({
        piCliPath: fakePiPath,
        nodeCommand: process.execPath,
        prompt: 'trigger error',
        cwd: tempDir,
        eventPath: path.join(tempDir, 'events.jsonl'),
      }),
      (error) => {
        assert.deepEqual(error.assistantErrors, ['assistant boom']);
        return true;
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runPi ignores malformed control files until a valid request exists', async () => {
  const tempDir = withTempDir('caff-open-sandbox-runner-control-');

  try {
    const fakePiPath = path.join(tempDir, 'fake-pi-stop.js');
    const controlPath = path.join(tempDir, 'control.json');
    writeFakePiScript(fakePiPath, [
      'const event = {',
      "  type: 'message_end',",
      '  message: {',
      "    role: 'assistant',",
      "    responseId: 'response-stop',",
      "    stopReason: 'stop',",
      "    content: [{ type: 'text', text: 'stream-ok' }],",
      '  },',
      '};',
      "process.stdout.write(JSON.stringify(event) + '\\n');",
      'process.exit(0);',
      '',
    ].join('\n'));
    fs.writeFileSync(controlPath, '{"action":', 'utf8');

    const result = await runPi({
      piCliPath: fakePiPath,
      nodeCommand: process.execPath,
      prompt: 'say hi',
      cwd: tempDir,
      eventPath: path.join(tempDir, 'events.jsonl'),
      controlPath,
      controlPollIntervalMs: 10,
      terminateGraceMs: 10,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.reply, 'stream-ok');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
