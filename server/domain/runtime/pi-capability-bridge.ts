const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createHttpError } = require('../../http/http-errors');

import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { HttpError } from '../../http/http-errors';

type UnknownRecord = Record<string, unknown>;

type ConversationCapabilityArguments = UnknownRecord & {
  targetConversationId: string;
  targetAgentId: string;
  content: string;
  idempotencyKey: string;
  deadlineSeconds?: number;
};

type PiCapabilityPrincipal = UnknownRecord & {
  invocationId: string;
  sourceConversationId: string;
  sourceAgentId: string;
  projectScopeId: string;
  traceId: string;
};

type PiCapabilityExecutionInput = {
  principal: PiCapabilityPrincipal;
  arguments: UnknownRecord;
  context?: unknown;
  signal?: AbortSignal;
};

type PiCapabilityHandler = (input: PiCapabilityExecutionInput) => unknown | Promise<unknown>;
type PiCapabilityArgumentValidator = (input: unknown) => UnknownRecord;
type PiCapabilityResultProjector = (rawResult: unknown) => unknown;

type PiCapabilityDefinitionBase = {
  facade: string;
  validateArguments: PiCapabilityArgumentValidator;
  projectResult: PiCapabilityResultProjector;
  sensitiveValues?: unknown[];
  timeoutMs?: unknown;
};

type InternalPiCapabilityDefinition = PiCapabilityDefinitionBase & {
  kind: 'internal';
  execute: PiCapabilityHandler;
};

type McpPiCapabilityDefinition = PiCapabilityDefinitionBase & {
  kind: 'mcp';
  transport: UnknownRecord & {
    type: 'stdio';
    command: unknown;
    args?: unknown;
    env?: unknown;
    cwd?: unknown;
    stderr?: unknown;
  };
  toolName: string;
  buildArguments: (input: {
    arguments: UnknownRecord;
    principal: PiCapabilityPrincipal;
  }) => unknown;
};

type PiCapabilityDefinition = InternalPiCapabilityDefinition | McpPiCapabilityDefinition;

type PiCapabilityAuditEvent = {
  facade: string;
  capabilityKind: PiCapabilityDefinition['kind'];
  status: 'succeeded' | 'failed';
  durationMs: number;
  invocationId: string;
  sourceConversationId: string;
  errorCode?: string;
};

type PiCapabilityBridgeOptions = {
  capabilities?: unknown;
  onAudit?: (event: PiCapabilityAuditEvent) => void;
};

type PiCapabilityInvocationInput = {
  principal?: unknown;
  arguments?: unknown;
  context?: unknown;
  signal?: AbortSignal;
};

const MAX_DELIVERY_CONTENT_LENGTH = 12_000;
const MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_DELIVERY_IDENTIFIER_LENGTH = 200;
const MAX_REQUEST_DEADLINE_SECONDS = 86_400;
const DEFAULT_MCP_TIMEOUT_MS = 10_000;
const MAX_MCP_TIMEOUT_MS = 120_000;

const FORBIDDEN_PROXY_ARGUMENT_NAMES = new Set([
  'server',
  'serverId',
  'serverUrl',
  'tool',
  'toolName',
  'transport',
  'command',
  'env',
  'headers',
  'credential',
  'credentials',
  'rawArguments',
  'arguments',
  'fallbackAction',
]);

function createCapabilityError(statusCode: number, code: string, message: string): HttpError & { code: string } {
  return createHttpError(statusCode, message, { code }) as HttpError & { code: string };
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequiredText(value: unknown, fieldName: string, maxLength: number) {
  if (typeof value !== 'string') {
    throw createCapabilityError(400, 'pi_capability_invalid_arguments', `${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw createCapabilityError(400, 'pi_capability_invalid_arguments', `${fieldName} is required`);
  }
  if (normalized.length > maxLength) {
    throw createCapabilityError(
      400,
      'pi_capability_invalid_arguments',
      `${fieldName} must be at most ${maxLength} characters`
    );
  }
  return normalized;
}

function rejectForbiddenProxyArguments(input: unknown): asserts input is UnknownRecord {
  if (!isPlainObject(input)) {
    throw createCapabilityError(400, 'pi_capability_invalid_arguments', 'Capability arguments must be an object');
  }

  const forbiddenField = Object.keys(input).find((fieldName) => FORBIDDEN_PROXY_ARGUMENT_NAMES.has(fieldName));
  if (forbiddenField) {
    throw createCapabilityError(
      400,
      'pi_capability_invalid_arguments',
      `Capability argument is not allowed: ${forbiddenField}`
    );
  }
}

function validateConversationArguments(kind: 'notify' | 'request', input: unknown): ConversationCapabilityArguments {
  rejectForbiddenProxyArguments(input);
  const allowedFields = new Set([
    'targetConversationId',
    'targetAgentId',
    'content',
    'idempotencyKey',
    ...(kind === 'request' ? ['deadlineSeconds'] : []),
  ]);
  const unknownField = Object.keys(input).find((fieldName) => !allowedFields.has(fieldName));
  if (unknownField) {
    throw createCapabilityError(
      400,
      'pi_capability_invalid_arguments',
      `Unknown ${kind} capability argument: ${unknownField}`
    );
  }

  const normalized: ConversationCapabilityArguments = {
    targetConversationId: normalizeRequiredText(
      input.targetConversationId,
      'targetConversationId',
      MAX_DELIVERY_IDENTIFIER_LENGTH
    ),
    targetAgentId: normalizeRequiredText(
      input.targetAgentId,
      'targetAgentId',
      MAX_DELIVERY_IDENTIFIER_LENGTH
    ),
    content: normalizeRequiredText(input.content, 'content', MAX_DELIVERY_CONTENT_LENGTH),
    idempotencyKey: normalizeRequiredText(
      input.idempotencyKey,
      'idempotencyKey',
      MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH
    ),
  };

  const deadlineSeconds = input.deadlineSeconds;
  if (kind === 'request' && deadlineSeconds !== undefined) {
    if (
      typeof deadlineSeconds !== 'number'
      || !Number.isInteger(deadlineSeconds)
      || deadlineSeconds < 1
      || deadlineSeconds > MAX_REQUEST_DEADLINE_SECONDS
    ) {
      throw createCapabilityError(
        400,
        'pi_capability_invalid_arguments',
        `deadlineSeconds must be an integer between 1 and ${MAX_REQUEST_DEADLINE_SECONDS}`
      );
    }
    normalized.deadlineSeconds = deadlineSeconds;
  }

  return normalized;
}

function validatePrincipal(principal: unknown): PiCapabilityPrincipal {
  if (!isPlainObject(principal)) {
    throw createCapabilityError(401, 'pi_capability_invalid_principal', 'Capability principal is required');
  }

  const requiredFields = [
    'invocationId',
    'sourceConversationId',
    'sourceAgentId',
    'projectScopeId',
    'traceId',
  ];
  for (const fieldName of requiredFields) {
    if (!String(principal[fieldName] || '').trim()) {
      throw createCapabilityError(401, 'pi_capability_invalid_principal', 'Capability principal is incomplete');
    }
  }
  return principal as PiCapabilityPrincipal;
}

function projectConversationDeliveryResult(result: unknown) {
  const resultRecord = isPlainObject(result) ? result : null;
  const delivery = resultRecord && isPlainObject(resultRecord.delivery) ? resultRecord.delivery : null;
  if (!delivery || !String(delivery.id || '').trim()) {
    throw new Error('Delivery result is missing its canonical delivery');
  }

  return {
    deliveryId: String(delivery.id),
    duplicate: resultRecord?.duplicate === true,
    kind: String(delivery.kind || ''),
    targetConversationId: String(delivery.targetConversationId || ''),
    targetAgentId: String(delivery.targetAgentId || ''),
    messageStatus: String(delivery.messageStatus || ''),
    dispatchStatus: String(delivery.dispatchStatus || ''),
    responseStatus: String(delivery.responseStatus || ''),
    deadlineAt: delivery.deadlineAt ? String(delivery.deadlineAt) : null,
    targetMessageId: resultRecord?.targetMessageId ? String(resultRecord.targetMessageId) : null,
    sourceReceiptMessageId: resultRecord?.sourceReceiptMessageId ? String(resultRecord.sourceReceiptMessageId) : null,
  };
}

export function createConversationCapabilityDefinitions(handlers: unknown = {}): InternalPiCapabilityDefinition[] {
  if (!isPlainObject(handlers) || typeof handlers.notify !== 'function' || typeof handlers.request !== 'function') {
    throw new Error('Conversation capability handlers are required');
  }

  const notify = handlers.notify as PiCapabilityHandler;
  const request = handlers.request as PiCapabilityHandler;

  return [
    {
      facade: 'conversation_notify',
      kind: 'internal',
      validateArguments: (input: unknown) => validateConversationArguments('notify', input),
      execute: notify,
      projectResult: projectConversationDeliveryResult,
    },
    {
      facade: 'conversation_request',
      kind: 'internal',
      validateArguments: (input: unknown) => validateConversationArguments('request', input),
      execute: request,
      projectResult: projectConversationDeliveryResult,
    },
  ];
}

function normalizeCapabilityDefinitions(capabilities: unknown): Map<string, PiCapabilityDefinition> {
  const definitions = Array.isArray(capabilities) ? capabilities as unknown[] : [];
  const registry = new Map<string, PiCapabilityDefinition>();

  for (const definitionValue of definitions) {
    if (!isPlainObject(definitionValue)) {
      throw new Error('Pi capability definitions must be objects');
    }

    const definition = definitionValue;

    const facade = String(definition.facade || '').trim();
    if (!facade || !/^[a-z][a-z0-9_]*$/u.test(facade)) {
      throw new Error('Pi capability facade names must use lower snake_case');
    }
    if (registry.has(facade)) {
      throw new Error(`Duplicate Pi capability facade: ${facade}`);
    }
    if (definition.kind !== 'internal' && definition.kind !== 'mcp') {
      throw new Error(`Unsupported Pi capability kind for ${facade}`);
    }
    if (typeof definition.validateArguments !== 'function') {
      throw new Error(`Pi capability ${facade} requires an argument validator`);
    }
    if (typeof definition.projectResult !== 'function') {
      throw new Error(`Pi capability ${facade} requires a result projector`);
    }

    if (definition.kind === 'internal' && typeof definition.execute !== 'function') {
      throw new Error(`Internal Pi capability ${facade} requires an execute handler`);
    }

    if (definition.kind === 'mcp') {
      const transport = definition.transport;
      if (
        !isPlainObject(transport)
        || transport.type !== 'stdio'
        || !String(transport.command || '').trim()
        || !String(definition.toolName || '').trim()
        || typeof definition.buildArguments !== 'function'
      ) {
        throw new Error(`MCP Pi capability ${facade} requires fixed stdio server/tool configuration`);
      }
    }

    registry.set(facade, Object.freeze({ ...definition, facade }) as PiCapabilityDefinition);
  }

  return registry;
}

function normalizeTimeoutMs(value: unknown) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_MCP_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_MCP_TIMEOUT_MS);
}

function containsUnsafeProjection(
  value: unknown,
  sensitiveValues: string[],
  seen = new WeakSet<object>(),
  depth = 0
): boolean {
  if (depth > 8) {
    return true;
  }
  if (value === null || typeof value === 'boolean') {
    return false;
  }
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return sensitiveValues.some((secret) => secret && value.includes(secret));
  }
  if (Array.isArray(value)) {
    return value.length > 200 || value.some((entry) => containsUnsafeProjection(entry, sensitiveValues, seen, depth + 1));
  }
  if (!isPlainObject(value) || seen.has(value)) {
    return true;
  }

  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:secret|token|credential|password|authorization|cookie|headers?|command|transport|server(?:url|id)?|toolname|raw)/iu.test(key)) {
      return true;
    }
    if (containsUnsafeProjection(entry, sensitiveValues, seen, depth + 1)) {
      return true;
    }
  }
  seen.delete(value);
  return false;
}

function safeProjectResult(definition: PiCapabilityDefinition, rawResult: unknown): UnknownRecord {
  let projected: unknown;
  try {
    projected = definition.projectResult(rawResult);
  } catch {
    throw createCapabilityError(
      502,
      'pi_capability_projection_failed',
      'Pi capability result could not be safely projected'
    );
  }

  const sensitiveValues = Array.isArray(definition.sensitiveValues)
    ? definition.sensitiveValues.map((value: unknown) => String(value || '')).filter(Boolean)
    : [];
  if (!isPlainObject(projected) || containsUnsafeProjection(projected, sensitiveValues)) {
    throw createCapabilityError(
      502,
      'pi_capability_projection_failed',
      'Pi capability result could not be safely projected'
    );
  }
  return projected;
}

function readCapabilityErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return '';
  }
  return String((error as { code?: unknown }).code || '').trim();
}

async function invokeMcpCapability(
  definition: McpPiCapabilityDefinition,
  input: PiCapabilityExecutionInput
) {
  const timeoutMs = normalizeTimeoutMs(definition.timeoutMs);
  const controller = new AbortController();
  const externalSignal = input.signal instanceof AbortSignal ? input.signal : null;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Pi capability timed out'));
  }, timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal && externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const transportConfig = definition.transport;
  const transportOptions: StdioServerParameters = {
    command: String(transportConfig.command),
    args: Array.isArray(transportConfig.args) ? transportConfig.args.map((value: unknown) => String(value)) : [],
    ...(isPlainObject(transportConfig.env)
      ? { env: Object.fromEntries(Object.entries(transportConfig.env).map(([key, value]) => [key, String(value)])) }
      : {}),
    ...(transportConfig.cwd ? { cwd: String(transportConfig.cwd) } : {}),
    stderr: (transportConfig.stderr || 'pipe') as StdioServerParameters['stderr'],
  };
  const transport = new StdioClientTransport(transportOptions);
  const client = new Client({ name: 'caff-pi-capability-bridge', version: '1.0.0' });

  try {
    const mcpArguments = definition.buildArguments({
      arguments: input.arguments,
      principal: input.principal,
    });
    if (!isPlainObject(mcpArguments)) {
      throw createCapabilityError(
        500,
        'pi_capability_mcp_configuration_invalid',
        'Pi capability MCP adapter is misconfigured'
      );
    }

    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
    return await client.callTool(
      {
        name: String(definition.toolName),
        arguments: mcpArguments,
      },
      undefined,
      {
        signal: controller.signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      }
    );
  } catch (error) {
    if (timedOut) {
      throw createCapabilityError(504, 'pi_capability_timeout', 'Pi capability timed out');
    }
    if (readCapabilityErrorCode(error).startsWith('pi_capability_')) {
      throw error;
    }
    throw createCapabilityError(502, 'pi_capability_mcp_failed', 'Pi capability MCP call failed');
  } finally {
    clearTimeout(timeout);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
    try {
      await client.close();
    } catch {}
  }
}

export function createPiCapabilityBridge(options: PiCapabilityBridgeOptions = {}) {
  const registry = normalizeCapabilityDefinitions(options.capabilities);
  const onAudit = typeof options.onAudit === 'function' ? options.onAudit : () => {};

  async function invokeFacade(facadeValue: unknown, input: PiCapabilityInvocationInput = {}) {
    const facade = String(facadeValue || '').trim();
    const definition = registry.get(facade);
    if (!definition) {
      throw createCapabilityError(404, 'pi_capability_unknown_facade', 'Unknown Pi capability facade');
    }

    const startedAt = Date.now();
    const principal = validatePrincipal(input.principal);
    let validatedArguments: UnknownRecord;
    try {
      rejectForbiddenProxyArguments(input.arguments);
      validatedArguments = definition.validateArguments(input.arguments);
      if (!isPlainObject(validatedArguments)) {
        throw new Error('Capability validator returned an invalid object');
      }
    } catch (error) {
      if (readCapabilityErrorCode(error) === 'pi_capability_invalid_arguments') {
        throw error;
      }
      throw createCapabilityError(400, 'pi_capability_invalid_arguments', 'Pi capability arguments are invalid');
    }

    try {
      const rawResult = definition.kind === 'internal'
        ? await definition.execute({
            principal,
            arguments: validatedArguments,
            context: input.context,
            signal: input.signal,
          })
        : await invokeMcpCapability(definition, {
            principal,
            arguments: validatedArguments,
            signal: input.signal,
          });
      const result = safeProjectResult(definition, rawResult);
      onAudit({
        facade,
        capabilityKind: definition.kind,
        status: 'succeeded',
        durationMs: Date.now() - startedAt,
        invocationId: principal.invocationId,
        sourceConversationId: principal.sourceConversationId,
      });
      return result;
    } catch (error) {
      const errorCode = readCapabilityErrorCode(error) || 'pi_capability_failed';
      onAudit({
        facade,
        capabilityKind: definition.kind,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        invocationId: principal.invocationId,
        sourceConversationId: principal.sourceConversationId,
        errorCode,
      });
      throw error;
    }
  }

  return {
    invokeFacade,
    listFacades() {
      return Array.from(registry.keys());
    },
  };
}
