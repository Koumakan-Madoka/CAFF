// @ts-nocheck
import { Buffer } from 'node:buffer';

import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@mariozechner/pi-coding-agent';

import { collectDefaultBashEnv } from './pi-skill-test-sandbox-env.mjs';

const DEFAULT_API_URL = 'http://127.0.0.1:3100';

function getConfig() {
  const enabled = String(process.env.CAFF_SKILL_TEST_SANDBOX_TOOL_BRIDGE || '').trim() === '1';
  const apiUrl = String(process.env.CAFF_CHAT_API_URL || DEFAULT_API_URL).trim();
  const invocationId = String(process.env.CAFF_CHAT_INVOCATION_ID || '').trim();
  const callbackToken = String(process.env.CAFF_CHAT_CALLBACK_TOKEN || '').trim();
  const skillTestRunId = String(process.env.CAFF_SKILL_TEST_RUN_ID || '').trim();
  const skillTestCaseId = String(process.env.CAFF_SKILL_TEST_CASE_ID || '').trim();

  return {
    enabled,
    apiUrl,
    invocationId,
    callbackToken,
    skillTestRunId,
    skillTestCaseId,
  };
}

function withScope(config, body = {}) {
  return {
    ...body,
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
    ...(config.skillTestRunId ? { skillTestRunId: config.skillTestRunId } : {}),
    ...(config.skillTestCaseId ? { skillTestCaseId: config.skillTestCaseId } : {}),
  };
}

function previewResponseText(value, maxLength = 240) {
  const text = String(value || '').trim();
  if (!text) {
    return '<empty response body>';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function parseResponseJson(text, endpoint, status) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Sandbox bridge returned invalid JSON for ${endpoint} (status ${status}): ${previewResponseText(text)}`);
  }
}

async function requestJson(config, endpoint, body = {}, signal) {
  const response = await fetch(`${config.apiUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(withScope(config, body)),
    signal,
  });

  const text = await response.text();
  const data = parseResponseJson(text, endpoint, response.status);

  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `Request failed with status ${response.status}: ${previewResponseText(text)}`);
  }

  return data;
}

function createSandboxReadOperations(config) {
  return {
    async access(absolutePath) {
      await requestJson(config, '/api/agent-tools/sandbox/access', { absolutePath });
    },
    async readFile(absolutePath) {
      const result = await requestJson(config, '/api/agent-tools/sandbox/read', { absolutePath });
      return Buffer.from(String(result && result.base64 ? result.base64 : ''), 'base64');
    },
  };
}

function createSandboxWriteOperations(config) {
  return {
    async mkdir(absolutePath) {
      await requestJson(config, '/api/agent-tools/sandbox/mkdir', { absolutePath });
    },
    async writeFile(absolutePath, content) {
      await requestJson(config, '/api/agent-tools/sandbox/write', { absolutePath, content });
    },
  };
}

function createSandboxEditOperations(config) {
  return {
    ...createSandboxReadOperations(config),
    ...createSandboxWriteOperations(config),
  };
}

function createSandboxBashOperations(config) {
  return {
    async exec(command, cwd, options = {}) {
      const result = await requestJson(
        config,
        '/api/agent-tools/sandbox/bash',
        {
          command,
          cwd,
          timeout: options.timeout,
          env: {
            ...collectDefaultBashEnv(),
            ...(options.env && typeof options.env === 'object' ? options.env : {}),
          },
        },
        options.signal
      );

      if (result && result.stdout) {
        options.onData?.(Buffer.from(String(result.stdout), 'utf8'));
      }
      if (result && result.stderr) {
        options.onData?.(Buffer.from(String(result.stderr), 'utf8'));
      }

      return {
        exitCode: Number.isInteger(result && result.exitCode) ? result.exitCode : null,
      };
    },
  };
}

export default function skillTestSandboxExtension(pi) {
  const config = getConfig();

  if (!config.enabled || !config.invocationId || !config.callbackToken) {
    return;
  }

  const cwd = String(process.env.CAFF_SKILL_TEST_VISIBLE_PROJECT_DIR || process.env.CAFF_TRELLIS_PROJECT_DIR || process.cwd()).trim() || process.cwd();
  const readTool = createReadTool(cwd, {
    operations: createSandboxReadOperations(config),
  });
  const writeTool = createWriteTool(cwd, {
    operations: createSandboxWriteOperations(config),
  });
  const editTool = createEditTool(cwd, {
    operations: createSandboxEditOperations(config),
  });
  const bashTool = createBashTool(cwd, {
    operations: createSandboxBashOperations(config),
  });

  pi.registerTool({
    ...readTool,
    label: 'read (sandbox)',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...writeTool,
    label: 'write (sandbox)',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return writeTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...editTool,
    label: 'edit (sandbox)',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return editTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...bashTool,
    label: 'bash (sandbox)',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
