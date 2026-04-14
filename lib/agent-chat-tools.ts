#!/usr/bin/env node

const DEFAULT_API_URL = 'http://127.0.0.1:3100';

function getConfig() {
  const apiUrl = String(process.env.CAFF_CHAT_API_URL || DEFAULT_API_URL).trim();
  const invocationId = String(process.env.CAFF_CHAT_INVOCATION_ID || '').trim();
  const callbackToken = String(process.env.CAFF_CHAT_CALLBACK_TOKEN || '').trim();
  const skillTestRunId = String(process.env.CAFF_SKILL_TEST_RUN_ID || '').trim();
  const skillTestCaseId = String(process.env.CAFF_SKILL_TEST_CASE_ID || '').trim();

  if (!invocationId || !callbackToken) {
    throw new Error('Missing CAFF_CHAT_INVOCATION_ID or CAFF_CHAT_CALLBACK_TOKEN.');
  }

  return { apiUrl, invocationId, callbackToken, skillTestRunId, skillTestCaseId };
}

function withSkillTestScope(config: any, body: any = {}) {
  return {
    ...body,
    ...(config && config.skillTestRunId ? { skillTestRunId: config.skillTestRunId } : {}),
    ...(config && config.skillTestCaseId ? { skillTestCaseId: config.skillTestCaseId } : {}),
  };
}

function appendSkillTestScopeQuery(config: any, query: any) {
  if (config && config.skillTestRunId) {
    query.set('skillTestRunId', config.skillTestRunId);
  }
  if (config && config.skillTestCaseId) {
    query.set('skillTestCaseId', config.skillTestCaseId);
  }
  return query;
}

function parseArgs(argv: any) {
  const [command = '', ...rest] = Array.isArray(argv) ? argv : [];
  const flags: Record<string, any> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    let value;

    if (!next || next.startsWith('--')) {
      value = true;
    } else {
      value = next;
      index += 1;
    }

    if (flags[key] === undefined) {
      flags[key] = value;
      continue;
    }

    if (Array.isArray(flags[key])) {
      flags[key].push(value);
      continue;
    }

    flags[key] = [flags[key], value];
  }

  return { command, flags, positionals };
}

function normalizeRecipients(value: any) {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];

  return values
    .flatMap((item) =>
      String(item)
        .split(/[,\n\r;，；]+/u)
        .map((part) => part.trim())
        .filter(Boolean)
    );
}

function readTextStream(stream = process.stdin) {
  if (!stream || stream.isTTY) {
    return Promise.resolve('');
  }

  return new Promise((resolve, reject) => {
    let data = '';

    if (typeof stream.setEncoding === 'function') {
      stream.setEncoding('utf8');
    }

    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => {
      resolve(data);
    });
    stream.on('error', reject);

    if (typeof stream.resume === 'function') {
      stream.resume();
    }
  });
}

async function resolveMessageContent(flags: any = {}, options: any = {}) {
  if (flags.content !== undefined && flags.content !== true) {
    const content = String(flags.content || '').trim();

    if (content) {
      return content;
    }
  }

  if (flags['content-stdin'] !== true && flags.stdin !== true) {
    return '';
  }

  return String(await readTextStream(options.stream || process.stdin) || '').trim();
}

async function resolveFileContent(flags: any = {}, options: any = {}) {
  if (flags.content !== undefined && flags.content !== true) {
    return String(flags.content ?? '');
  }

  if (flags['content-stdin'] !== true && flags.stdin !== true) {
    return '';
  }

  return String(await readTextStream(options.stream || process.stdin) || '');
}

async function requestJson(url: string, options: any = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `Request failed with status ${response.status}`);
  }

  return data;
}

async function sendPublic(config: any, flags: any, options: any = {}) {
  const content = await resolveMessageContent(flags, options);

  if (!content) {
    throw new Error(
      'send-public requires --content or --content-stdin (bash multiline example: cat <<\'EOF\' | node "$CAFF_CHAT_TOOLS_PATH" send-public --content-stdin)'
    );
  }

  return requestJson(`${config.apiUrl}/api/agent-tools/post-message`, {
    method: 'POST',
    body: withSkillTestScope(config, {
      invocationId: config.invocationId,
      callbackToken: config.callbackToken,
      visibility: 'public',
      content,
      mode: String(flags.mode || 'replace').trim() || 'replace',
    }),
  });
}

async function sendPrivate(config: any, flags: any, options: any = {}) {
  const content = await resolveMessageContent(flags, options);

  if (!content) {
    throw new Error(
      'send-private requires --content or --content-stdin (bash multiline example: cat <<\'EOF\' | node "$CAFF_CHAT_TOOLS_PATH" send-private --to "AgentName" --content-stdin)'
    );
  }

  const body: any = withSkillTestScope(config, {
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
    visibility: 'private',
    content,
    recipientAgentIds: normalizeRecipients(flags.to),
  });

  if (flags.handoff === true || flags['trigger-reply'] === true) {
    body.handoff = true;
  }

  if (flags['no-handoff'] === true || flags.silent === true) {
    body.noHandoff = true;
  }

  return requestJson(`${config.apiUrl}/api/agent-tools/post-message`, {
    method: 'POST',
    body,
  });
}

async function readContext(config: any, flags: any) {
  const query = new URLSearchParams({
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
  });

  if (flags['public-limit']) {
    query.set('publicLimit', String(flags['public-limit']));
  }

  if (flags['private-limit']) {
    query.set('privateLimit', String(flags['private-limit']));
  }
  appendSkillTestScopeQuery(config, query);

  return requestJson(`${config.apiUrl}/api/agent-tools/context?${query.toString()}`);
}

async function searchMessages(config: any, flags: any) {
  const query = String(flags.query || '').trim();
  const speaker = String(flags.speaker || flags.sender || flags['speaker-name'] || '').trim();
  const agentId = String(flags['agent-id'] || flags.agentId || '').trim();

  if (!query && !speaker && !agentId) {
    throw new Error('search-messages requires --query "keywords" or a speaker filter like --speaker "AgentName".');
  }

  const body: any = withSkillTestScope(config, {
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
  });

  if (query) {
    body.query = query;
  }

  if (speaker) {
    body.speaker = speaker;
  }

  if (agentId) {
    body.agentId = agentId;
  }

  if (flags.limit !== undefined) {
    body.limit = flags.limit;
  }

  return requestJson(`${config.apiUrl}/api/agent-tools/search-messages`, {
    method: 'POST',
    body,
  });
}

async function listMemories(config: any, flags: any) {
  const query = new URLSearchParams({
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
  });

  if (flags.limit !== undefined) {
    query.set('limit', String(flags.limit));
  }
  appendSkillTestScopeQuery(config, query);

  return requestJson(`${config.apiUrl}/api/agent-tools/memories?${query.toString()}`);
}

async function saveMemory(config: any, flags: any) {
  const title = String(flags.title || '').trim();
  const content = String(flags.content || '').trim();

  if (!title) {
    throw new Error('save-memory requires --title "memory name".');
  }

  if (!content) {
    throw new Error('save-memory requires --content "durable fact".');
  }

  const body: any = withSkillTestScope(config, {
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
    title,
    content,
  });

  if (flags['ttl-days'] !== undefined) {
    body.ttlDays = flags['ttl-days'];
  } else if (flags.ttl !== undefined) {
    body.ttlDays = flags.ttl;
  }

  return requestJson(`${config.apiUrl}/api/agent-tools/memories`, {
    method: 'POST',
    body,
  });
}

async function updateMemory(config: any, flags: any) {
  const title = String(flags.title || '').trim();
  const content = String(flags.content || '').trim();
  const reason = String(flags.reason || '').trim();
  const expectedUpdatedAt = String(flags['expected-updated-at'] || flags.expectedUpdatedAt || '').trim();

  if (!title) {
    throw new Error('update-memory requires --title "memory name".');
  }

  if (!content) {
    throw new Error('update-memory requires --content "updated durable fact".');
  }

  if (!reason) {
    throw new Error('update-memory requires --reason "why this durable memory changed".');
  }

  const body: any = withSkillTestScope(config, {
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
    title,
    content,
    reason,
  });

  if (expectedUpdatedAt) {
    body.expectedUpdatedAt = expectedUpdatedAt;
  }

  return requestJson(`${config.apiUrl}/api/agent-tools/memories/update`, {
    method: 'POST',
    body,
  });
}

async function forgetMemory(config: any, flags: any) {
  const title = String(flags.title || '').trim();
  const reason = String(flags.reason || '').trim();
  const expectedUpdatedAt = String(flags['expected-updated-at'] || flags.expectedUpdatedAt || '').trim();

  if (!title) {
    throw new Error('forget-memory requires --title "memory name".');
  }

  if (!reason) {
    throw new Error('forget-memory requires --reason "why this durable memory should be removed".');
  }

  const body: any = withSkillTestScope(config, {
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
    title,
    reason,
  });

  if (expectedUpdatedAt) {
    body.expectedUpdatedAt = expectedUpdatedAt;
  }

  return requestJson(`${config.apiUrl}/api/agent-tools/memories/forget`, {
    method: 'POST',
    body,
  });
}

async function trellisInit(config: any, flags: any) {
  const taskName = String(flags.task || flags['task-name'] || flags.name || '').trim();

  return requestJson(`${config.apiUrl}/api/agent-tools/trellis/init`, {
    method: 'POST',
    body: withSkillTestScope(config, {
      invocationId: config.invocationId,
      callbackToken: config.callbackToken,
      taskName,
      confirm: flags.confirm === true,
      force: flags.force === true,
      includeContent: flags['include-content'] === true,
    }),
  });
}

async function trellisWrite(config: any, flags: any) {
  const relativePath = String(flags.path || flags['relative-path'] || flags.file || '').trim();

  if (!relativePath) {
    throw new Error('Missing --path for trellis-write.');
  }

  const content = await resolveFileContent(flags);

  return requestJson(`${config.apiUrl}/api/agent-tools/trellis/write`, {
    method: 'POST',
    body: withSkillTestScope(config, {
      invocationId: config.invocationId,
      callbackToken: config.callbackToken,
      relativePath,
      content,
      confirm: flags.confirm === true,
      force: flags.force === true,
      includeContent: flags['include-content'] === true,
    }),
  });
}

async function listParticipants(config: any) {
  const query = new URLSearchParams({
    invocationId: config.invocationId,
    callbackToken: config.callbackToken,
  });

  appendSkillTestScopeQuery(config, query);

  return requestJson(`${config.apiUrl}/api/agent-tools/participants?${query.toString()}`);
}

function isFlagEnabled(value: any) {
  if (value === true) {
    return true;
  }

  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldEchoContent(flags: any = {}, env = process.env) {
  return (
    isFlagEnabled(flags['include-content']) ||
    isFlagEnabled(flags.verbose) ||
    isFlagEnabled(env && env.CAFF_CHAT_TOOL_ECHO_CONTENT)
  );
}

function compactSendPublicResult(result: any) {
  const message = result && result.message && typeof result.message === 'object' ? result.message : null;

  return {
    ok: result && result.ok === true,
    visibility: 'public',
    message: message
      ? {
          id: String(message.id || '').trim(),
          status: String(message.status || '').trim(),
          publicPostCount: Number.isInteger(message.publicPostCount) ? message.publicPostCount : 0,
          publicPostMode: String(message.publicPostMode || '').trim(),
          publicPostedAt: String(message.publicPostedAt || '').trim(),
        }
      : null,
  };
}

function compactSendPrivateResult(result: any) {
  const message = result && result.message && typeof result.message === 'object' ? result.message : null;
  const recipientAgentIds =
    message && Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds.filter(Boolean) : [];

  return {
    ok: result && result.ok === true,
    visibility: 'private',
    message: message
      ? {
          id: String(message.id || '').trim(),
          recipientAgentIds,
          recipientCount: recipientAgentIds.length,
        }
      : null,
    handoffRequested: result && result.handoffRequested === true,
    enqueuedAgentIds: Array.isArray(result && result.enqueuedAgentIds) ? result.enqueuedAgentIds.filter(Boolean) : [],
  };
}

function formatCommandResult(command: string, result: any, flags: any = {}, env = process.env) {
  if (shouldEchoContent(flags, env)) {
    return result;
  }

  if (command === 'send-public') {
    return compactSendPublicResult(result);
  }

  if (command === 'send-private') {
    return compactSendPrivateResult(result);
  }

  return result;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const config = getConfig();
  let result;

  if (command === 'send-public') {
    result = await sendPublic(config, flags);
  } else if (command === 'send-private') {
    result = await sendPrivate(config, flags);
  } else if (command === 'read-context') {
    result = await readContext(config, flags);
  } else if (command === 'search-messages') {
    result = await searchMessages(config, flags);
  } else if (command === 'list-memories') {
    result = await listMemories(config, flags);
  } else if (command === 'save-memory') {
    result = await saveMemory(config, flags);
  } else if (command === 'update-memory') {
    result = await updateMemory(config, flags);
  } else if (command === 'forget-memory') {
    result = await forgetMemory(config, flags);
  } else if (command === 'list-participants') {
    result = await listParticipants(config);
  } else if (command === 'trellis-init') {
    result = await trellisInit(config, flags);
  } else if (command === 'trellis-write') {
    result = await trellisWrite(config, flags);
  } else {
    throw new Error(
      'Unknown command. Use one of: send-public, send-private, read-context, search-messages, list-memories, save-memory, update-memory, forget-memory, list-participants, trellis-init, trellis-write.'
    );
  }

  process.stdout.write(`${JSON.stringify(formatCommandResult(command, result, flags), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export {
  compactSendPrivateResult,
  compactSendPublicResult,
  appendSkillTestScopeQuery,
  formatCommandResult,
  getConfig,
  isFlagEnabled,
  main,
  normalizeRecipients,
  parseArgs,
  readTextStream,
  resolveMessageContent,
  resolveFileContent,
  sendPrivate,
  sendPublic,
  forgetMemory,
  listMemories,
  saveMemory,
  searchMessages,
  shouldEchoContent,
  updateMemory,
  withSkillTestScope,
};
