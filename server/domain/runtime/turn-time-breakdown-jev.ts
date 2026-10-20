import crypto from 'node:crypto';

// Turn time breakdown — JEV fallback classifier (contract §6).
// Rules classify first; steps the rules cannot place (opaque wrapper
// scripts, unknown binaries) come here. JEV answers with low confidence,
// timeouts, errors, and the disabled switch all degrade to `unclassified`
// with an honest `jevStatus` — never a hard guess, never a thrown error
// into the turn path.

export const JEV_STEP_CATEGORIES = [
  'read',
  'write',
  'test',
  'build-check',
  'process-report',
  'exception-retry',
  'unclassified',
];

export const JEV_MIN_CONFIDENCE = 0.6;

const OUTPUT_HEAD_CHARS = 2000;
const OUTPUT_TAIL_CHARS = 2000;

// §6: single-step output is truncated head 2000 + tail 2000 (4000 max) to
// bound cost and latency; the client's own size caps still apply on top.
export function truncateStepOutput(text: any) {
  const value = String(text || '');

  if (value.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) {
    return value;
  }

  const head = value.slice(0, OUTPUT_HEAD_CHARS);
  const tail = value.slice(value.length - OUTPUT_TAIL_CHARS);

  return `${head}\n…[truncated ${value.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS} chars]…\n${tail}`;
}

// A coarse, stable output fingerprint for the cache key: same command with
// a slightly longer log must still hit the cache. Length is bucketed; only
// semantic signals (fail fingerprint, exit status) are exact.
function outputFingerprint(output: any, isError: any) {
  const text = String(output || '');
  const lengthBucket = text.length === 0 ? 0 : Math.min(6, Math.floor(Math.log10(text.length + 1)));
  const hasFailFingerprint = /(^|\n)#\s*fail\s+[1-9]/i.test(text)
    || /[1-9]\d*\s+(failing|failed)/i.test(text)
    || /failed\s+[1-9]/i.test(text);
  const hasPassFingerprint = /(^|\n)#\s*pass\s+\d+/i.test(text) || /\b\d+\s+passed\b/i.test(text);

  return `len~${lengthBucket}|err:${isError === true ? 1 : 0}|fail:${hasFailFingerprint ? 1 : 0}|pass:${hasPassFingerprint ? 1 : 0}`;
}

function extractArgv(command: any) {
  const words = String(command || '').split(/\s+/).filter(Boolean);
  const argv0 = words.length > 0 ? words[0] : '';
  // First positional (script path / subcommand) is part of command identity:
  // `bash scripts/run-all.sh` and `bash scripts/other.sh` must not share a
  // cache entry. Remaining positionals are volatile paths; flags are kept
  // without values so the key is stable across argument churn.
  const firstPositional = words.slice(1).find((word) => !word.startsWith('-')) || '';
  const flags = words.slice(1).filter((word) => word.startsWith('-')).sort();

  return { argv0, firstPositional, flags };
}

// §6: sha256(toolName + argv[0] + first positional + flags-only(argv) +
// output fingerprint).
export function jevCacheKey(step: any) {
  const toolName = String(step && step.toolName ? step.toolName : 'tool');
  const command = extractStepCommand(step);
  const { argv0, firstPositional, flags } = extractArgv(command);
  const fingerprint = outputFingerprint(step && step.output, step && step.isError);

  return crypto
    .createHash('sha256')
    .update(JSON.stringify([toolName, argv0, firstPositional, flags, fingerprint]))
    .digest('hex');
}

function extractStepCommand(step: any) {
  const args = step && step.args;

  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);

      if (parsed && typeof parsed.command === 'string') {
        return parsed.command;
      }
    } catch {
      // fall through: raw string args
    }

    return args;
  }

  if (args && typeof args === 'object' && typeof args.command === 'string') {
    return args.command;
  }

  return '';
}

// State sent to JEV (v1: no redaction, per the user's 2026-10-20 decision;
// output is truncated to bound cost). Structured so the model sees the
// fields, not a prose blob.
export function buildJevState(step: any) {
  return {
    toolName: String(step && step.toolName ? step.toolName : 'tool'),
    command: extractStepCommand(step),
    output: truncateStepOutput(step && step.output),
    isError: step && step.isError === true,
    durationMs: Number.isFinite(step && step.durationMs) ? step.durationMs : null,
  };
}

const CATEGORY_CRITERIA: Record<string, string> = {
  read: 'The step only inspects: reading files, searching, listing, read-only git (log/show/diff/status). It does not modify anything.',
  write: 'The step modifies repository files or state: editing/writing files, sed -i, redirections into files, mv/cp/rm/mkdir, git add/commit/checkout of paths.',
  test: 'The step runs tests: unit/integration suites, full regressions, wrapper scripts that actually invoke a test runner.',
  'build-check': 'The step builds or statically checks without running tests: compile, typecheck, lint, bundlers.',
  'process-report': 'The step is process/reporting tooling: posting messages, updating goals or plans, delegations, status reporting.',
  'exception-retry': 'The step failed before doing any semantic work: tool invocation errors, missing tools, infrastructure failures worth retrying.',
  unclassified: 'None of the above fits with reasonable confidence.',
};

const RUN_KIND_CRITERIA: Record<string, string> = {
  'full-regression': 'The whole standard test suite runs (no path/file subset).',
  targeted: 'Only a subset of tests runs (specific files, paths, or name filters).',
  'not-a-test': 'The step is not a test run.',
};

function buildQuestions() {
  return {
    category: {
      type: 'choice',
      instructions: [
        'You are classifying one tool-execution step from a coding agent session for a per-turn time breakdown.',
        'Decide what the step actually DID (judge wrapper scripts by the command and the output together: a shell script whose output is a test summary ran tests).',
        'Pick exactly one category. If no category fits with reasonable confidence, pick "unclassified".',
      ].join(' '),
      criteria: CATEGORY_CRITERIA,
    },
    run_kind: {
      type: 'choice',
      instructions: 'If (and only if) the step ran tests: did it run the whole standard suite or a subset? Pick "not-a-test" when the step is not a test run.',
      criteria: RUN_KIND_CRITERIA,
    },
  };
}

function mapErrorToStatus(error: any) {
  const code = String(error && error.code ? error.code : '');

  if (code === 'typesafe_timeout') {
    return 'timeout';
  }

  if (code === 'typesafe_not_configured') {
    return 'disabled';
  }

  return 'error';
}

export function createJevClassifier(options: any = {}) {
  const client = options.client || null;
  const cache = options.cache || null; // { get(key), set(key, entry) }
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence : JEV_MIN_CONFIDENCE;
  const enabled = options.enabled !== false && !!client;

  async function classifyStep(step: any) {
    if (!enabled) {
      return { category: 'unclassified', subcategory: null, classifiedBy: 'unclassified', jevStatus: 'disabled', confidence: null };
    }

    const cacheKey = jevCacheKey(step);
    const cached = cache && typeof cache.get === 'function' ? cache.get(cacheKey) : null;

    if (cached && JEV_STEP_CATEGORIES.includes(cached.category)) {
      return {
        category: cached.category,
        subcategory: cached.subcategory || null,
        runKind: cached.runKind || null,
        classifiedBy: 'jev-cache',
        jevStatus: 'ok',
        confidence: Number.isFinite(cached.confidence) ? cached.confidence : null,
      };
    }

    let response: any;

    try {
      response = await client.ask({ state: buildJevState(step), questions: buildQuestions() });
    } catch (error: any) {
      return {
        category: 'unclassified',
        subcategory: null,
        classifiedBy: 'unclassified',
        jevStatus: mapErrorToStatus(error),
        confidence: null,
      };
    }

    const answers = response && response.answers ? response.answers : {};
    const categoryAnswer = answers.category;
    const runKindAnswer = answers.run_kind;
    const choice = categoryAnswer && categoryAnswer.choice;
    const confidence = Number.isFinite(categoryAnswer && categoryAnswer.confidence)
      ? categoryAnswer.confidence
      : null;

    if (!choice || choice === 'unclassified' || !JEV_STEP_CATEGORIES.includes(choice)) {
      return { category: 'unclassified', subcategory: null, classifiedBy: 'unclassified', jevStatus: 'ok', confidence };
    }

    if (confidence !== null && confidence < minConfidence) {
      return { category: 'unclassified', subcategory: null, classifiedBy: 'unclassified', jevStatus: 'low-confidence', confidence };
    }

    let runKind = null;

    if (choice === 'test' && runKindAnswer && (runKindAnswer.choice === 'full-regression' || runKindAnswer.choice === 'targeted')) {
      runKind = runKindAnswer.choice;
    }

    if (cache && typeof cache.set === 'function') {
      try {
        cache.set(cacheKey, { category: choice, runKind, confidence });
      } catch {
        // Cache persistence is best-effort; a failed write never fails classification.
      }
    }

    return {
      category: choice,
      subcategory: null,
      runKind,
      classifiedBy: 'jev',
      jevStatus: 'ok',
      confidence,
    };
  }

  return { classifyStep, enabled };
}
