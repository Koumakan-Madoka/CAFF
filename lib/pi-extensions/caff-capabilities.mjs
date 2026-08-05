import { Type } from '@mariozechner/pi-ai';

const MAX_DELIVERY_CONTENT_LENGTH = 12_000;
const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_DELIVERY_IDENTIFIER_LENGTH = 200;
const MAX_REQUEST_DEADLINE_SECONDS = 86_400;

const sharedProperties = {
  targetConversationId: Type.String({
    minLength: 1,
    maxLength: MAX_DELIVERY_IDENTIFIER_LENGTH,
    description: 'Target conversation ID in the same bound project.',
  }),
  targetAgentId: Type.String({
    minLength: 1,
    maxLength: MAX_DELIVERY_IDENTIFIER_LENGTH,
    description: 'Target participant Agent ID.',
  }),
  content: Type.String({
    minLength: 1,
    maxLength: MAX_DELIVERY_CONTENT_LENGTH,
    description: 'Message or request content for the target Agent.',
  }),
  idempotencyKey: Type.String({
    minLength: 1,
    maxLength: MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
    description: 'Stable key for this logical delivery attempt.',
  }),
};

const facadeDefinitions = [
  {
    name: 'conversation_notify',
    label: 'Notify Conversation Agent',
    description: 'Durably deliver a one-way notification to one Agent in another conversation.',
    parameters: Type.Object(sharedProperties, { additionalProperties: false }),
  },
  {
    name: 'conversation_request',
    label: 'Request Conversation Agent',
    description: 'Durably ask one Agent in another conversation for a correlated response.',
    parameters: Type.Object(
      {
        ...sharedProperties,
        deadlineSeconds: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: MAX_REQUEST_DEADLINE_SECONDS,
          description: 'Optional response deadline in seconds.',
        })),
      },
      { additionalProperties: false }
    ),
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
