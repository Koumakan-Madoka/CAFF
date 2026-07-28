#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const taskName = 'pi-tool-smoke';
const prdPath = `.trellis/tasks/${taskName}/prd.md`;
const prdContent = `# PRD: pi tool smoke

## Goal

Verify that a pi-mono agent can call trellis-init and trellis-write through the
chat tool bridge.
`;

function runChatTool(args, input = undefined) {
  const toolsPath = String(process.env.CAFF_CHAT_TOOLS_PATH || '').trim();

  if (!toolsPath) {
    throw new Error('CAFF_CHAT_TOOLS_PATH is required');
  }

  const result = spawnSync(process.execPath, [toolsPath, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `CAFF chat tool failed with code ${result.status}: ${String(result.stderr || result.stdout || '').trim()}`
    );
  }
}

async function run() {
  runChatTool(['trellis-init', '--task', taskName, '--confirm']);
  runChatTool(
    ['trellis-write', '--path', prdPath, '--content-stdin', '--confirm', '--force'],
    prdContent
  );

  process.send?.({
    type: 'pi_event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '{"action":"final"}' }],
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    },
  });
}

process.on('message', (command) => {
  if (command?.type === 'abort') {
    process.disconnect?.();
    process.exitCode = 0;
    return;
  }

  if (command?.type !== 'start') {
    return;
  }

  void run().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  });
});
