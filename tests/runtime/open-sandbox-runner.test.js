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

test('runPi passes prompt through stdin instead of argv', async () => {
  const tempDir = withTempDir('caff-open-sandbox-runner-stdin-');

  try {
    const fakePiPath = path.join(tempDir, 'fake-pi-stdin.js');
    const argvCapturePath = path.join(tempDir, 'argv.json');
    const promptPath = path.join(tempDir, 'prompt.txt');
    const prompt = '龙泡泡'.repeat(4000);
    writeFakePiScript(fakePiPath, [
      "const fs = require('node:fs');",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { stdin += chunk; });",
      "process.stdin.on('end', () => {",
      "  const argv = process.argv.slice(2);",
      "  fs.writeFileSync(process.env.ARG_CAPTURE_PATH, JSON.stringify(argv), 'utf8');",
      "  const expected = fs.readFileSync(process.env.EXPECTED_PROMPT_PATH, 'utf8');",
      "  const ok = stdin === expected && !argv.includes(expected);",
      "  const event = {",
      "    type: 'message_end',",
      "    message: {",
      "      role: 'assistant',",
      "      responseId: 'response-stdin',",
      "      stopReason: 'stop',",
      "      content: [{ type: 'text', text: ok ? 'stdin-ok' : 'stdin-bad' }],",
      "    },",
      "  };",
      "  process.stdout.write(JSON.stringify(event) + '\\n');",
      "  process.exit(ok ? 0 : 1);",
      "});",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    fs.writeFileSync(promptPath, prompt, 'utf8');

    const result = await runPi({
      piCliPath: fakePiPath,
      nodeCommand: process.execPath,
      prompt,
      cwd: tempDir,
      eventPath: path.join(tempDir, 'events.jsonl'),
      extraEnv: {
        ARG_CAPTURE_PATH: argvCapturePath,
        EXPECTED_PROMPT_PATH: promptPath,
      },
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.reply, 'stdin-ok');
    const argv = JSON.parse(fs.readFileSync(argvCapturePath, 'utf8'));
    assert.ok(Array.isArray(argv));
    assert.ok(!argv.includes(prompt));
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
