import { PI_DEFAULT_MAX_TOKENS } from '../models/model-provider-config';

const RETRYABLE_OUTPUT_CODES = new Set(['empty_text', 'length_exhausted']);
const PROVIDER_FAILURE_STOP_REASONS = new Set(['error', 'aborted']);

function normalizeText(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeContentType(value: any) {
  return normalizeText(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[_-]/gu, '')
    .toLowerCase()
    .slice(0, 40);
}

function projectContentType(value: any) {
  const type = normalizeContentType(value);
  if (type === 'outputtext') return 'output_text';
  if (type === 'redactedthinking') return 'redacted_thinking';
  if (['text', 'thinking', 'reasoning', 'toolcall', 'refusal'].includes(type)) return type;
  return type ? 'unknown' : '';
}

function modelMessage(output: any) {
  return output && (output.message || output.assistantMessage || output);
}

function nonNegativeInteger(value: any) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function usageValue(usage: any, fields: string[]) {
  for (const field of fields) {
    const value = nonNegativeInteger(usage && usage[field]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

export function resolveSystemModelOutputBudget(model: any) {
  const configured = Number(model && model.maxTokens);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : PI_DEFAULT_MAX_TOKENS;
}

export function isSystemModelAssistantOutput(output: any) {
  const message = modelMessage(output);
  return Boolean(
    message
    && typeof message === 'object'
    && (
      message.role === 'assistant'
      || Array.isArray(message.content)
      || normalizeText(message.stopReason)
    )
  );
}

export function extractSystemModelVisibleText(output: any) {
  if (typeof output === 'string') {
    return output.trim();
  }

  const message = modelMessage(output);
  if (typeof (message && message.content) === 'string') {
    return String(message.content).trim();
  }

  const content = Array.isArray(message && message.content) ? message.content : [];
  return content
    .map((item: any) => {
      if (typeof item === 'string') {
        return item.trim();
      }
      if (!item || typeof item !== 'object') {
        return '';
      }
      const type = normalizeContentType(item.type);
      if (type === 'thinking' || type === 'reasoning' || type === 'redactedthinking') {
        return '';
      }
      return normalizeText(item.text || item.content || item.output_text || item.refusal);
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function projectSystemModelOutputAttempt(output: any, options: any = {}) {
  const message = modelMessage(output);
  const content = Array.isArray(message && message.content) ? message.content : [];
  const contentBlockTypes = Array.from(new Set(content
    .map((item: any) => projectContentType(item && item.type))
    .filter(Boolean)))
    .slice(0, 12);
  const visibleText = extractSystemModelVisibleText(output);
  const stopReason = normalizeText(message && message.stopReason).toLowerCase().slice(0, 40);
  const thinking = normalizeText(options.thinking) || 'off';
  const attempt = Number.isInteger(options.attempt) && options.attempt > 0 ? options.attempt : 1;
  const usage = message && message.usage && typeof message.usage === 'object' ? message.usage : {};
  let diagnosticCode = '';

  if (PROVIDER_FAILURE_STOP_REASONS.has(stopReason)) {
    diagnosticCode = stopReason === 'aborted' ? 'aborted' : 'provider_error';
  } else if (stopReason === 'length') {
    diagnosticCode = 'length_exhausted';
  } else if (!visibleText) {
    diagnosticCode = 'empty_text';
  }

  const diagnostic = {
    attempt,
    maxTokens: resolveSystemModelOutputBudget({ maxTokens: options.maxTokens }),
    thinking,
    thinkingDisabled: thinking === 'off',
    stopReason,
    contentBlockTypes,
    visibleTextChars: visibleText.length,
    thinkingOnly: !visibleText && contentBlockTypes.some((type) => {
      const normalized = normalizeContentType(type);
      return normalized === 'thinking' || normalized === 'reasoning' || normalized === 'redactedthinking';
    }),
    usage: {
      inputTokens: usageValue(usage, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']),
      outputTokens: usageValue(usage, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']),
      reasoningTokens: usageValue(usage, ['reasoning', 'reasoningTokens', 'reasoning_tokens']),
      totalTokens: usageValue(usage, ['totalTokens', 'total_tokens']),
    },
    diagnosticCode,
    retryScheduled: false,
  };

  return {
    visibleText,
    diagnostic,
    retryEligible: attempt === 1
      && thinking !== 'off'
      && RETRYABLE_OUTPUT_CODES.has(diagnosticCode),
  };
}

export function markSystemModelInvalidOutput(diagnostic: any) {
  return {
    ...diagnostic,
    diagnosticCode: 'invalid_output',
    retryScheduled: false,
  };
}

export function safeSystemModelErrorText(value: any, maxLength = 800) {
  const raw = value && value.message ? value.message : String(value || 'Unknown model failure');
  const redacted = raw
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, '$1[redacted]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|token|password|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export class SystemModelOutputError extends Error {
  diagnostic: any;
  diagnosticCode: string;

  constructor(message: string, diagnostic: any) {
    super(message);
    this.name = 'SystemModelOutputError';
    this.diagnostic = diagnostic;
    this.diagnosticCode = normalizeText(diagnostic && diagnostic.diagnosticCode) || 'invalid_output';
  }
}
