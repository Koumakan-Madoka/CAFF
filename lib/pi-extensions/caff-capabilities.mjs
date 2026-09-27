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

const jevQuestionSchema = Type.Union([
  Type.Object({
    type: Type.Literal('noul'),
    instructions: Type.Any({ description: 'The yes/no question to evaluate (string, object, or array).' }),
    criteria: Type.Optional(Type.Object({
      true: Type.Optional(Type.Any({ description: 'What a yes (value near 1) means.' })),
      false: Type.Optional(Type.Any({ description: 'What a no (value near 0) means.' })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('choice'),
    instructions: Type.Any({ description: 'What the model should decide (string, object, or array).' }),
    criteria: Type.Record(Type.String(), Type.Any(), { description: 'Map of option to rubric description (null allowed). 2..255 options.' }),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal('score'),
    instructions: Type.Any({ description: 'What the model should rate (string, object, or array).' }),
    criteria: Type.Array(Type.Any(), { minItems: 2, maxItems: 10, description: 'Ordered level descriptions, 2..10 levels.' }),
  }, { additionalProperties: false }),
]);

const facadeDefinitions = [
  {
    name: 'jev_ask',
    label: 'Ask Jev (TypeSafe System One)',
    description: 'Evaluate a state against typed questions with the TypeSafe System One model (Jev). Returns structured answers keyed by your question ids: noul -> { noul: 0..1 }, choice -> { choice, probabilities, confidence }, score -> { score, legend, probabilities, confidence }. Keep each question atomic (a judgment a person could make in seconds); compose complex judgments in your own code. This tool is DISABLED BY DEFAULT: it fails until the server sets TYPESAFE_ENABLED=true and TYPESAFE_API_KEY. Never put secrets or personal data in state or questions. Per-call hard limits: state <= 64k serialized chars, <= 32 questions, choice <= 255 options, score 2..10 levels. Calls count against a process-local request budget and a known-usage token threshold; when exhausted the tool refuses new calls. Question ids and choice option names must not contain reserved substrings (secret, token, credential, password, authorization, cookie, header, command, transport, server, toolname, raw) because they would fail the result projection safety layer. All failures are explicit errors, never fabricated answers.',
    parameters: Type.Object({
      state: Type.Union([
        Type.String({ maxLength: 64000, description: 'Text to evaluate.' }),
        Type.Record(Type.String(), Type.Any()),
        Type.Array(Type.Any()),
      ], { description: 'The content to evaluate: a plain string, or structured data (object/array). Max 64k serialized characters.' }),
      questions: Type.Record(Type.String({ minLength: 1, maxLength: 80 }), jevQuestionSchema, { description: 'Map of question id to typed question. 1..32 entries; answers return under the same ids.' }),
      model: Type.Optional(Type.String({ maxLength: 120, description: 'Model override; defaults to the server-configured model (jev-latest).' })),
    }, { additionalProperties: false }),
  },
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
