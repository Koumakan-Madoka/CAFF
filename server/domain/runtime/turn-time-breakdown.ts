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

export function extractToolResultText(content: any) {
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

  // null/undefined/'' are ABSENT, not zero: Number(null) === 0 would turn
  // an explicit null endIndex into "break at the first assistant message".
  const rawStartIndex = options.assistantStartIndex;
  const startIndex = rawStartIndex !== null && rawStartIndex !== undefined && rawStartIndex !== ''
    && Number.isSafeInteger(Number(rawStartIndex)) && Number(rawStartIndex) >= 0
    ? Number(rawStartIndex)
    : null;
  // §4 slice end (exclusive): the next turn's assistant-message index in a
  // reused session. Without it a backfill reparse would run to EOF and
  // swallow every later turn's steps into this turn's rows.
  const rawEndIndex = options.assistantEndIndex;
  const endIndex = rawEndIndex !== null && rawEndIndex !== undefined && rawEndIndex !== ''
    && Number.isSafeInteger(Number(rawEndIndex)) && Number(rawEndIndex) >= 0
    ? Number(rawEndIndex)
    : null;
  // Incremental passes resume mid-file: the slice boundary check must count
  // assistant messages cumulatively across passes, not just within this one.
  const assistantCountBase = Number.isSafeInteger(Number(options.assistantCountBase)) && Number(options.assistantCountBase) > 0
    ? Number(options.assistantCountBase)
    : 0;
  const pendingCalls = new Map<string, any>();
  const steps: any[] = [];
  const errorEvents: any[] = [];
  let assistantMessageTotal = assistantCountBase;
  let selectedAssistantOrdinal = 0;
  let corruptLines = 0;
  // First event of the sliced trace (assistant or toolResult) — the §3 turn
  // span start, so thinking before the first tool call is accounted.
  let firstEventMs: number | null = null;
  let lastEventMs: number | null = null;

  const noteEventMs = (value: any) => {
    const ms = toEpochMs(value);

    if (ms === null) {
      return;
    }

    if (firstEventMs === null || ms < firstEventMs) {
      firstEventMs = ms;
    }

    if (lastEventMs === null || ms > lastEventMs) {
      lastEventMs = ms;
    }
  };

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

      // Slice end: the next turn's first assistant message. A sibling
      // startIndex of N means "skip N, my turn starts at message N+1", so
      // this turn's slice ends when the count PASSES the boundary index.
      if (endIndex !== null && assistantMessageTotal > endIndex) {
        break;
      }

      if (startIndex !== null && assistantMessageTotal <= startIndex) {
        continue;
      }

      selectedAssistantOrdinal += 1;
      noteEventMs(message.timestamp);

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
      // are prior-turn traffic, not orphans. With startIndex 0 nothing is
      // pre-slice, so no result is ever skipped.
      if (startIndex !== null && startIndex > 0 && assistantMessageTotal <= startIndex) {
        continue;
      }

      const toolCallId = String(message.toolCallId || '').trim();
      noteEventMs(message.timestamp);
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
    firstEventMs,
    // Last in-slice event — the stale-live seal (§9) needs a "last sign of
    // life" that does not depend on wall-clock now.
    lastEventMs,
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

// §5 write scope: WHERE a write lands. `firstWriteMs` (§2, "首次改仓库文件")
// counts only repo-scope writes; scratch writes into the agent sandbox
// (probe scripts under .pi-sandbox / agent-sandboxes, $PI_AGENT_PRIVATE_DIR)
// or the OS temp area are still `write` steps, but they never move the
// first-repo-write metric. `unknown` (unresolvable or absolute paths outside
// the known scratch areas) is conservatively treated as repo.
export function classifyWriteScope(rawPath: any) {
  const portable = String(rawPath || '').replace(/\\/g, '/');

  if (!portable) {
    return 'unknown';
  }

  // OS temp scratch (including env-var anchored forms and the Windows
  // per-user temp root — pi on Windows hands write/edit absolute paths
  // like C:/Users/<user>/AppData/Local/Temp/x.mjs).
  if (
    /^\/(tmp|var\/tmp)\//.test(portable)
    || /\$\{?TMPDIR\}?/.test(portable)
    || /%(TEMP|TMP)%/i.test(rawPath)
    || /\/(AppData\/Local\/)?Temp\//i.test(portable)
  ) {
    return 'temp';
  }

  // Agent sandbox / private storage (never repo-tracked).
  if (
    /\.pi-sandbox(\/|$)/.test(portable)
    || /agent-sandboxes(\/|$)/.test(portable)
    || /\$\{?PI_AGENT_(PRIVATE|SANDBOX)_DIR\}?/.test(rawPath)
  ) {
    return 'sandbox';
  }

  // A relative path resolves against the repo workdir → repo write.
  const isRelative = !portable.startsWith('/')
    && !/^[A-Za-z]:\//.test(portable)
    && !portable.startsWith('~')
    && !portable.startsWith('$')
    && !portable.startsWith('%');

  return isRelative ? 'repo' : 'unknown';
}

// firstWriteMs counts repo writes; unknown is conservatively repo (§2).
export function writeScopeCountsAsRepo(scope: any) {
  return scope !== 'sandbox' && scope !== 'temp';
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

// Quote-aware tokenizer that records each word's start offset, so a
// launcher prefix can be stripped while the payload keeps its original
// quoting (rejoining dequoted words would corrupt `>` inside quotes).
function shellWordSpans(segment: string) {
  const spans: Array<{ text: string; start: number }> = [];
  const text = String(segment || '');
  let current = '';
  let quote = '';
  let has = false;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (!has) {
      if (/\s/.test(ch)) {
        continue;
      }

      start = i;
      has = true;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = '';
      } else {
        current += ch;
      }

      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = '';
      } else if (ch === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else {
        current += ch;
      }

      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      i += 1;
      continue;
    }

    if (/\s/.test(ch)) {
      spans.push({ text: current, start });
      current = '';
      has = false;
      continue;
    }

    current += ch;
  }

  if (has) {
    spans.push({ text: current, start });
  }

  return spans;
}

// Split one segment into shell words, stripping quotes and escapes so path
// extraction sees clean tokens.
function splitShellWords(segment: string) {
  return shellWordSpans(segment).map((span) => span.text);
}

function firstToken(segment: string) {
  const spans = shellWordSpans(segment);

  return spans.length > 0 ? spans[0].text : '';
}

function baseName(token: string) {
  const normalized = String(token || '').replace(/\\/g, '/');
  const parts = normalized.split('/');

  return (parts[parts.length - 1] || '').toLowerCase();
}

// Strip launcher prefixes (`FOO=bar` assignments, `sudo`, `timeout 300`,
// `time`, `env -u X`/`-i`/`VAR=v`, `command`, `nice -n 5`, `stdbuf -oL`) so
// anchored runner patterns see the real binary. Works on word spans and
// returns the original payload substring, preserving its quoting. A bare
// launcher with no payload (`env`, `time`) is returned unchanged so `env`
// still classifies as a read of the environment; an env/launcher prefix
// whose payload is unrecognized yields null downstream, never a false read.
function stripLauncherPrefix(segment: string) {
  const original = String(segment || '').trim();

  if (!original) {
    return original;
  }

  const spans = shellWordSpans(original);
  let i = 0;

  for (let guard = 0; guard < 6 && i < spans.length; guard += 1) {
    const head = spans[i].text;

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      i += 1; // FOO=bar assignment prefix
      continue;
    }

    const bin = baseName(head);

    if (bin === 'timeout') {
      i += 1;

      while (i < spans.length && spans[i].text.startsWith('-')) {
        const flag = spans[i].text;

        i += 1;

        if ((flag === '-s' || flag === '--signal' || flag === '-k' || flag === '--kill-after') && i < spans.length) {
          i += 1; // flag value
        }
      }

      if (i < spans.length) {
        i += 1; // the duration
      }

      continue;
    }

    if (bin === 'env') {
      i += 1;

      while (i < spans.length) {
        const word = spans[i].text;

        if (word === '-u' || word === '--unset' || word === '-C' || word === '--chdir' || word === '-S' || word === '--split-string') {
          i += 2; // flag + value
          continue;
        }

        if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
          i += 1;
          continue;
        }

        break; // first non-flag, non-assignment word is the payload command
      }

      continue;
    }

    if (bin === 'nice') {
      i += 1;

      while (i < spans.length && spans[i].text.startsWith('-')) {
        const flag = spans[i].text;

        i += 1;

        if ((flag === '-n' || flag === '--adjustment') && i < spans.length) {
          i += 1;
        }
      }

      continue;
    }

    if (bin === 'time' || bin === 'sudo' || bin === 'command' || bin === 'stdbuf') {
      i += 1;

      while (i < spans.length && spans[i].text.startsWith('-')) {
        i += 1;
      }

      continue;
    }

    // `git -C <path> <sub>` runs elsewhere but classifies by its subcommand.
    if (bin === 'git' && spans[i + 1] && spans[i + 1].text === '-C' && spans[i + 3]) {
      return `git ${original.slice(spans[i + 3].start)}`;
    }

    break;
  }

  if (i > 0 && i < spans.length) {
    return original.slice(spans[i].start);
  }

  return original;
}

function isAgentChatToolsSegment(segment: string) {
  return /agent-chat-tools\.js(\s|$)/.test(segment) || /CAFF_CHAT_TOOLS_PATH/.test(segment);
}

// Remove output redirections (`>`, `>>`, `2>`, `2>&1`, `&>`) and their
// targets, quote-aware. Redirection targets are never path-subset arguments,
// so `npm test > /tmp/x.log` stays a full-regression run.
function stripRedirections(segment: string) {
  const text = String(segment || '');
  let out = '';
  let quote = '';
  let i = 0;

  const skipTarget = (from: number) => {
    let j = from;

    while (j < text.length && /\s/.test(text[j])) {
      j += 1;
    }

    if (text[j] === '&') {
      j += 1; // fd duplication target, e.g. 2>&1
    }

    if (text[j] === '"' || text[j] === "'") {
      const closing = text[j];

      j += 1;

      while (j < text.length && text[j] !== closing) {
        j += 1;
      }

      j += 1; // closing quote
    } else {
      while (j < text.length && !/\s/.test(text[j])) {
        j += 1;
      }
    }

    return j;
  };

  while (i < text.length) {
    const ch = text[i];

    if (quote === "'") {
      out += ch;

      if (ch === "'") {
        quote = '';
      }

      i += 1;
      continue;
    }

    if (quote === '"') {
      out += ch;

      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }

      if (ch === '"') {
        quote = '';
      }

      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '>' || (ch === '&' && text[i + 1] === '>')) {
      // A digit immediately before `>` is the source fd (`2>`); drop it.
      out = out.replace(/(\s|^)\d+$/, '$1');

      if (ch === '&') {
        i += 1;
      }

      if (text[i + 1] === '>') {
        i += 1; // `>>`
      }

      i += 1; // the `>` itself
      i = skipTarget(i);
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

// Flags whose value must be skipped when deciding full vs targeted; a
// `--prefix ./pkg` directory is a package selector, not a test path subset.
const PATH_VALUED_FLAGS = new Set(['--prefix', '--cwd', '--dir']);

// Positional arguments that look like paths/files make a test run
// targeted; runner invocations without one are the canonical full entry.
// Input is the segment remainder after the runner prefix, already stripped
// of redirections.
function positionalTestArgs(rest: string) {
  const words = splitShellWords(rest);
  const positional: string[] = [];

  for (let i = 0; i < words.length; i += 1) {
    const token = words[i];

    if (PATH_VALUED_FLAGS.has(token)) {
      i += 1; // flag value
      continue;
    }

    if (token.startsWith('-')) {
      continue;
    }

    positional.push(token);
  }

  return positional;
}

// `node --test tests/` / `pytest tests/` (whole suite dir, no file subset)
// stays full even with trailing flags; any path-like positional is targeted.
function testRunKindFromRest(rest: string) {
  const positional = positionalTestArgs(rest);
  const wholeSuiteOnly = positional.length > 0
    && positional.every((token) => /^tests\/?$/.test(token) || token === './...' || token === '...');
  const pathLike = positional.some((token) => /[\\/]/.test(token) || /\.(js|mjs|cjs|ts|py|go)\b/.test(token));

  return wholeSuiteOnly || !pathLike ? 'full-regression' : 'targeted';
}

const TEST_RUNNER_PREFIXES: Array<{ prefix: RegExp }> = [
  { prefix: /^(npm|pnpm|yarn)\s+(run\s+)?test\b(?!:)/ },
  // `npm run test:fast`, but also `yarn test:fast` / `pnpm test:fast` (no run).
  { prefix: /^(npm|pnpm|yarn)\s+(run\s+)?test:[\w-]+/ },
  // node basenames: `node`, `nodejs`, `node.exe` (Windows).
  { prefix: /^node(js)?(\.exe)?\s+--test/ },
  { prefix: /^(npx\s+)?vitest(\s+run)?/ },
  { prefix: /^(npx\s+)?jest/ },
  { prefix: /^(npx\s+)?mocha/ },
  { prefix: /^(npx\s+)?playwright\s+test\b/ },
  { prefix: /^npx\s+tsx\s+--test(?=\s|$)/ },
  { prefix: /^pytest/ },
  // `python -m pytest`, including venv paths and `.exe` (`.venv/Scripts/python.exe -m pytest`).
  { prefix: /^\S*python[\d.]*(\.exe)?\s+-m\s+(pytest|unittest)(?=\s|$)/ },
  // `node --import tsx ./node_modules/vitest/vitest.mjs run` — flags between
  // `node` and the runner entry are skipped pairwise (flag + value).
  { prefix: /^node(js)?(\.exe)?\s+(?:--?\S+(?:\s+\S+)?\s+)*?\S*vitest\.mjs(\s+run)?(?=\s|$)/ },
  // Both slash forms: `node_modules/.bin/vitest` and Windows `node_modules\.bin\vitest`.
  { prefix: /^\S*node_modules[\\/]\.bin[\\/](vitest|jest|mocha)(\s+run)?(?=\s|$)/ },
  { prefix: /^go\s+test/ },
  { prefix: /^cargo\s+test/ },
];

// node flags that consume the next word as a value; everything else between
// `node` and `--test` is treated as a valueless flag. Pairing matters: an
// unpaired scan would swallow `--test` itself as the value of the last flag.
const NODE_VALUE_FLAGS = new Set([
  '--import',
  '--loader',
  '--experimental-loader',
  '--require',
  '-r',
  '--conditions',
  '-C',
]);

// `node <flags> --test …` (e.g. `node --import tsx --test tests/`) and the
// direct single-file form with flags (`node --import tsx tests/foo.test.ts`).
// Returns null when the first non-flag word is neither `--test` nor a test
// file, so plain scripts stay JEV-bound rather than guessed.
const NODE_BIN_BASENAMES = new Set(['node', 'nodejs', 'node.exe']);

function classifyNodeInvocation(cleaned: string) {
  const tokens = splitShellWords(cleaned);

  if (tokens.length === 0 || !NODE_BIN_BASENAMES.has(baseName(tokens[0]))) {
    return null;
  }

  let i = 1;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === '--test') {
      return { category: 'test', runKind: testRunKindFromRest(tokens.slice(i + 1).join(' ')) };
    }

    if (!token.startsWith('-')) {
      return /\.test\.(js|mjs|cjs|ts)$/.test(token)
        ? { category: 'test', runKind: 'targeted' }
        : null;
    }

    if (NODE_VALUE_FLAGS.has(token)) {
      i += 1; // flag value
    }

    i += 1;
  }

  return null;
}

function classifyTestSegment(segment: string) {
  // Redirections (and their targets) never decide run kind.
  let cleaned = stripRedirections(segment).trim();

  // `npm --prefix ./pkg test …` runs the package's full entry elsewhere;
  // drop the package-dir flag so runner detection still sees `test`.
  cleaned = cleaned.replace(/^(npm|pnpm|yarn)\s+--prefix\s+\S+\s+/, '$1 ');

  for (const { prefix } of TEST_RUNNER_PREFIXES) {
    if (!prefix.test(cleaned)) {
      continue;
    }

    const rest = cleaned.replace(prefix, '').trim();

    return { category: 'test', runKind: testRunKindFromRest(rest) };
  }

  const nodeResult = classifyNodeInvocation(cleaned);

  if (nodeResult) {
    return nodeResult;
  }

  return null;
}

const BUILD_CHECK_PATTERNS = [
  /^(npx\s+)?tsc(\s|$)/,
  /^(npm|pnpm|yarn)\s+run\s+(build|typecheck\S*|check|lint\S*)(\s|$)/,
  /^node(js)?(\.exe)?\s+--check\s/,
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
  // `git stash list|show` are read-only inspections — excluded here and
  // matched as read below (golden sample gs-052/gs-146/gs-294).
  /^git\s+(apply|am|add|commit|rm|mv)(\s|$)/,
  /^git\s+stash(\s+(?!list\b|show\b)\S+.*)?$/,
];

const BASH_READ_PATTERNS = [
  // sed without -i only writes to stdout → read (sed -i hits mutation first).
  /^(cat|head|tail|less|more|wc|file|stat|ls|dir|pwd|which|type|echo|grep|rg|find|tree|sed|diff|sort|uniq|tr|du|df|env|printenv|date|uname|basename|dirname|realpath|readlink|paste|cut|column|jq|comm|join|nl|expand|unexpand|fold|fmt|iconv|xxd|od|awk|gawk|mawk)(\s|$)/,
  /^git\s+(log|show|diff|status|blame|branch|tag\s*$|rev-parse|ls-files|grep|remote\s*$|describe)(\s|$)/,
  /^git\s+stash\s+(list|show)(\s|$)/,
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
  // Neither is scratch redirection into the OS temp area (`> /tmp/x`,
  // `> "$TMPDIR/x"`, `> %TEMP%\\x`) — 改 covers 产品代码/测试/文档与证据,
  // and a temp scratch file is none of those (golden sample gs-148/gs-293).
  const withoutDevNull = segment
    .replace(/(?:\d+|&)?>{1,2}\s*(?:\/dev\/null|NUL)\b/g, ' ')
    .replace(/(?:\d+|&)?>{1,2}\s*(?:"(?:\/tmp\/|\/var\/tmp\/|\$\{?TMPDIR\}?|\%TEMP\%|\%TMP\%)[^"]*"|'(?:\/tmp\/|\/var\/tmp\/|\$\{?TMPDIR\}?|\%TEMP\%|\%TMP\%)[^']*'|(?:\/tmp\/|\/var\/tmp\/|\$\{?TMPDIR\}?|\%TEMP\%|\%TMP\%)\S*)/g, ' ');

  for (const pattern of BASH_MUTATION_PATTERNS) {
    if (pattern.test(withoutDevNull)) {
      const target = extractBashWriteTarget(segment);

      return {
        category: 'write',
        subcategory: target ? classifyPathSubcategory(target) : null,
        writeScope: target ? classifyWriteScope(target) : 'unknown',
      };
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
  if (isAgentChatToolsSegment(segment)) {
    return { category: 'process-report' };
  }

  const normalized = stripLauncherPrefix(segment);
  const bin = baseName(firstToken(normalized));

  if (!bin) {
    return null;
  }

  // Directory changes annotate the real command; they carry no category and
  // never poison a chain (`cd /repo && npm test` is a test run).
  if (bin === 'cd' || bin === 'pushd' || bin === 'popd') {
    return { neutral: true };
  }

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
  const hasOpaqueSegment = results.some((result) => result === null);
  const categorized = results.filter((result) => result && !result.neutral);

  if (categorized.length === 0) {
    return null; // only cd/pushd noise, or fully opaque — nothing to attribute
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
      ...(hasOpaqueSegment ? { hasOpaqueSegment: true } : {}),
    };
  }

  if (hasOpaqueSegment) {
    // An opaque segment next to a high-confidence runner/build segment
    // still classifies by that segment, honestly flagged; opaque next to
    // anything weaker stays JEV-bound (a guessed read is worse than null).
    const buildHit = categorized.find((result) => result.category === 'build-check');

    return buildHit ? { ...buildHit, hasOpaqueSegment: true } : null;
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
      const toolPath = extractToolPath(step);

      result = {
        category: 'write',
        subcategory: classifyPathSubcategory(toolPath),
        writeScope: toolPath ? classifyWriteScope(toolPath) : 'unknown',
      };
    } else if (READ_TOOL_NAMES.has(toolName)) {
      result = {
        category: 'read',
        subcategory: writeSeen ? 'purposeful-lookup' : 'cold-start-reread',
      };
    }

    if (result && result.category === 'write') {
      // Only a repo-file mutation ends the cold-start phase (§2 read row);
      // sandbox/temp scratch writes leave later reads cold-start-reread.
      if (writeScopeCountsAsRepo(result.writeScope)) {
        writeSeen = true;
      }
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
