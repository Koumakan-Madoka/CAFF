import { Type } from 'typebox';

const ROOM_WORKSPACE_CONFIRMATION = true;

function deliveryParameters(request = false) {
  return Type.Object({
    targetConversationId: Type.String({ minLength: 1, maxLength: 200, description: 'Known ID of another Room bound to the same project.' }),
    targetAgentId: Type.String({ minLength: 1, maxLength: 200, description: 'ID of a routable participant in the target Room.' }),
    content: Type.String({ minLength: 1, maxLength: 12000, description: 'Self-contained text for the target; source Room history is not inherited.' }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 200, description: 'Stable key for this logical delivery within the current invocation only.' }),
    ...(request ? {
      deadlineSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400, default: 300, description: 'Response tracking deadline; expiry does not cancel target work.' })),
    } : {}),
  }, { additionalProperties: false });
}

const facadeDefinitions = [
  {
    name: 'list_rooms',
    label: 'List Rooms',
    description: 'List other Rooms by latest public message (empty Rooms last), with IDs, titles, projects and current Agents only. Defaults to the same project; explicitly use all_projects for the local instance directory, including unbound Rooms. Discovery does not authorize delivery. Use search-memory for topic recall. Default 10 results, maximum 30.',
    parameters: Type.Object({
      scope: Type.Optional(Type.String({ enum: ['same_project', 'all_projects'], default: 'same_project' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 10 })),
    }, { additionalProperties: false }),
  },
  {
    name: 'conversation_notify',
    label: 'Notify Another Room',
    description: 'Send context to an Agent in another Room bound to the same project. Triggers the target Agent, but requests no automatic return response. Returns a delivery receipt immediately. Never use for collaboration in the current Room or relay it through another Room: use public replies/@mentions or create-delegation instead. list_rooms discovers targets but does not authorize delivery; known IDs need no prior lookup. The idempotency key deduplicates only within the same invocation.',
    parameters: deliveryParameters(),
  },
  {
    name: 'conversation_request',
    label: 'Request Work in Another Room',
    description: 'Request work from an Agent in another Room bound to the same project. Returns a receipt immediately, not the answer. The response is projected into source Room history asynchronously and does not wake the source Agent. The response deadline defaults to 300 seconds; expiry does not cancel target work and late responses may arrive. No model delivery-status/wait/cancel/retry tool is provided. Never use for collaboration in the current Room or relay it through another Room: use public replies/@mentions or create-delegation/await-delegation instead. Known target IDs need no prior list_rooms lookup. The idempotency key deduplicates only within the same invocation.',
    parameters: deliveryParameters(true),
  },
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
