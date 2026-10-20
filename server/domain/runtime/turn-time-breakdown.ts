import fs from 'node:fs';
import path from 'node:path';

import { isPathWithin } from '../conversation/turn/session-export';

// Turn time breakdown — session JSONL step parser + rule classifier.
// Contract: docs/engineering/backend/turn-time-breakdown.md §4 (parser) and
// §5 (rule classifier). The parser reads both row kinds: assistant rows
// supply tool_call starts (shared per message for parallel calls), toolResult
// rows supply ends, output, and isError, joined by toolCallId.

export const TIME_BREAKDOWN_CATEGORIES = [
  'read',
  'write',
  'test',
  'build-check',
  'process-report',
  'thinking',
  'exception-retry',
  'unclassified',
];

const BRIDGE_NATIVE_TOOL_NAMES = new Set([
  'update-goal',
  'suggest-goal',
  'propose-plan',
  'send-public',
  'send-private',
  'create-delegation',
  'await-delegation',
  'cancel-delegation',
  'conversation-notify',
  'conversation-request',
  'conversation_notify', // model-visible underscore forms
  'conversation_request',
  'read-context',
  'search-messages',
  'search-memory',
  'list-memories',
  'save-memory',
  'update-memory',
  'forget-memory',
  'list-participants',
  'list_rooms',
  'room_workspace_preview',
  'room_workspace_bind',
  'room_workspace_rename_preview',
  'room_workspace_rename_bind',
]);

const READ_TOOL_NAMES = new Set(['read', 'grep', 'find', 'ls']);
const WRITE_TOOL_NAMES = new Set(['edit', 'write']);

function safeJsonParse(value: any) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeContentType(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function toEpochMs(value: any) {
  const num = Number(value);

  if (Number.isFinite(num) && num > 0) {
    return Math.round(num);
  }

  const parsed = Date.parse(String(value || ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function extractToolResultText(content: any) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];

  for (const item of content) {
    if (item && typeof item === 'object' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }

  return parts.join('\n');
}

// §4 step parser. options:
//   assistantStartIndex: skip this many assistant messages (per-turn slice)
//   fromOffset: byte offset for incremental re-parse
// Returns steps (chronological), error events, truncation flag, endOffset.
export function parseSessionTurnSteps(sessionPath: any, agentDir: any, options: any = {}) {
  const pathValue = String(sessionPath || '').trim();
  const baseDir = String(agentDir || '').trim();

  if (!pathValue || !baseDir) {
    return null;
  }

  const sessionsDir = path.resolve(baseDir, 'named-sessions');
  const resolvedPath = path.resolve(pathValue);

  if (!isPathWithin(sessionsDir, resolvedPath)) {
    return null;
  }

  let buffer: Buffer;

  try {
    if (!fs.existsSync(resolvedPath)) {
      return null;
    }

    buffer = fs.readFileSync(resolvedPath);
  } catch {
    return null;
  }

  const fromOffset = Number.isSafeInteger(Number(options.fromOffset)) && Number(options.fromOffset) > 0
    ? Math.min(Number(options.fromOffset), buffer.length)
    : 0;
  const slice = buffer.subarray(fromOffset);
  const text = slice.toString('utf8');

  // Offsets are BYTE offsets and always advance to a newline boundary.
  // A trailing line without a newline terminator may still be in-flight;
  // consume it only when it parses, otherwise leave it for the next pass.
  let parseText = text;
  let consumedBytes = slice.length;
  let inFlightTail = false;

  if (text.length > 0 && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    const tail = lastNewline === -1 ? text : text.slice(lastNewline + 1);

    if (tail.trim() && !safeJsonParse(tail)) {
      inFlightTail = true;
      parseText = lastNewline === -1 ? '' : text.slice(0, lastNewline + 1);
      consumedBytes = Buffer.byteLength(parseText, 'utf8');
    }
  }

  const lines = parseText.split('\n');
  let truncated = false;

  const startIndex = Number.isSafeInteger(Number(options.assistantStartIndex)) && Number(options.assistantStartIndex) >= 0
    ? Number(options.assistantStartIndex)
    : null;
  const pendingCalls = new Map<string, any>();
  const steps: any[] = [];
  const errorEvents: any[] = [];
  let assistantMessageTotal = 0;
  let selectedAssistantOrdinal = 0;
  let corruptLines = 0;

  const flushStep = (call: any, result: any) => {
    const startedAtMs = call ? call.startedAtMs : null;
    const endedAtMs = result ? result.endedAtMs : null;

    steps.push({
      stepKey: call ? call.stepKey : `orphan:${result.toolCallId}`,
      toolCallId: call ? call.toolCallId : result.toolCallId,
      toolName: (call && call.toolName) || (result && result.toolName) || 'tool',
      args: call ? call.args : null,
      output: result ? result.output : '',
      isError: result ? result.isError : false,
      startedAtMs,
      endedAtMs,
      durationMs: startedAtMs !== null && endedAtMs !== null && endedAtMs >= startedAtMs ? endedAtMs - startedAtMs : null,
      assistantMessageOrdinal: call ? call.assistantMessageOrdinal : null,
      orphan: !call,
      open: !result,
    });
  };

  for (const rawLine of lines) {
    const trimmed = String(rawLine || '').trim();

    if (!trimmed) {
      continue;
    }

    const entry = safeJsonParse(trimmed);

    if (!entry) {
      corruptLines += 1;
      truncated = true;
      continue;
    }

    const message = entry && entry.message && typeof entry.message === 'object' ? entry.message : null;

    if (!message || entry.type !== 'message') {
      continue;
    }

    if (message.role === 'assistant') {
      assistantMessageTotal += 1;

      if (startIndex !== null && assistantMessageTotal <= startIndex) {
        continue;
      }

      selectedAssistantOrdinal += 1;

      if (message.stopReason === 'error') {
        errorEvents.push({
          timestampMs: toEpochMs(message.timestamp),
          errorMessage: message.errorMessage ? String(message.errorMessage) : '',
        });
      }

      const content = Array.isArray(message.content) ? message.content : [];
      const startedAtMs = toEpochMs(message.timestamp);

      for (const item of content) {
        const type = normalizeContentType(item && item.type);

        if (type !== 'tool_call' && type !== 'toolcall' && type !== 'tool_use' && type !== 'tooluse') {
          continue;
        }

        const toolCallId = String(item && item.id ? item.id : '').trim();
        const toolName = String(item && item.name ? item.name : '').trim() || 'tool';
        const call = {
          stepKey: toolCallId || `${toolName}:${selectedAssistantOrdinal}:${pendingCalls.size}`,
          toolCallId,
          toolName,
          args: item && item.arguments !== undefined ? item.arguments : null,
          startedAtMs,
          assistantMessageOrdinal: selectedAssistantOrdinal,
        };

        if (toolCallId) {
          pendingCalls.set(toolCallId, call);
        } else {
          // No id to join on — flush immediately as an open step.
          flushStep(call, null);
        }
      }

      continue;
    }

    if (message.role === 'toolResult' || message.role === 'tool_result' || message.role === 'toolresult') {
      // Results belonging to assistant messages before the slice boundary
      // are prior-turn traffic, not orphans.
      if (startIndex !== null && assistantMessageTotal <= startIndex) {
        continue;
      }

      const toolCallId = String(message.toolCallId || '').trim();
      const result = {
        toolCallId,
        toolName: String(message.toolName || '').trim(),
        output: extractToolResultText(message.content),
        isError: message.isError === true,
        endedAtMs: toEpochMs(message.timestamp),
      };
      const call = toolCallId ? pendingCalls.get(toolCallId) : null;

      if (call) {
        pendingCalls.delete(toolCallId);
      }

      flushStep(call || null, result);
    }
  }

  // Calls with no matching result are open steps (interrupted or in-flight).
  for (const call of pendingCalls.values()) {
    flushStep(call, null);
  }

  steps.sort((a, b) => {
    const at = a.startedAtMs !== null ? a.startedAtMs : (a.endedAtMs !== null ? a.endedAtMs : 0);
    const bt = b.startedAtMs !== null ? b.startedAtMs : (b.endedAtMs !== null ? b.endedAtMs : 0);

    return at - bt;
  });

  return {
    steps,
    errorEvents,
    // truncated = genuinely corrupt lines only. An unterminated in-flight
    // tail is normal for a live turn and must not flip partial-truncated.
    truncated,
    inFlightTail,
    corruptLines,
    assistantMessageTotal,
    endOffset: fromOffset + consumedBytes,
  };
}

// ---------------------------------------------------------------------------
// §5 rule classifier
// ---------------------------------------------------------------------------

function extractBashCommand(step: any) {
  const args = step && step.args;

  if (typeof args === 'string') {
    const parsed = safeJsonParse(args);

    if (parsed && typeof parsed.command === 'string') {
      return parsed.command;
    }

    return args;
  }

  if (args && typeof args === 'object' && typeof args.command === 'string') {
    return args.command;
  }

  return '';
}

function extractToolPath(step: any) {
  const args = step && step.args && typeof step.args === 'object' ? step.args : null;

  if (!args) {
    return '';
  }

  return String(args.path || args.file_path || args.filePath || '').trim();
}

// §5 path classes → write subcategories.
export function classifyPathSubcategory(rawPath: any) {
  const portable = String(rawPath || '').replace(/\\/g, '/');

  if (!portable) {
    return 'product-code';
  }

  if (/(^|\/)tests?\//.test(portable) || /(^|\/)__tests__\//.test(portable)) {
    return 'test-code';
  }

  if (/(^|\/)(docs|\.agents)\//.test(portable)) {
    return 'docs-evidence';
  }

  return 'product-code';
}

// Split a shell command into segments on &&, ||, ;, | — quote-aware, so
// alternation inside quotes (`rg -n "a\|b"`, `grep "foo;bar"`) never splits.
function splitShellSegments(command: string) {
  const segments: string[] = [];
  let current = '';
  let quote = '';

  const push = () => {
    const trimmed = current.trim();

    if (trimmed) {
      segments.push(trimmed);
    }

    current = '';
  };

  const text = String(command || '');

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote === "'") {
      current += ch;

      if (ch === "'") {
        quote = '';
      }

      continue;
    }

    if (quote === '"') {
      current += ch;

      if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (ch === '"') {
        quote = '';
      }

      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1];
      i += 1;
      continue;
    }

    if (ch === ';') {
      push();
      continue;
    }

    if (ch === '|') {
      push();

      if (text[i + 1] === '|') {
        i += 1;
      }

      continue;
    }

    if (ch === '&' && text[i + 1] === '&') {
      push();
      i += 1;
      continue;
    }

    current += ch;
  }

  push();

  return segments;
}

// Split one segment into shell words, stripping quotes and escapes so path
// extraction sees clean tokens.
function splitShellWords(segment: string) {
  const words: string[] = [];
  let current = '';
  let quote = '';
  let has = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (quote === "'") {
      if (ch === "'") {
        quote = '';
      } else {
        current += ch;
      }

      has = true;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = '';
      } else if (ch === '\\' && i + 1 < segment.length) {
        current += segment[i + 1];
        i += 1;
      } else {
        current += ch;
      }

      has = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }

    if (ch === '\\' && i + 1 < segment.length) {
      current += segment[i + 1];
      i += 1;
      has = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (has) {
        words.push(current);
        current = '';
        has = false;
      }

      continue;
    }

    current += ch;
    has = true;
  }

  if (has) {
    words.push(current);
  }

  return words;
}

function firstToken(segment: string) {
  const match = String(segment || '').trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?(\S+)/);

  return match ? match[1] : '';
}

function baseName(token: string) {
  const normalized = String(token || '').replace(/\\/g, '/');
  const parts = normalized.split('/');

  return (parts[parts.length - 1] || '').toLowerCase();
}

// Leading `FOO=bar` env assignments and `sudo` annotate the command; strip
// them so anchored patterns see the real binary.
function stripEnvPrefix(segment: string) {
  return String(segment || '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+)?/, '');
}

// `git -C <path> <sub>` runs elsewhere but classifies by its subcommand.
function stripGitCPrefix(segment: string) {
  const match = String(segment || '').match(/^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+(.+)$/);

  return match ? `git ${match[2]}` : segment;
}

function isAgentChatToolsSegment(segment: string) {
  return /agent-chat-tools\.js(\s|$)/.test(segment) || /CAFF_CHAT_TOOLS_PATH/.test(segment);
}

// A positional argument that looks like a path/file makes a test run
// targeted; runner invocations without one are the canonical full entry.
function hasPathLikeArg(segment: string, runnerPrefix: RegExp) {
  const rest = String(segment || '').replace(runnerPrefix, '').trim();

  if (!rest) {
    return false;
  }

  return rest
    .split(/\s+/)
    .filter((token) => !token.startsWith('-'))
    .some((token) => /[\\/]/.test(token) || /\.(js|mjs|cjs|ts|py|go)\b/.test(token));
}

const TEST_RUNNER_PREFIXES: Array<{ prefix: RegExp; fullWhenNoPath: boolean }> = [
  { prefix: /^(npm|pnpm|yarn)\s+(run\s+)?test\b(?!:)/, fullWhenNoPath: true },
  // `npm run test:fast`, but also `yarn test:fast` / `pnpm test:fast` (no run).
  { prefix: /^(npm|pnpm|yarn)\s+(run\s+)?test:[\w-]+/, fullWhenNoPath: true },
  { prefix: /^node\s+--test/, fullWhenNoPath: true },
  { prefix: /^(npx\s+)?vitest(\s+run)?/, fullWhenNoPath: true },
  { prefix: /^(npx\s+)?jest/, fullWhenNoPath: true },
  { prefix: /^pytest/, fullWhenNoPath: true },
  { prefix: /^go\s+test/, fullWhenNoPath: true },
  { prefix: /^cargo\s+test/, fullWhenNoPath: true },
];

function classifyTestSegment(segment: string) {
  for (const { prefix } of TEST_RUNNER_PREFIXES) {
    if (!prefix.test(segment)) {
      continue;
    }

    // `node --test tests/` (whole suite dir, no file subset) stays full.
    const rest = segment.replace(prefix, '').trim();
    const wholeSuiteOnly = /^tests\/?$/.test(rest) || /^\.\/\.\.$/.test(rest) || rest === './...';

    return {
      category: 'test',
      runKind: wholeSuiteOnly || !hasPathLikeArg(segment, prefix) ? 'full-regression' : 'targeted',
    };
  }

  // Direct single-file runners: `node tests/foo.test.js`.
  if (/^node\s+\S*\.test\.(js|mjs|cjs|ts)(\s|$)/.test(segment)) {
    return { category: 'test', runKind: 'targeted' };
  }

  return null;
}

const BUILD_CHECK_PATTERNS = [
  /^(npx\s+)?tsc(\s|$)/,
  /^(npm|pnpm|yarn)\s+run\s+(build|typecheck\S*|check|lint\S*)(\s|$)/,
  /^node\s+--check\s/,
  /^(npx\s+)?eslint(\s|$)/,
];

// Patterns below run on the env-stripped segment; segments are already
// split, so anchors are `^`.
const BASH_MUTATION_PATTERNS = [
  /(?:^|\s)>{1,2}\s*\S/, // redirections (after /dev/null stripping)
  /^sed\s+(-\S+\s+)*(-i\S*|--in-place\S*)(\s|$)/,
  /^apply_patch(\s|$)/,
  /^tee\s+\S/,
  /^(mv|cp|rm|mkdir|touch)(\s|$)/,
  /^git\s+(checkout|restore)\s+(--\s*)?\S/,
  // VCS bookkeeping mutates repo state, not file contents: write, NULL path class.
  /^git\s+(apply|am|add|commit|rm|mv|stash)(\s|$)/,
];

const BASH_READ_PATTERNS = [
  // sed without -i only writes to stdout → read (sed -i hits mutation first).
  /^(cat|head|tail|less|more|wc|file|stat|ls|dir|pwd|which|type|echo|grep|rg|find|tree|sed|diff|sort|uniq|tr|du|df|env|printenv|date|uname|basename|dirname|realpath|readlink)(\s|$)/,
  /^git\s+(log|show|diff|status|blame|branch|tag\s*$|rev-parse|ls-files|grep|remote\s*$|describe)(\s|$)/,
];

// §5 rule 4: the write subcategory comes from the DESTINATION path class.
// Best-effort extraction; unresolvable targets keep subcategory NULL rather
// than guessing product-code.
function extractBashWriteTarget(segment: string) {
  const redirection = /(?:^|\s)(?:\d+|&)?>{1,2}\s*("[^"]*"|'[^']*'|[^\s]+)/g;
  let match;

  while ((match = redirection.exec(segment)) !== null) {
    const target = match[1].replace(/^['"]|['"]$/g, '');

    if (target && target !== '/dev/null' && target !== 'NUL') {
      return target;
    }
  }

  const words = splitShellWords(segment);
  const bin = baseName(words[0] || '');

  if (bin === 'tee') {
    return words.slice(1).find((word) => !word.startsWith('-')) || '';
  }

  if (bin === 'mv' || bin === 'cp') {
    const operands = words.slice(1).filter((word) => !word.startsWith('-'));

    return operands[operands.length - 1] || '';
  }

  if (bin === 'rm' || bin === 'mkdir' || bin === 'touch') {
    return words.slice(1).find((word) => !word.startsWith('-')) || '';
  }

  if (bin === 'sed') {
    // `sed -i [-e script]... file` — the file operand comes last.
    const operands = words.slice(1).filter((word) => !word.startsWith('-'));

    return operands[operands.length - 1] || '';
  }

  if (bin === 'git') {
    const sub = words[1];

    if (sub === 'checkout' || sub === 'restore') {
      const operands = words.slice(2).filter((word) => word !== '--' && !word.startsWith('-'));

      return operands[0] || '';
    }
  }

  return '';
}

function classifyBashMutation(segment: string): any {
  // Discarding output (`> /dev/null`, `2>/dev/null`) is not a repo write.
  const withoutDevNull = segment.replace(/(?:\d+|&)?>{1,2}\s*(?:\/dev\/null|NUL)\b/g, ' ');

  for (const pattern of BASH_MUTATION_PATTERNS) {
    if (pattern.test(withoutDevNull)) {
      const target = extractBashWriteTarget(segment);

      return { category: 'write', subcategory: target ? classifyPathSubcategory(target) : null };
    }
  }

  return null;
}

// Test output fingerprints (node:test TAP, mocha, jest, pytest).
export function detectTestFailure(output: any, isError: any) {
  if (isError === true) {
    return true;
  }

  const text = String(output || '');

  if (!text) {
    return false;
  }

  const failMatch = text.match(/^#\s*fail\s+(\d+)/im)
    || text.match(/(\d+)\s+failing/i)
    || text.match(/(\d+)\s+failed/i)
    || text.match(/failed\s+(\d+)/i);

  if (failMatch && Number(failMatch[1]) > 0) {
    return true;
  }

  return /command exited with code\s+[1-9]/i.test(text);
}

function classifyBashSegment(segment: string): any {
  const token = firstToken(segment);
  const bin = baseName(token);

  if (!bin) {
    return null;
  }

  // Directory changes annotate the real command; they carry no category and
  // never poison a chain (`cd /repo && npm test` is a test run).
  if (bin === 'cd' || bin === 'pushd' || bin === 'popd') {
    return { neutral: true };
  }

  if (isAgentChatToolsSegment(segment)) {
    return { category: 'process-report' };
  }

  const normalized = stripGitCPrefix(stripEnvPrefix(segment));

  const testResult = classifyTestSegment(normalized);

  if (testResult) {
    return testResult;
  }

  for (const pattern of BUILD_CHECK_PATTERNS) {
    if (pattern.test(normalized)) {
      return { category: 'build-check' };
    }
  }

  const mutation = classifyBashMutation(normalized);

  if (mutation) {
    return mutation;
  }

  for (const pattern of BASH_READ_PATTERNS) {
    if (pattern.test(normalized)) {
      return { category: 'read' };
    }
  }

  // Opaque wrappers (scripts/*.sh, scripts/*.js, unknown binaries) → null.
  return null;
}

// Priority used to merge multi-segment bash commands (mirrors §3 order,
// minus the categories a bash command can never be).
const SEGMENT_MERGE_PRIORITY = ['test', 'write', 'build-check', 'process-report', 'read'];

export function classifyBashCommand(command: any) {
  const text = String(command || '');

  // Bridge invocations short-circuit: heredoc bodies may contain shell
  // metacharacters that would otherwise poison segmentation.
  if (/agent-chat-tools\.js(\s|$)/.test(text) || /CAFF_CHAT_TOOLS_PATH/.test(text)) {
    return { category: 'process-report' };
  }

  const segments = splitShellSegments(text);

  if (segments.length === 0) {
    return null;
  }

  const results: any[] = segments.map(classifyBashSegment);

  if (results.some((result) => result === null)) {
    return null; // any opaque segment makes the whole command JEV-bound
  }

  const categorized = results.filter((result) => result && !result.neutral);

  if (categorized.length === 0) {
    return null; // only cd/pushd noise — nothing to attribute
  }

  // Every test segment counts: a chained `npm test; npm test` is two full
  // runs, not one (fullRunCount feeds the AC4 replay evidence).
  const testHits = categorized.filter((result) => result.category === 'test');

  if (testHits.length > 0) {
    const full = testHits.filter((hit) => hit.runKind === 'full-regression').length;

    return {
      category: 'test',
      runKind: full > 0 ? 'full-regression' : 'targeted',
      testRunCounts: { full, targeted: testHits.length - full },
    };
  }

  for (const category of SEGMENT_MERGE_PRIORITY) {
    const hit = categorized.find((result) => result && result.category === category);

    if (hit) {
      return { ...hit };
    }
  }

  return null;
}

const INFRA_ERROR_HINTS = [
  /tool not found/i,
  /unknown tool/i,
  /invalid (tool )?arguments?/i,
  /invocation (failed|error)/i,
  /timed? ?out/i,
  /rate limit/i,
  /overloaded/i,
];

// Stateful per-turn classifier: tracks the first repo write so reads can be
// split into cold-start-reread vs purposeful-lookup (§2).
export function createTurnRuleClassifier() {
  let writeSeen = false;

  function classify(step: any) {
    const toolName = String(step && step.toolName ? step.toolName : '').trim().toLowerCase();
    let result: any = null;

    if (BRIDGE_NATIVE_TOOL_NAMES.has(toolName)) {
      result = { category: 'process-report', subcategory: null };
    } else if (toolName === 'bash' || toolName === 'powershell') {
      const command = extractBashCommand(step);
      const bashResult = command ? classifyBashCommand(command) : null;

      if (bashResult) {
        result = { ...bashResult };

        if (result.category === 'test') {
          result.runFailed = detectTestFailure(step && step.output, step && step.isError);
        }

        if (result.category === 'read') {
          result.subcategory = writeSeen ? 'purposeful-lookup' : 'cold-start-reread';
        }
      }
    } else if (WRITE_TOOL_NAMES.has(toolName)) {
      result = {
        category: 'write',
        subcategory: classifyPathSubcategory(extractToolPath(step)),
      };
    } else if (READ_TOOL_NAMES.has(toolName)) {
      result = {
        category: 'read',
        subcategory: writeSeen ? 'purposeful-lookup' : 'cold-start-reread',
      };
    }

    if (result && result.category === 'write') {
      writeSeen = true;
    }

    if (result) {
      return { ...result, classifiedBy: 'rules' };
    }

    // No semantic rule hit. Infra failure without semantic execution →
    // exception-retry (§5 rule 6); otherwise null → JEV fallback (§6).
    if (step && step.isError === true) {
      const output = String(step.output || '');

      if (!output || INFRA_ERROR_HINTS.some((pattern) => pattern.test(output))) {
        return { category: 'exception-retry', subcategory: null, classifiedBy: 'rules' };
      }
    }

    return null;
  }

  return {
    classify,
    // W3/W4 feed JEV and exception-retry outcomes back: a write the rules
    // could not see (opaque script, JEV-resolved) still flips later reads
    // from cold-start-reread to purposeful-lookup.
    noteExternalCategory(category: any) {
      if (category === 'write') {
        writeSeen = true;
      }
    },
  };
}
