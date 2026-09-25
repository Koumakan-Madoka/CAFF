/**
 * Thin hand-written HTTP client for the TypeSafe "System One" evaluation API (Jev).
 *
 * Wire contract (verified against https://docs.typesafe.ai/api.md):
 *   POST {baseUrl}/v1/systemone, Authorization: Bearer <key>
 *   Request:  { state: string|object|array, model: string, questions: { [id]: Question } }
 *   Question: { type: 'noul',  instructions, criteria?: { true, false } }
 *             { type: 'choice', instructions, criteria: { [option]: description|null } }  (<= 255 options)
 *             { type: 'score',  instructions, criteria: [level, ...] }                     (2..10 levels)
 *   Response: { model, answers: { [id]: Answer }, usage: { input_tokens, output_tokens } }
 *
 * Contract enforced here (room goal revision 3, criteria c2/c3 + decision d5):
 * - Pre-flight validation rejects invalid requests BEFORE any billable round trip.
 * - Failures always throw; this module never fabricates a Choice/Score/Noul answer.
 * - 422 errors are sanitized: only field paths and reasons are kept, never input
 *   content or the raw upstream response body.
 * - 429/529 retries honor retry-after first, bounded by maxRetries, maxRetryWaitMs,
 *   and the overall timeoutMs.
 * - Budget is a process-local two-layer mechanism, NOT a billing guarantee:
 *   (a) request-count hard limit: decremented synchronously before every send,
 *       retries included, reset on process restart;
 *   (b) token threshold circuit breaker: accumulates real response usage after the
 *       fact; in-flight requests and responses without usage are NOT covered, so
 *       total token consumption can exceed the threshold.
 */

const TYPESAFE_API_BASE_URL = 'https://api.typesafe.ai';
const SYSTEM_ONE_PATH = '/v1/systemone';

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_WAIT_MS = 10_000;
const RETRY_BASE_WAIT_MS = 500;

// The API accepts a 32k-token state. We conservatively assume ~2 characters per
// token (CJK-heavy text can be denser) and cap serialized state at 64k chars.
const DEFAULT_MAX_STATE_CHARS = 64_000;
const DEFAULT_MAX_QUESTIONS = 32;
const DEFAULT_MAX_REQUESTS = 200;
const DEFAULT_TOKEN_BUDGET = 500_000;

const MAX_CHOICE_OPTIONS = 255;
const SCORE_MIN_LEVELS = 2;
const SCORE_MAX_LEVELS = 10;

const MAX_422_FIELDS = 8;
const MAX_422_PATH_LENGTH = 120;
const MAX_422_REASON_LENGTH = 200;

const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

class TypeSafeClientError extends Error {
  code: string;
  statusCode: number;
  fields?: Array<{ path: string; reason: string }>;

  constructor(code: string, message: string, details: any = {}) {
    super(message);
    this.name = 'TypeSafeClientError';
    this.code = code;
    this.statusCode = Number.isFinite(details.statusCode) ? details.statusCode : 0;
    if (Array.isArray(details.fields)) {
      this.fields = details.fields;
    }
  }
}

function trimString(value: any) {
  return String(value == null ? '' : value).trim();
}

function normalizePositiveInt(value: any, fallback: number) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPlainObject(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizePathSegment(segment: any) {
  return trimString(segment).replace(/[^a-zA-Z0-9_\-\[\]]/gu, '').slice(0, 40);
}

function sanitizeReason(value: any) {
  return trimString(value).replace(/\s+/gu, ' ').slice(0, MAX_422_REASON_LENGTH);
}

/**
 * Extracts sanitized field-level validation details from a 422 body.
 * Handles FastAPI-style `{ detail: [{ loc, msg }] }`, `{ detail: string }`,
 * and `{ errors: [{ field|path|loc, message|msg }] }` shapes.
 * Never includes offending input values or raw response text.
 */
function extractValidationFields(payload: any) {
  const fields: Array<{ path: string; reason: string }> = [];
  const pushEntry = (locValue: any, reasonValue: any) => {
    if (fields.length >= MAX_422_FIELDS) {
      return;
    }
    const segments = Array.isArray(locValue) ? locValue : [locValue];
    const path = segments
      .map(sanitizePathSegment)
      .filter(Boolean)
      .join('.')
      .slice(0, MAX_422_PATH_LENGTH);
    const reason = sanitizeReason(reasonValue);
    if (path || reason) {
      fields.push({ path: path || '(unknown)', reason: reason || 'invalid value' });
    }
  };

  const detail = payload && typeof payload === 'object' ? payload.detail : null;
  if (Array.isArray(detail)) {
    for (const entry of detail) {
      if (isPlainObject(entry)) {
        pushEntry(entry.loc || entry.field || entry.path, entry.msg || entry.message);
      }
    }
  } else if (typeof detail === 'string') {
    pushEntry('body', detail);
  }

  const errors = payload && typeof payload === 'object' ? payload.errors : null;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (isPlainObject(entry)) {
        pushEntry(entry.loc || entry.field || entry.path, entry.msg || entry.message || entry.reason);
      }
    }
  }

  return fields;
}

function parseRetryAfterMs(headerValue: any, nowMs: number) {
  const raw = trimString(headerValue);
  if (!raw) {
    return 0;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return 0;
}

function validateQuestions(questions: any, limits: any) {
  if (!isPlainObject(questions)) {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      'questions must be an object mapping question ids to typed questions',
      { statusCode: 0, fields: [{ path: 'questions', reason: 'must be a plain object' }] }
    );
  }

  const entries = Object.entries(questions);
  if (entries.length < 1) {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      'questions must contain at least one question',
      { statusCode: 0, fields: [{ path: 'questions', reason: 'at least one question is required' }] }
    );
  }
  if (entries.length > limits.maxQuestions) {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      `questions exceeds the per-request limit of ${limits.maxQuestions}`,
      { statusCode: 0, fields: [{ path: 'questions', reason: `more than ${limits.maxQuestions} questions` }] }
    );
  }

  for (const [id, questionValue] of Object.entries(questions)) {
    const question = questionValue as any;
    if (!trimString(id) || id.length > 80) {
      throw new TypeSafeClientError(
        'typesafe_validation_failed',
        'question ids must be non-empty and at most 80 characters',
        { statusCode: 0, fields: [{ path: 'questions', reason: 'invalid question id' }] }
      );
    }
    if (!isPlainObject(question)) {
      throw new TypeSafeClientError(
        'typesafe_validation_failed',
        `question "${id}" must be an object`,
        { statusCode: 0, fields: [{ path: `questions.${id}`, reason: 'must be a plain object' }] }
      );
    }
    const type = trimString(question.type).toLowerCase();
    if (!QUESTION_TYPES.has(type)) {
      throw new TypeSafeClientError(
        'typesafe_validation_failed',
        `question "${id}" has unsupported type "${trimString(question.type)}"`,
        { statusCode: 0, fields: [{ path: `questions.${id}.type`, reason: 'must be noul, choice, or score' }] }
      );
    }
    if (question.instructions == null || (typeof question.instructions === 'string' && !trimString(question.instructions))) {
      throw new TypeSafeClientError(
        'typesafe_validation_failed',
        `question "${id}" requires non-empty instructions`,
        { statusCode: 0, fields: [{ path: `questions.${id}.instructions`, reason: 'required' }] }
      );
    }

    if (type === 'choice') {
      const criteria = question.criteria;
      if (!isPlainObject(criteria)) {
        throw new TypeSafeClientError(
          'typesafe_validation_failed',
          `choice question "${id}" requires a criteria map of options`,
          { statusCode: 0, fields: [{ path: `questions.${id}.criteria`, reason: 'must be a plain object' }] }
        );
      }
      const optionCount = Object.keys(criteria).length;
      if (optionCount < 2 || optionCount > MAX_CHOICE_OPTIONS) {
        throw new TypeSafeClientError(
          'typesafe_validation_failed',
          `choice question "${id}" must define between 2 and ${MAX_CHOICE_OPTIONS} options`,
          { statusCode: 0, fields: [{ path: `questions.${id}.criteria`, reason: `must have 2..${MAX_CHOICE_OPTIONS} options` }] }
        );
      }
    }

    if (type === 'score') {
      const criteria = question.criteria;
      if (!Array.isArray(criteria) || criteria.length < SCORE_MIN_LEVELS || criteria.length > SCORE_MAX_LEVELS) {
        throw new TypeSafeClientError(
          'typesafe_validation_failed',
          `score question "${id}" must define between ${SCORE_MIN_LEVELS} and ${SCORE_MAX_LEVELS} ordered levels`,
          { statusCode: 0, fields: [{ path: `questions.${id}.criteria`, reason: `must have ${SCORE_MIN_LEVELS}..${SCORE_MAX_LEVELS} levels` }] }
        );
      }
    }
  }
}

function validateState(state: any, limits: any) {
  if (state == null) {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      'state is required',
      { statusCode: 0, fields: [{ path: 'state', reason: 'required' }] }
    );
  }
  if (typeof state !== 'string' && !isPlainObject(state) && !Array.isArray(state)) {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      'state must be a string, object, or array',
      { statusCode: 0, fields: [{ path: 'state', reason: 'must be a string, object, or array' }] }
    );
  }
  let serializedLength = 0;
  try {
    serializedLength = typeof state === 'string' ? state.length : JSON.stringify(state).length;
  } catch {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      'state could not be serialized to JSON',
      { statusCode: 0, fields: [{ path: 'state', reason: 'not JSON-serializable' }] }
    );
  }
  if (serializedLength > limits.maxStateChars) {
    throw new TypeSafeClientError(
      'typesafe_validation_failed',
      `state exceeds the per-request limit of ${limits.maxStateChars} characters`,
      { statusCode: 0, fields: [{ path: 'state', reason: `larger than ${limits.maxStateChars} characters` }] }
    );
  }
}

function validateAnswers(payload: any, questionIds: string[]) {
  const answers = payload && typeof payload === 'object' ? payload.answers : null;
  if (!isPlainObject(answers)) {
    throw new TypeSafeClientError('typesafe_invalid_response', 'TypeSafe API response did not include an answers object');
  }
  for (const id of questionIds) {
    const answer = answers[id];
    if (!isPlainObject(answer) || !QUESTION_TYPES.has(trimString(answer.type).toLowerCase())) {
      throw new TypeSafeClientError(
        'typesafe_invalid_response',
        `TypeSafe API response is missing a typed answer for question "${id}"`
      );
    }
  }
  return answers;
}

export function createTypeSafeClient(options: any = {}) {
  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const sleepImpl = typeof options.sleep === 'function'
    ? options.sleep
    : (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const apiKey = trimString(options.apiKey || process.env.TYPESAFE_API_KEY);
  const baseUrl = trimString(options.baseUrl || TYPESAFE_API_BASE_URL).replace(/\/+$/u, '') || TYPESAFE_API_BASE_URL;
  const defaultModel = trimString(options.model || process.env.TYPESAFE_MODEL) || DEFAULT_MODEL;

  const limits = {
    timeoutMs: normalizePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxRetries: normalizePositiveInt(options.maxRetries, DEFAULT_MAX_RETRIES),
    maxRetryWaitMs: normalizePositiveInt(options.maxRetryWaitMs, DEFAULT_MAX_RETRY_WAIT_MS),
    maxStateChars: normalizePositiveInt(options.maxStateChars, DEFAULT_MAX_STATE_CHARS),
    maxQuestions: normalizePositiveInt(options.maxQuestions, DEFAULT_MAX_QUESTIONS),
    maxRequests: normalizePositiveInt(options.maxRequests, DEFAULT_MAX_REQUESTS),
    tokenBudget: normalizePositiveInt(options.tokenBudget, DEFAULT_TOKEN_BUDGET),
  };

  // Process-local budget state. Layer (a) is a hard pre-send limit; layer (b) is a
  // post-hoc circuit breaker over known usage only (see module header).
  let requestsUsed = 0;
  let tokensUsed = 0;

  function consumeRequestBudget() {
    // Synchronous check-and-increment: safe to treat as atomic in Node's
    // single-threaded event loop. Runs before every send, retries included.
    if (requestsUsed >= limits.maxRequests) {
      throw new TypeSafeClientError(
        'typesafe_budget_exceeded',
        `TypeSafe request budget exhausted (${requestsUsed}/${limits.maxRequests} requests used; process-local counter, resets on restart)`
      );
    }
    requestsUsed += 1;
  }

  function checkTokenBudget() {
    if (tokensUsed >= limits.tokenBudget) {
      throw new TypeSafeClientError(
        'typesafe_budget_exceeded',
        `TypeSafe token threshold reached (${tokensUsed}/${limits.tokenBudget} known tokens used); circuit breaker open for new requests. Note: this covers reported usage only and is not a billing guarantee`
      );
    }
  }

  function recordUsage(usage: any) {
    if (!usage || typeof usage !== 'object') {
      return;
    }
    const inputTokens = Number(usage.input_tokens);
    const outputTokens = Number(usage.output_tokens);
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      tokensUsed += Math.round(inputTokens);
    }
    if (Number.isFinite(outputTokens) && outputTokens > 0) {
      tokensUsed += Math.round(outputTokens);
    }
  }

  async function ask(input: any = {}) {
    if (!apiKey) {
      throw new TypeSafeClientError('typesafe_not_configured', 'TYPESAFE_API_KEY is not configured');
    }

    const state = input.state;
    const questions = input.questions;
    const model = trimString(input.model) || defaultModel;

    // Pre-flight validation: rejected requests never reach the network and never bill.
    validateState(state, limits);
    validateQuestions(questions, limits);
    const questionIds = Object.keys(questions);
    checkTokenBudget();

    const body = JSON.stringify({ state, model, questions });
    const deadline = Date.now() + limits.timeoutMs;
    let lastRateLimitError: TypeSafeClientError | null = null;

    for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new TypeSafeClientError('typesafe_timeout', `TypeSafe request timed out after ${limits.timeoutMs}ms (including retries)`);
      }

      let response: any;
      consumeRequestBudget();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('typesafe attempt timeout')), remainingMs);
        try {
          response = await fetchImpl(`${baseUrl}${SYSTEM_ONE_PATH}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error: any) {
        if (error && (error.name === 'AbortError' || /timeout/iu.test(trimString(error && error.message)))) {
          throw new TypeSafeClientError('typesafe_timeout', `TypeSafe request timed out after ${limits.timeoutMs}ms`);
        }
        throw new TypeSafeClientError(
          'typesafe_network_error',
          `TypeSafe request failed before receiving a response: ${trimString(error && error.message) || 'network error'}`
        );
      }

      const status = Number(response && response.status) || 0;

      if (status === 429 || status === 529) {
        const kind = status === 429 ? 'rate_limited' : 'overloaded';
        lastRateLimitError = new TypeSafeClientError(
          `typesafe_${kind}`,
          `TypeSafe API ${status === 429 ? 'rate limited the request (429)' : 'is overloaded (529)'}`
        );
        if (attempt >= limits.maxRetries) {
          throw new TypeSafeClientError(
            `typesafe_${kind}`,
            `TypeSafe API ${status} after ${attempt + 1} attempts (max retries ${limits.maxRetries})`
          );
        }
        const retryAfterMs = parseRetryAfterMs(
          response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : '',
          Date.now()
        );
        const fallbackMs = RETRY_BASE_WAIT_MS * (2 ** attempt);
        const waitMs = Math.min(retryAfterMs > 0 ? retryAfterMs : fallbackMs, limits.maxRetryWaitMs);
        if (Date.now() + waitMs >= deadline) {
          throw new TypeSafeClientError(
            'typesafe_timeout',
            `TypeSafe request aborted: required backoff of ${waitMs}ms exceeds the remaining timeout budget`
          );
        }
        await sleepImpl(waitMs);
        continue;
      }

      if (status === 401) {
        throw new TypeSafeClientError('typesafe_auth_failed', 'TypeSafe API rejected the request (401): TYPESAFE_API_KEY is missing or invalid');
      }

      const text = await response.text();
      let payload: any = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new TypeSafeClientError('typesafe_invalid_response', `TypeSafe API returned invalid JSON (HTTP ${status})`);
        }
      }

      if (status === 422) {
        const fields = extractValidationFields(payload);
        throw new TypeSafeClientError(
          'typesafe_unprocessable',
          fields.length
            ? `TypeSafe API rejected the request body (422): ${fields.map((field) => `${field.path}: ${field.reason}`).join('; ')}`
            : 'TypeSafe API rejected the request body (422) without field details',
          { statusCode: 422, fields }
        );
      }

      if (status < 200 || status >= 300) {
        throw new TypeSafeClientError(
          'typesafe_unexpected_status',
          `TypeSafe API returned unexpected HTTP ${status}`
        );
      }

      const answers = validateAnswers(payload, questionIds);
      recordUsage(payload.usage);
      return {
        model: trimString(payload.model) || model,
        answers,
        usage: {
          input_tokens: Number(payload.usage && payload.usage.input_tokens) || 0,
          output_tokens: Number(payload.usage && payload.usage.output_tokens) || 0,
        },
      };
    }

    // Unreachable in practice (the loop either returns or throws), but never fall
    // through to an implicit success.
    throw lastRateLimitError || new TypeSafeClientError('typesafe_invalid_response', 'TypeSafe request ended without a result');
  }

  function getBudgetStatus() {
    return {
      requestsUsed,
      maxRequests: limits.maxRequests,
      tokensUsed,
      tokenBudget: limits.tokenBudget,
      note: 'Process-local counters; reset on restart. Token figure covers reported usage only and is not a billing guarantee.',
    };
  }

  return {
    ask,
    getBudgetStatus,
  };
}

export { TypeSafeClientError };
