import { Type } from '@mariozechner/pi-ai';

const ROOM_WORKSPACE_CONFIRMATION = true;

const facadeDefinitions = [
  {
    name: 'room_workspace_preview',
    label: 'Preview Room Workspace',
    description: 'Preview the server-derived branch and worktree for the current Room without changing Git or storage.',
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: 'room_workspace_bind',
    label: 'Bind Room Workspace',
    description: 'Bind the server-derived branch and worktree for the current Room after explicit user confirmation.',
    parameters: Type.Object({
      confirm: Type.Literal(ROOM_WORKSPACE_CONFIRMATION, {
        description: 'Must be true only after the user explicitly confirms workspace creation.',
      }),
    }, { additionalProperties: false }),
  },
];

function readInvocationCredentials() {
  const apiUrl = String(process.env.CAFF_CHAT_API_URL || '').trim().replace(/\/+$/u, '');
  const invocationId = String(process.env.CAFF_CHAT_INVOCATION_ID || '').trim();
  const callbackToken = String(process.env.CAFF_CHAT_CALLBACK_TOKEN || '').trim();

  if (!apiUrl || !invocationId || !callbackToken) {
    throw new Error('CAFF Pi capability credentials are unavailable');
  }
  return { apiUrl, invocationId, callbackToken };
}

/**
 * @param {string} facade
 * @param {Record<string, unknown>} args
 * @param {AbortSignal | undefined} signal
 */
async function invokeFacade(facade, args, signal) {
  const credentials = readInvocationCredentials();
  const response = await fetch(
    `${credentials.apiUrl}/api/agent-tools/capabilities/${facade}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invocationId: credentials.invocationId,
        callbackToken: credentials.callbackToken,
        arguments: args,
      }),
      ...(signal ? { signal } : {}),
    }
  );

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(
      payload && typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : `CAFF Pi capability failed with HTTP ${response.status}`
    );
  }

  if (!payload || payload.ok !== true || !payload.result || typeof payload.result !== 'object') {
    throw new Error('CAFF Pi capability returned an invalid response');
  }
  return payload.result;
}

/** @param {{ registerTool(tool: any): void }} pi */
export default function registerCaffCapabilities(pi) {
  for (const definition of facadeDefinitions) {
    pi.registerTool({
      ...definition,
      executionMode: 'parallel',
      /**
       * @param {string} _toolCallId
       * @param {Record<string, unknown>} params
       * @param {AbortSignal | undefined} signal
       */
      async execute(_toolCallId, params, signal) {
        const result = await invokeFacade(definition.name, params, signal);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }
}
