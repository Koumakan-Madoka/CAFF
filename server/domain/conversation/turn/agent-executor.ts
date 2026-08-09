const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING,
  resolveIntegerSettingCandidates,
  resolveSetting,
  resolveThinkingSetting,
  sanitizeSessionName,
  startRun,
} = require('../../../../lib/minimal-pi');
const {
  buildAgentMentionLookup,
  ensureVisibleMentionText,
  extractMentionedAgentIds,
  getAgentById,
} = require('../mention-routing');
const { ALWAYS_DYNAMIC_MODE_SKILL_IDS } = require('../../../../lib/mode-store');
const { buildAgentTurnPromptSections, formatAgentTurnPromptSections, AGENT_PROMPT_VERSION } = require('./agent-prompt');
const { buildInvocationImages } = require('./image-invocation');
const { createAgentContextSnapshot } = require('./context-snapshot');
const { markConversationRetrievalTraceUsage } = require('../retrieval-trace');
const { extractSummaryMemorySearchTerms } = require('../../../../lib/summary-memory-query');
const { ensureAgentSandbox, toPortableShellPath } = require('./agent-sandbox');
const { createBrowserCliSessionName, resolveBrowserCliPath } = require('./browser-cli');
const { extractChatBridgeReplaysFromText, pickChatBridgeReplay } = require('./chat-bridge-replay');
const { createLiveSessionToolStep } = require('../../runtime/message-tool-trace');
const { summarizeModelUsageCalls, summarizeTokenUsage } = require('../../runtime/token-usage');
const { resolveCurrentTrellisTaskName } = require('./trellis-context');
const { clipText, getTurnStage, nowIso, syncCurrentTurnAgent } = require('./turn-state');
const { registerTurnHandle, unregisterTurnHandle } = require('./turn-stop');

const HEARTBEAT_EVENT_REASON_LIMIT = 200;
const TURN_PREVIEW_LENGTH = 180;
const MAX_PRIVATE_CONTEXT_MESSAGES = 16;
const MAX_RELATED_MEMORY_SEGMENTS = 5;
const MAX_RELATED_MEMORY_CANDIDATE_SEGMENTS = 15;
const MAX_RELATED_MEMORY_SEGMENTS_PER_CONVERSATION = 2;
const MAX_RELATED_MEMORY_QUERY_MESSAGES = 6;
const MAX_RELATED_MEMORY_QUERY_MESSAGE_LENGTH = 160;
const MAX_RELATED_MEMORY_QUERY_LENGTH = 480;
const MAX_RELATED_MEMORY_SEED_TERMS = 8;
const MAX_RELATED_MEMORY_SEED_TERM_LENGTH = 48;
const MIN_RELATED_MEMORY_TASK_ALIAS_LENGTH = 8;
const PROMPT_MENTION_PLACEHOLDER_RE = /<mention:([\p{L}\p{N}._-]+)>/gu;
const AUTO_SESSION_GOAL_CONTINUATION_RE = /^Automatic session-goal continuation\s*\(\d+\/\d+\)\./iu;
const AUTO_SESSION_GOAL_COMPLETION_REPORT_RE = /^.{0,80}第\s*\d+\/\d+\s*根?续线接好了[：:]/u;
const RELATED_MEMORY_QUERY_STOP_TERMS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'for',
  'from',
  'find',
  'in',
  'is',
  'need',
  'now',
  'of',
  'or',
  'the',
  'then',
  'this',
  'that',
  'these',
  'those',
  'to',
  'use',
  'with',
  'without',
  '一下',
  '什么',
  '怎么',
  '现在',
  '这个',
  '那个',
  '这些',
  '那些',
  '需要',
]);

function createTaskId(prefix = 'task') {
  return `${prefix}-${randomUUID()}`;
}

function sanitizeReason(reason: any) {
  return clipText(reason || '', HEARTBEAT_EVENT_REASON_LIMIT);
}

function normalizePromptMentionPlaceholders(text: any) {
  return String(text || '').replace(PROMPT_MENTION_PLACEHOLDER_RE, (match: any, token: any) => `@${token}`);
}

function resolveRelatedMemoryTaskName(options: any = {}) {
  const explicitTaskName = String(options.taskName || options.activeTaskName || '').trim();

  if (explicitTaskName) {
    return clipText(explicitTaskName, 160);
  }

  const projectDir = String(options.projectDir || '').trim();

  if (!projectDir) {
    return '';
  }

  try {
    return clipText(resolveCurrentTrellisTaskName({ startDir: projectDir }), 160);
  } catch {
    return '';
  }
}

const GENERIC_RELATED_MEMORY_TITLES = new Set([
  'new conversation',
  'new chat',
  'untitled',
  'untitled conversation',
  '新协作会话',
]);

function resolveRelatedMemoryConversationTitle(conversation: any) {
  const title = String(conversation && conversation.title || '').trim().replace(/\s+/g, ' ');

  if (!title || GENERIC_RELATED_MEMORY_TITLES.has(title.toLocaleLowerCase())) {
    return '';
  }

  return title;
}

function isPrivateRelatedMemoryMessage(message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  const role = String(message && message.role || '').trim().toLocaleLowerCase();
  const visibility = String(
    message && message.visibility || metadata && metadata.visibility || ''
  ).trim().toLocaleLowerCase();

  return Boolean(metadata && metadata.privateOnly) || role === 'private' || visibility === 'private';
}

function normalizeRelatedMemoryMessageText(message: any) {
  if (isPrivateRelatedMemoryMessage(message)) {
    return '';
  }

  const text = String(message && (message.content || message.errorMessage) || '').trim();

  if (
    !text ||
    AUTO_SESSION_GOAL_CONTINUATION_RE.test(text) ||
    AUTO_SESSION_GOAL_COMPLETION_REPORT_RE.test(text)
  ) {
    return '';
  }

  return clipText(text, MAX_RELATED_MEMORY_QUERY_MESSAGE_LENGTH);
}

function appendRelatedMemorySeedTerms(seedTerms: string[], seenTerms: Set<string>, value: any, maxTerms: number) {
  if (seedTerms.length >= MAX_RELATED_MEMORY_SEED_TERMS || maxTerms <= 0) {
    return;
  }

  const terms = extractSummaryMemorySearchTerms(value, {
    maxTerms: 32,
    minTermLength: 2,
    stopTerms: RELATED_MEMORY_QUERY_STOP_TERMS,
  });
  let addedTerms = 0;

  for (const termValue of terms) {
    const term = String(termValue || '').trim();
    const normalizedTerm = term.toLocaleLowerCase();

    if (!term || seenTerms.has(normalizedTerm)) {
      continue;
    }

    seenTerms.add(normalizedTerm);
    seedTerms.push(clipText(term, MAX_RELATED_MEMORY_SEED_TERM_LENGTH));
    addedTerms += 1;

    if (addedTerms >= maxTerms || seedTerms.length >= MAX_RELATED_MEMORY_SEED_TERMS) {
      return;
    }
  }
}

function buildRelatedMemorySearchSeed(parts: any = {}) {
  const seedTerms = [] as string[];
  const seenTerms = new Set<string>();

  appendRelatedMemorySeedTerms(seedTerms, seenTerms, parts.activeTaskName, 3);
  appendRelatedMemorySeedTerms(seedTerms, seenTerms, parts.recentMessageText, 4);
  appendRelatedMemorySeedTerms(seedTerms, seenTerms, parts.sessionGoalObjective, 1);
  appendRelatedMemorySeedTerms(seedTerms, seenTerms, parts.conversationTitle, 1);

  return seedTerms.join(' ');
}

export function buildRelatedMemorySearchQuery(conversation: any, messages: any, options: any = {}) {
  const metadata = conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
  const sessionGoal = metadata.sessionGoal && typeof metadata.sessionGoal === 'object' ? metadata.sessionGoal : null;
  const activeTaskName = resolveRelatedMemoryTaskName(options);
  const recentMessages = (Array.isArray(messages) ? messages : [])
    .slice(-MAX_RELATED_MEMORY_QUERY_MESSAGES)
    .map(normalizeRelatedMemoryMessageText)
    .filter(Boolean);
  const recentMessageText = recentMessages.join('\n');
  const recentMessageSeedText = [...recentMessages].reverse().join('\n');
  const sessionGoalObjective = sessionGoal && sessionGoal.objective;
  const conversationTitle = resolveRelatedMemoryConversationTitle(conversation);
  const searchSeed = buildRelatedMemorySearchSeed({
    activeTaskName,
    recentMessageText: recentMessageSeedText,
    sessionGoalObjective,
    conversationTitle,
  });

  return clipText([
    searchSeed,
    activeTaskName,
    recentMessageText,
    sessionGoalObjective,
    conversationTitle,
  ].filter(Boolean).join('\n'), MAX_RELATED_MEMORY_QUERY_LENGTH);
}

function normalizeRelatedMemoryResults(result: any) {
  return Array.isArray(result && result.results) ? result.results.filter(Boolean) : [];
}

function getRelatedMemoryConversationKey(segment: any, index: number) {
  return String(segment && segment.conversationId || '').trim() || `segment-${index}`;
}

function getRelatedMemorySegmentKey(segment: any) {
  return String(segment && (segment.sourceDigestId || segment.id) || '').trim();
}

function countRelatedMemoryQueryTerms(query: any) {
  return extractSummaryMemorySearchTerms(query, { maxTerms: MAX_RELATED_MEMORY_SEED_TERMS }).length;
}

function getRelatedMemoryMatchScore(segment: any) {
  const score = Number.parseInt(String(segment && segment.score || ''), 10);

  if (Number.isFinite(score) && score > 0) {
    return score;
  }

  if (Array.isArray(segment && segment.matchedTerms) && segment.matchedTerms.length > 0) {
    return segment.matchedTerms.length;
  }

  return null;
}

function filterLowSignalRelatedMemorySegments(segments: any, query: any) {
  const candidates = (Array.isArray(segments) ? segments : []).filter(Boolean);

  if (countRelatedMemoryQueryTerms(query) <= 1) {
    return candidates;
  }

  return candidates.filter((segment: any) => {
    const matchScore = getRelatedMemoryMatchScore(segment);

    return matchScore === null || matchScore >= 2;
  });
}

function normalizeRelatedMemoryTaskAlias(value: any) {
  return String(value || '').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isRelatedMemoryTaskNameMatch(segmentTaskName: any, activeTaskName: any) {
  const normalizedSegmentTaskName = String(segmentTaskName || '').trim().toLocaleLowerCase();
  const normalizedActiveTaskName = String(activeTaskName || '').trim().toLocaleLowerCase();

  if (!normalizedSegmentTaskName || !normalizedActiveTaskName) {
    return false;
  }

  if (normalizedSegmentTaskName === normalizedActiveTaskName) {
    return true;
  }

  const segmentAlias = normalizeRelatedMemoryTaskAlias(normalizedSegmentTaskName);
  const activeAlias = normalizeRelatedMemoryTaskAlias(normalizedActiveTaskName);

  if (segmentAlias.length < MIN_RELATED_MEMORY_TASK_ALIAS_LENGTH || activeAlias.length < MIN_RELATED_MEMORY_TASK_ALIAS_LENGTH) {
    return false;
  }

  return segmentAlias.includes(activeAlias) || activeAlias.includes(segmentAlias);
}

function prioritizeRelatedMemorySegmentsByTask(segments: any, activeTaskName: any) {
  const candidates = (Array.isArray(segments) ? segments : []).filter(Boolean);

  if (!String(activeTaskName || '').trim()) {
    return candidates;
  }

  const currentTaskSegments = [] as any[];
  const otherSegments = [] as any[];

  for (const segment of candidates) {
    if (isRelatedMemoryTaskNameMatch(segment && segment.taskName, activeTaskName)) {
      currentTaskSegments.push(segment);
    } else {
      otherSegments.push(segment);
    }
  }

  return currentTaskSegments.concat(otherSegments);
}

function selectDiverseRelatedMemorySegments(segments: any) {
  const candidates = (Array.isArray(segments) ? segments : []).filter(Boolean);
  const selected = [] as any[];
  const overflow = [] as any[];
  const selectedByConversation = new Map();

  candidates.forEach((segment: any, index: number) => {
    const conversationKey = getRelatedMemoryConversationKey(segment, index);
    const selectedCount = selectedByConversation.get(conversationKey) || 0;

    if (selectedCount < MAX_RELATED_MEMORY_SEGMENTS_PER_CONVERSATION) {
      selectedByConversation.set(conversationKey, selectedCount + 1);
      selected.push(segment);
      return;
    }

    overflow.push(segment);
  });

  return selected.concat(overflow).slice(0, MAX_RELATED_MEMORY_SEGMENTS);
}

function resolveLatestCurrentTaskRelatedMemorySegments(store: any, conversationId: any, activeTaskName: string) {
  const fallbackResult = store.searchSummarySegments({
    query: '',
    limit: MAX_RELATED_MEMORY_CANDIDATE_SEGMENTS,
    excludeConversationId: conversationId,
    taskName: activeTaskName,
  });
  const exactSegments = normalizeRelatedMemoryResults(fallbackResult);

  if (exactSegments.length > 0) {
    return exactSegments;
  }

  const aliasFallbackResult = store.searchSummarySegments({
    query: '',
    limit: MAX_RELATED_MEMORY_CANDIDATE_SEGMENTS,
    excludeConversationId: conversationId,
  });

  return normalizeRelatedMemoryResults(aliasFallbackResult)
    .filter((segment: any) => isRelatedMemoryTaskNameMatch(segment && segment.taskName, activeTaskName));
}

function mergeRelatedMemorySegments(primarySegments: any, fallbackSegments: any, activeTaskName: string) {
  const merged = [] as any[];
  const seenKeys = new Set();

  for (const segment of Array.isArray(primarySegments) ? primarySegments : []) {
    if (!segment) {
      continue;
    }

    const segmentKey = getRelatedMemorySegmentKey(segment);
    if (segmentKey) {
      seenKeys.add(segmentKey);
    }

    merged.push(segment);
  }

  for (const segment of Array.isArray(fallbackSegments) ? fallbackSegments : []) {
    if (!segment) {
      continue;
    }

    const segmentKey = getRelatedMemorySegmentKey(segment);
    if (segmentKey && seenKeys.has(segmentKey)) {
      continue;
    }

    if (segmentKey) {
      seenKeys.add(segmentKey);
    }

    merged.push({
      ...segment,
      recallReason: `latest summary for current task: ${activeTaskName}`,
    });
  }

  return selectDiverseRelatedMemorySegments(merged);
}

export function resolveRelatedMemorySegments(store: any, conversationId: any, conversation: any, messages: any, options: any = {}) {
  if (!store || typeof store.searchSummarySegments !== 'function') {
    return [];
  }

  const activeTaskName = resolveRelatedMemoryTaskName(options);
  const query = buildRelatedMemorySearchQuery(conversation, messages, {
    ...options,
    activeTaskName,
  });

  if (!query || query.length < 2) {
    return [];
  }

  try {
    const result = store.searchSummarySegments({
      query,
      limit: MAX_RELATED_MEMORY_CANDIDATE_SEGMENTS,
      excludeConversationId: conversationId,
    });
    const keywordCandidates = prioritizeRelatedMemorySegmentsByTask(
      filterLowSignalRelatedMemorySegments(normalizeRelatedMemoryResults(result), query),
      activeTaskName
    );
    const results = selectDiverseRelatedMemorySegments(keywordCandidates);

    if (results.length >= MAX_RELATED_MEMORY_SEGMENTS || !activeTaskName) {
      return results;
    }

    const fallbackSegments = resolveLatestCurrentTaskRelatedMemorySegments(store, conversationId, activeTaskName);

    return mergeRelatedMemorySegments(results, fallbackSegments, activeTaskName);
  } catch (error) {
    const errorValue = error as any;
    console.warn(`[summary-memory] Retrieval failed for conversation ${conversationId}: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);
    return [];
  }
}

function resolveConversationAgentConfig(agent: any) {
  const runtimeConfig = agent && agent.runtimeConfig && typeof agent.runtimeConfig === 'object'
    ? agent.runtimeConfig
    : null;
  if (runtimeConfig) {
    return {
      profileId: runtimeConfig.profileId || null,
      profileName: runtimeConfig.profileName || 'Default',
      provider: String(runtimeConfig.provider || '').trim(),
      model: String(runtimeConfig.model || '').trim(),
      thinking: String(runtimeConfig.thinking || '').trim(),
      personaPrompt: String(runtimeConfig.personaPrompt || '').trim(),
      skillIds: Array.isArray(runtimeConfig.skillIds) ? runtimeConfig.skillIds : [],
      conversationSkillIds: Array.isArray(agent && (agent.conversationSkillIds || agent.conversationSkills))
        ? agent.conversationSkillIds || agent.conversationSkills
        : [],
    };
  }
  const selectedModelProfile =
    agent && agent.selectedModelProfile && typeof agent.selectedModelProfile === 'object' ? agent.selectedModelProfile : null;

  return {
    profileId: selectedModelProfile ? selectedModelProfile.id : null,
    profileName: selectedModelProfile ? selectedModelProfile.name : 'Default',
    provider: resolveSetting(selectedModelProfile ? selectedModelProfile.provider : '', agent && agent.provider, ''),
    model: resolveSetting(selectedModelProfile ? selectedModelProfile.model : '', agent && agent.model, ''),
    thinking: resolveSetting(selectedModelProfile ? selectedModelProfile.thinking : '', agent && agent.thinking, ''),
    personaPrompt: resolveSetting(selectedModelProfile ? selectedModelProfile.personaPrompt : '', agent && agent.personaPrompt, ''),
    skillIds: Array.isArray(agent && (agent.skillIds || agent.skills)) ? agent.skillIds || agent.skills : [],
    conversationSkillIds: Array.isArray(agent && (agent.conversationSkillIds || agent.conversationSkills))
      ? agent.conversationSkillIds || agent.conversationSkills
      : [],
  };
}

function mergeSkillIds(...groups: any[]) {
  const seenSkillIds = new Set();
  const mergedSkillIds = [] as string[];

  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const skillId = String(item || '').trim();

      if (!skillId || seenSkillIds.has(skillId)) {
        continue;
      }

      seenSkillIds.add(skillId);
      mergedSkillIds.push(skillId);
    }
  }

  return mergedSkillIds;
}

function extractJsonCandidate(text: any) {
  const raw = String(text || '').trim();
  let candidate = raw;

  if (!candidate) {
    throw new Error('Empty agent reply');
  }

  if (candidate.startsWith('```')) {
    const codeBlockMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

    if (codeBlockMatch) {
      candidate = codeBlockMatch[1].trim();
    }
  }

  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  const firstBrace = candidate.indexOf('{');

  if (firstBrace !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = firstBrace; index < candidate.length; index += 1) {
      const char = candidate[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth += 1;
        continue;
      }

      if (char === '}') {
        depth -= 1;

        if (depth === 0) {
          return candidate.slice(firstBrace, index + 1);
        }
      }
    }
  }

  throw new Error('No JSON object found in agent reply');
}

function createSilentAgentTurnDecision(input: any = {}) {
  const mentions = Array.isArray(input.mentions) ? input.mentions.filter(Boolean) : [];

  return {
    publicReply: '',
    mentions,
    final: input.final === undefined ? mentions.length === 0 : Boolean(input.final),
    reason: String(input.reason || '').trim(),
    raw: String(input.raw || '').trim(),
    fallback: Boolean(input.fallback),
    silent: true,
  };
}

function parseAgentTurnDecision(text: any, agents: any, options: any = {}) {
  const raw = normalizePromptMentionPlaceholders(text).trim();
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.currentAgentId || '';

  if (!raw) {
    if (options.allowEmptyReply) {
      return createSilentAgentTurnDecision({
        reason: 'empty_reply',
        raw,
      });
    }

    throw new Error('Empty agent reply');
  }

  const parsePlainTextReply = () => {
    const mentions = extractMentionedAgentIds(raw, agents, {
      lookup,
      excludeAgentId,
      limit: Array.isArray(agents) ? agents.length : Number.MAX_SAFE_INTEGER,
    });

    return {
      publicReply: raw,
      mentions,
      final: mentions.length === 0,
      reason: 'formatted_text_reply',
      raw,
      fallback: false,
      silent: false,
    };
  };

  if (!raw.startsWith('{') && !raw.startsWith('```')) {
    return parsePlainTextReply();
  }

  let payload;

  try {
    payload = JSON.parse(extractJsonCandidate(raw));
  } catch {
    return parsePlainTextReply();
  }

  const action = String(payload.action || '').trim().toLowerCase();
  const explicitFinal =
    action === 'final' ||
    action === 'done' ||
    action === 'complete' ||
    action === 'answer' ||
    action === 'respond' ||
    payload.final === true ||
    payload.done === true;
  const explicitContinue =
    action === 'delegate' ||
    action === 'handoff' ||
    action === 'route' ||
    action === 'transfer' ||
    payload.final === false ||
    payload.done === false;
  let publicReply = String(payload.publicReply || payload.reply || payload.message || payload.output || payload.finalReply || '').trim();

  if (!publicReply && typeof payload.final === 'string') {
    publicReply = String(payload.final).trim();
  }

  if (!publicReply && typeof payload.answer === 'string') {
    publicReply = String(payload.answer).trim();
  }

  publicReply = normalizePromptMentionPlaceholders(publicReply);

  const inlineMentions = extractMentionedAgentIds(publicReply, agents, {
    lookup,
    excludeAgentId,
    limit: Array.isArray(agents) ? agents.length : Number.MAX_SAFE_INTEGER,
  });
  const mentions = [];
  const seen = new Set();

  for (const agentId of inlineMentions) {
    if (seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    mentions.push(agentId);
  }

  const final = explicitFinal ? true : explicitContinue ? false : mentions.length === 0;
  const reason = String(payload.reason || '').trim();

  if (!publicReply) {
    return createSilentAgentTurnDecision({
      mentions,
      final,
      reason:
        reason ||
        (mentions.length > 0 || explicitContinue || explicitFinal
          ? 'structured_control_reply'
          : options.allowEmptyReply
            ? 'empty_structured_reply'
            : 'structured_reply_without_public_text'),
      raw,
    });
  }

  return {
    publicReply,
    mentions,
    final,
    reason,
    raw,
    fallback: false,
    silent: false,
  };
}

function extractStreamingJsonStringField(text: any, fieldNames: any) {
  const source = String(text || '');

  for (const fieldName of Array.isArray(fieldNames) ? fieldNames : []) {
    const keyPattern = new RegExp(`"${String(fieldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`, 'u');
    const match = keyPattern.exec(source);

    if (!match) {
      continue;
    }

    let result = '';
    let escaping = false;

    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const character = source[index];

      if (escaping) {
        if (character === 'n') {
          result += '\n';
        } else if (character === 'r') {
          result += '\r';
        } else if (character === 't') {
          result += '\t';
        } else if (character === 'u') {
          const unicodeHex = source.slice(index + 1, index + 5);

          if (/^[0-9a-fA-F]{4}$/.test(unicodeHex)) {
            result += String.fromCharCode(Number.parseInt(unicodeHex, 16));
            index += 4;
          } else {
            break;
          }
        } else {
          result += character;
        }

        escaping = false;
        continue;
      }

      if (character === '\\') {
        escaping = true;
        continue;
      }

      if (character === '"') {
        return result.trim();
      }

      result += character;
    }

    return result.trim();
  }

  return '';
}

function extractStreamingPublicReplyPreview(text: any) {
  const raw = String(text || '').trim();

  if (!raw) {
    return '';
  }

  const preview = extractStreamingJsonStringField(raw, ['publicReply', 'reply', 'message', 'output', 'finalReply', 'answer']);

  if (preview) {
    return preview;
  }

  return raw.startsWith('{') ? '' : raw;
}

const LIVE_TOOL_BRIDGE_HINTS = [
  { token: 'send-public', toolName: 'send-public' },
  { token: 'send-private', toolName: 'send-private' },
  { token: 'read-context', toolName: 'read-context' },
  { token: 'search-messages', toolName: 'search-messages' },
  { token: 'list-memories', toolName: 'list-memories' },
  { token: 'suggest-goal', toolName: 'suggest-goal' },
  { token: 'update-goal-checklist', toolName: 'update-goal-checklist' },
  { token: 'save-memory', toolName: 'save-memory' },
  { token: 'write-experience', toolName: 'write-experience' },
  { token: 'update-memory', toolName: 'update-memory' },
  { token: 'forget-memory', toolName: 'forget-memory' },
  { token: 'list-participants', toolName: 'participants' },
  { token: 'trellis-init', toolName: 'trellis-init' },
  { token: 'trellis-write', toolName: 'trellis-write' },
];

function normalizePiToolContentType(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function inferBridgeToolNameFromCommand(command: any) {
  const normalizedCommand = String(command || '').trim().toLowerCase();

  if (!normalizedCommand) {
    return '';
  }

  for (const candidate of LIVE_TOOL_BRIDGE_HINTS) {
    if (normalizedCommand.includes(candidate.token)) {
      return candidate.toolName;
    }
  }

  return '';
}

function stringifyLiveToolStepSignatureValue(value: any) {
  if (value == null || value === '') {
    return '';
  }

  if (typeof value === 'string') {
    return clipText(value, 240);
  }

  try {
    return clipText(JSON.stringify(value), 240);
  } catch {
    return clipText(String(value), 240);
  }
}

function liveSessionToolStepSignature(step: any) {
  if (!step || typeof step !== 'object') {
    return '';
  }

  return JSON.stringify([
    step && step.stepId ? String(step.stepId).trim() : '',
    step && step.toolName ? String(step.toolName).trim() : '',
    step && step.bridgeToolHint ? String(step.bridgeToolHint).trim() : '',
    step && step.status ? String(step.status).trim().toLowerCase() : '',
    stringifyLiveToolStepSignatureValue(step && step.requestSummary !== undefined ? step.requestSummary : null),
    stringifyLiveToolStepSignatureValue(step && step.partialJson ? step.partialJson : ''),
  ]);
}

function stringifyLiveToolIdentityValue(value: any) {
  if (value == null || value === '') {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function liveToolIdentityTextMatches(previous: any, next: any) {
  const previousText = String(previous || '');
  const nextText = String(next || '');

  if (!previousText || !nextText) {
    return false;
  }

  return previousText === nextText || previousText.startsWith(nextText) || nextText.startsWith(previousText);
}

function liveAnonymousSessionToolFingerprint(input: any = {}) {
  return JSON.stringify([
    String(input.toolName || '').trim().toLowerCase(),
    String(input.toolKind || '').trim().toLowerCase(),
    String(input.rawToolName || '').trim().toLowerCase(),
    stringifyLiveToolIdentityValue(input.arguments !== undefined ? input.arguments : null),
    String(input.partialJson || '').trim(),
  ]);
}

function sessionStepOrdinal(stepId: any) {
  const match = String(stepId || '')
    .trim()
    .match(/^session-(\d+)$/);

  if (!match) {
    return 0;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function resolveLiveSessionToolIndex(toolCall: any, options: any = {}) {
  const toolCallId = String(toolCall && toolCall.id ? toolCall.id : toolCall && toolCall.toolCallId ? toolCall.toolCallId : '').trim();
  const toolCallIndex = Number.isInteger(options.toolCallIndex) && Number(options.toolCallIndex) >= 0 ? Number(options.toolCallIndex) : -1;
  const tracker = options.anonymousTracker && typeof options.anonymousTracker === 'object' ? options.anonymousTracker : null;

  if (!tracker) {
    return toolCallIndex >= 0 ? toolCallIndex : 0;
  }

  if (!Number.isInteger(tracker.nextIndex) || tracker.nextIndex < 0) {
    tracker.nextIndex = 0;
  }

  if (toolCallId) {
    tracker.activeStepId = '';
    tracker.activeFingerprint = '';
    tracker.activeToolName = '';
    tracker.activeToolKind = '';
    tracker.activeArgumentsText = '';
    tracker.activePartialJsonText = '';

    if (toolCallIndex >= 0) {
      tracker.nextIndex = Math.max(tracker.nextIndex, toolCallIndex + 1);
    }

    return toolCallIndex >= 0 ? toolCallIndex : 0;
  }

  const resolvedToolName = String(options.resolvedToolName || options.rawToolName || '').trim().toLowerCase();
  const resolvedToolKind = String(options.resolvedToolKind || 'session').trim().toLowerCase() || 'session';
  const currentToolName = String(options.currentToolName || '').trim().toLowerCase();
  const currentToolKind = String(options.currentToolKind || '').trim().toLowerCase();
  const currentToolStepId = String(options.currentToolStepId || '').trim();
  const nextArgumentsText = stringifyLiveToolIdentityValue(toolCall && toolCall.arguments !== undefined ? toolCall.arguments : null);
  const nextPartialJsonText = String(toolCall && toolCall.partialJson ? toolCall.partialJson : '').trim();
  const nextFingerprint = liveAnonymousSessionToolFingerprint({
    toolName: resolvedToolName,
    toolKind: resolvedToolKind,
    rawToolName: options.rawToolName,
    arguments: toolCall && toolCall.arguments !== undefined ? toolCall.arguments : null,
    partialJson: toolCall && toolCall.partialJson ? toolCall.partialJson : '',
  });
  const activeStepId = String(tracker.activeStepId || '').trim();
  const activeToolName = String(tracker.activeToolName || '').trim().toLowerCase();
  const activeToolKind = String(tracker.activeToolKind || '').trim().toLowerCase();
  const activeFingerprint = String(tracker.activeFingerprint || '');
  const activeArgumentsText = String(tracker.activeArgumentsText || '');
  const activePartialJsonText = String(tracker.activePartialJsonText || '');
  const payloadLooksContinuous =
    liveToolIdentityTextMatches(activeFingerprint, nextFingerprint) ||
    liveToolIdentityTextMatches(activeArgumentsText, nextArgumentsText) ||
    liveToolIdentityTextMatches(activePartialJsonText, nextPartialJsonText) ||
    liveToolIdentityTextMatches(activeArgumentsText, nextPartialJsonText) ||
    liveToolIdentityTextMatches(activePartialJsonText, nextArgumentsText) ||
    ((!activeArgumentsText && !activePartialJsonText) || (!nextArgumentsText && !nextPartialJsonText));

  if (
    activeStepId &&
    currentToolStepId === activeStepId &&
    currentToolName === activeToolName &&
    currentToolKind === activeToolKind &&
    resolvedToolName === activeToolName &&
    resolvedToolKind === activeToolKind &&
    payloadLooksContinuous
  ) {
    const activeOrdinal = sessionStepOrdinal(activeStepId);

    if (activeOrdinal > 0) {
      tracker.nextIndex = Math.max(tracker.nextIndex, activeOrdinal);
      tracker.activeFingerprint = nextFingerprint;
      tracker.activeArgumentsText = nextArgumentsText;
      tracker.activePartialJsonText = nextPartialJsonText;
      return activeOrdinal - 1;
    }
  }

  const nextOrdinal = Math.max(tracker.nextIndex + 1, toolCallIndex + 1, 1);

  tracker.nextIndex = nextOrdinal;
  tracker.activeStepId = `session-${nextOrdinal}`;
  tracker.activeToolName = resolvedToolName;
  tracker.activeToolKind = resolvedToolKind;
  tracker.activeFingerprint = nextFingerprint;
  tracker.activeArgumentsText = nextArgumentsText;
  tracker.activePartialJsonText = nextPartialJsonText;
  return nextOrdinal - 1;
}

export function extractLiveSessionToolFromPiEvent(piEvent: any, options: any = {}) {
  const message = piEvent && piEvent.message && piEvent.message.role === 'assistant' ? piEvent.message : null;

  if (!message || !Array.isArray(message.content)) {
    return null;
  }

  let toolCall = null;
  let toolCallIndex = -1;
  let seenToolCalls = 0;

  for (const item of message.content) {
    const type = normalizePiToolContentType(item && item.type ? item.type : '');

    if (type !== 'tool_call' && type !== 'toolcall' && type !== 'tool_use' && type !== 'tooluse') {
      continue;
    }

    toolCall = item;
    toolCallIndex = seenToolCalls;
    seenToolCalls += 1;
  }

  if (!toolCall) {
    return null;
  }

  const rawToolName = String(toolCall && toolCall.name ? toolCall.name : '').trim();

  if (!rawToolName) {
    return null;
  }

  const inferredBridgeToolName =
    rawToolName.toLowerCase() === 'bash'
      ? inferBridgeToolNameFromCommand(toolCall && toolCall.arguments ? toolCall.arguments.command : '')
      : '';
  const toolName = inferredBridgeToolName || rawToolName;
  const toolKind = inferredBridgeToolName ? 'bridge' : 'session';

  if (!toolName) {
    return null;
  }

  const stepIndex = resolveLiveSessionToolIndex(
    {
      id: toolCall && toolCall.id ? toolCall.id : '',
      toolCallId: toolCall && toolCall.toolCallId ? toolCall.toolCallId : '',
      arguments: toolCall && toolCall.arguments !== undefined ? toolCall.arguments : null,
      partialJson: toolCall && toolCall.partialJson ? toolCall.partialJson : '',
    },
    {
      toolCallIndex,
      rawToolName,
      resolvedToolName: toolName,
      resolvedToolKind: toolKind,
      currentToolName: options.currentToolName,
      currentToolKind: options.currentToolKind,
      currentToolStepId: options.currentToolStepId,
      anonymousTracker: options.anonymousTracker,
    }
  );

  const step = createLiveSessionToolStep(
    {
      id: toolCall && toolCall.id ? toolCall.id : '',
      name: rawToolName,
      arguments: toolCall && toolCall.arguments !== undefined ? toolCall.arguments : null,
      partialJson: toolCall && toolCall.partialJson ? toolCall.partialJson : '',
    },
    {
      agentDir: options.agentDir,
      createdAt: options.createdAt || nowIso(),
      status: 'running',
      index: stepIndex,
    }
  );

  return {
    currentTool: {
      toolName,
      toolKind,
      toolStepId: step && step.stepId ? String(step.stepId) : String(toolCall && toolCall.id ? toolCall.id : '').trim(),
      inferred: Boolean(inferredBridgeToolName),
    },
    step,
  };
}

function applyStageCurrentTool(stage: any, nextTool: any = null) {
  if (!stage) {
    return false;
  }

  const nextToolName = nextTool && nextTool.toolName ? String(nextTool.toolName).trim() : '';
  const nextToolKind = nextTool && nextTool.toolKind ? String(nextTool.toolKind).trim() : '';
  const nextToolStepId = nextTool && nextTool.toolStepId ? String(nextTool.toolStepId).trim() : '';
  const nextToolInferred = Boolean(nextTool && nextTool.inferred && nextToolName);
  const currentToolName = String(stage.currentToolName || '').trim();
  const currentToolKind = String(stage.currentToolKind || '').trim();
  const currentToolStepId = String(stage.currentToolStepId || '').trim();
  const currentToolInferred = Boolean(stage.currentToolInferred);

  if (
    currentToolName === nextToolName &&
    currentToolKind === nextToolKind &&
    currentToolStepId === nextToolStepId &&
    currentToolInferred === nextToolInferred
  ) {
    return false;
  }

  stage.currentToolName = nextToolName;
  stage.currentToolKind = nextToolName ? nextToolKind || 'session' : '';
  stage.currentToolStepId = nextToolName ? nextToolStepId : '';
  stage.currentToolInferred = nextToolInferred;
  stage.currentToolStartedAt = nextToolName ? nowIso() : null;
  return true;
}

function updateStageCurrentTool(stage: any, turnState: any, emitTurnProgress: any, nextTool: any = null) {
  if (!applyStageCurrentTool(stage, nextTool)) {
    return false;
  }

  if (!turnState || typeof emitTurnProgress !== 'function') {
    return true;
  }

  turnState.updatedAt = nowIso();
  syncCurrentTurnAgent(turnState);
  emitTurnProgress(turnState);
  return true;
}

async function waitForAssistantMessageCompleted(callback: any, message: any) {
  await Promise.resolve().then(() => callback(message));
}

export function createAgentExecutor(options: any = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const modeStore = options.modeStore;
  const getProjectDir = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const agentToolBridge = options.agentToolBridge;
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};
  const broadcastConversationSummary =
    typeof options.broadcastConversationSummary === 'function' ? options.broadcastConversationSummary : () => {};
  const emitTurnProgress = typeof options.emitTurnProgress === 'function' ? options.emitTurnProgress : () => {};
  const agentDir = options.agentDir;
  const sqlitePath = options.sqlitePath;
  const uploadsDir = String(options.uploadsDir || '').trim();
  const modelCatalog = options.modelCatalog;
  const toolBaseUrl = String(options.toolBaseUrl || '').trim();
  const agentToolScriptPath = options.agentToolScriptPath;
  const agentToolRelativePath = String(options.agentToolRelativePath || './lib/agent-chat-tools.js').trim() || './lib/agent-chat-tools.js';
  const piCapabilityExtensionPath = String(options.piCapabilityExtensionPath || '').trim();
  const browserCliPath = String(options.browserCliPath || '').trim() || resolveBrowserCliPath({ rootDir: process.cwd() });
  const onAssistantMessageCompleted =
    typeof options.onAssistantMessageCompleted === 'function' ? options.onAssistantMessageCompleted : null;
  const enableAutomaticRelatedMemory = options.enableAutomaticRelatedMemory === true;

  async function executeConversationAgent({
    runStore,
    conversationId,
    turnId,
    rootTaskId,
    conversation,
    promptMessages,
    promptUserMessage,
    queueItem,
    agent,
    turnState,
    completedReplies,
    failedReplies,
    routingMode,
    hop,
    remainingSlots,
    enqueueAgent,
    allowHandoffs = true,
    finalStopsTurn = true,
    projectDir,
  }: any) {
    const stage = getTurnStage(turnState, agent.id);

    if (!stage) {
      return {
        stopTurn: false,
        terminationReason: '',
      };
    }

    if (turnState.stopRequested) {
      return {
        stopTurn: true,
        terminationReason: 'stopped_by_user',
      };
    }

    const baseAgentConfig = resolveConversationAgentConfig(agent);
    const conversationType = conversation && conversation.type ? String(conversation.type).trim() : 'standard';
    const modeForType = modeStore ? modeStore.get(conversationType) : null;
    const modeSkillIds = modeForType && Array.isArray(modeForType.skillIds) ? modeForType.skillIds : [];
    const modeLoadingStrategy = modeForType ? String(modeForType.loadingStrategy || 'dynamic').trim() : 'dynamic';
    const agentConfig = {
      ...baseAgentConfig,
      conversationSkillIds: mergeSkillIds(baseAgentConfig.conversationSkillIds, modeSkillIds),
    };
    const agentSandbox = ensureAgentSandbox(agentDir, agent);
    const snapshotProvided = projectDir !== undefined;
    const projectDirCandidate = snapshotProvided
      ? String(projectDir || '').trim()
      : getProjectDir
        ? String(getProjectDir(conversation) || '').trim()
        : '';
    const resolvedProjectDir = projectDirCandidate ? path.resolve(projectDirCandidate) : '';
    const extraSkillDirs = resolvedProjectDir
      ? [path.join(resolvedProjectDir, '.agents', 'skills'), path.join(resolvedProjectDir, '.codex', 'skills')]
      : [];
    const resolvedPersonaSkills = skillRegistry.resolveSkills(agentConfig.skillIds, { extraSkillDirs });
    const resolvedConversationSkills = skillRegistry.resolveSkills(agentConfig.conversationSkillIds, { extraSkillDirs });
    const privateMessages = store.listPrivateMessagesForAgent(conversationId, agent.id, {
      limit: MAX_PRIVATE_CONTEXT_MESSAGES,
    });
    const relatedMemorySegments = enableAutomaticRelatedMemory
      ? resolveRelatedMemorySegments(store, conversationId, conversation, promptMessages, {
          projectDir: resolvedProjectDir,
        })
      : [];
    const readImageBytes = (block: any) => {
      const url = String(block && block.url || '').trim();
      if (!uploadsDir || !url.startsWith('/uploads/')) {
        return null;
      }
      const filePath = path.join(uploadsDir, url.slice('/uploads'.length));

      if (!fs.existsSync(filePath)) {
        const imageId = String(block && block.imageId || '').trim();

        if (imageId && typeof store.markImageUploadIntegrityFailure === 'function') {
          try {
            store.markImageUploadIntegrityFailure(imageId, `file missing at runtime: ${url}`);
          } catch {}
        }

        return null;
      }

      try {
        return fs.readFileSync(filePath);
      } catch (error) {
        const imageId = String(block && block.imageId || '').trim();

        if (imageId && typeof store.markImageUploadIntegrityFailure === 'function') {
          try {
            store.markImageUploadIntegrityFailure(
              imageId,
              `file read failed at runtime: ${(error as Error).message || String(error)}`
            );
          } catch {}
        }

        return null;
      }
    };
    const imageInvocation = buildInvocationImages({
      promptMessages,
      modelCatalog,
      agent,
      readImageBytes,
    });
    const imageBlock = imageInvocation.block;
    const invocationImages = imageInvocation.images;
    const projectedConversationHistory = imageInvocation.projectedText || '';
    const promptInput = {
      conversation,
      agent,
      agentConfig,
      resolvedPersonaSkills,
      resolvedConversationSkills,
      sandbox: agentSandbox,
      projectDir: resolvedProjectDir,
      agents: conversation.agents,
      messages: promptMessages,
      privateMessages,
      relatedMemorySegments,
      trigger: queueItem,
      remainingSlots,
      routingMode,
      allowHandoffs,
      agentToolRelativePath,
      modeLoadingStrategy,
      forceDynamicConversationSkillIds: ALWAYS_DYNAMIC_MODE_SKILL_IDS,
      browserCliPath,
      projectedConversationHistory,
    };
    const promptSections = buildAgentTurnPromptSections(promptInput);
    const prompt = formatAgentTurnPromptSections(promptSections);
    const runtimeConfigResolved = Boolean(agent && agent.runtimeConfig && typeof agent.runtimeConfig === 'object');
    const provider = runtimeConfigResolved
      ? agentConfig.provider
      : resolveSetting(agentConfig.provider, process.env.PI_PROVIDER, DEFAULT_PROVIDER);
    const model = runtimeConfigResolved
      ? agentConfig.model
      : resolveSetting(agentConfig.model, process.env.PI_MODEL, DEFAULT_MODEL);
    const thinking = runtimeConfigResolved
      ? agentConfig.thinking
      : resolveThinkingSetting(provider, agentConfig.thinking, process.env.PI_THINKING, DEFAULT_THINKING);
    const heartbeatIntervalMs = resolveIntegerSettingCandidates([process.env.PI_HEARTBEAT_INTERVAL_MS, 5000], 'heartbeatIntervalMs');
    const heartbeatTimeoutMs = resolveIntegerSettingCandidates(
      [process.env.PI_HEARTBEAT_TIMEOUT_MS, process.env.PI_IDLE_TIMEOUT_MS, 60000],
      'heartbeatTimeoutMs'
    );
    const stageTaskId = createTaskId('agent-turn');
    // We already inject the full room history into every prompt, so reusing one
    // long-lived provider session per agent only adds cross-turn contamination
    // risk when a run is interrupted or the provider/tool chain records stray
    // partial input. Keep each agent execution in its own session instead.
    const sessionName =
      sanitizeSessionName(
        `chat-${conversationId}-${turnId}-${agent.id}-${agentConfig.profileId || 'default'}-${String(stageTaskId).slice(-12)}`
      ) || `chat-${conversationId}-${turnId}`;
    const assistantMessageId = randomUUID();
    const contextSnapshot = createAgentContextSnapshot({
      conversationId,
      turnId,
      messageId: assistantMessageId,
      agentId: agent.id,
      agentName: agent.name,
      promptVersion: AGENT_PROMPT_VERSION,
      sections: promptSections,
    });

    const queuedMetadata = {
      provider,
      model,
      promptVersion: AGENT_PROMPT_VERSION,
      modelProfileId: agentConfig.profileId,
      modelProfileName: agentConfig.profileName,
      agentSandboxDir: agentSandbox.sandboxDir,
      agentPrivateDir: agentSandbox.privateDir,
      skillIds: agentConfig.skillIds,
      conversationSkillIds: agentConfig.conversationSkillIds,
      sessionName,
      sessionScope: 'agent_turn',
      streaming: false,
      routingMode,
      hop,
      mentions: [] as any[],
      toolBridgeEnabled: true,
      privateOnly: Boolean(queueItem && queueItem.privateOnly),
      triggeredByAgentId: queueItem.triggeredByAgentId || null,
      triggeredByAgentName: queueItem.triggeredByAgentName || '',
      triggeredByMessageId: queueItem.triggeredByMessageId || null,
      triggerType: queueItem.triggerType || 'user',
      crossConversationDeliveryId: queueItem.crossConversationDeliveryId || null,
      agentContextSnapshot: contextSnapshot,
    };

    const assistantMessage = store.createMessage({
      id: assistantMessageId,
      conversationId,
      turnId,
      role: 'assistant',
      agentId: agent.id,
      senderName: agent.name,
      content: 'Thinking...',
      status: 'queued',
      taskId: stageTaskId,
      metadata: queuedMetadata,
    });

    stage.messageId = assistantMessage.id;
    stage.taskId = stageTaskId;
    stage.status = 'queued';
    stage.preview = '';
    stage.errorMessage = '';
    stage.triggeredByAgentId = queueItem.triggeredByAgentId || null;
    stage.triggeredByAgentName = queueItem.triggeredByAgentName || '';
    stage.hop = hop;
    stage.startedAt = null;
    stage.endedAt = null;
    stage.lastTextDeltaAt = null;
    applyStageCurrentTool(stage, null);
    turnState.hopCount = Math.max(turnState.hopCount || 0, hop);
    turnState.updatedAt = nowIso();
    syncCurrentTurnAgent(turnState);

    broadcastEvent('conversation_message_created', { conversationId, message: assistantMessage });
    broadcastConversationSummary(conversationId);
    emitTurnProgress(turnState);

    if (imageBlock) {
      const existingBlockedMessage = store.getMessage(assistantMessage.id);
      const blockedMessage = store.updateMessage(assistantMessage.id, {
        content: '',
        status: 'failed',
        taskId: stageTaskId,
        errorMessage: imageBlock.reason,
        metadata: {
          ...queuedMetadata,
          failure: true,
          invocationBlocks: [{
            code: imageBlock.code,
            reason: imageBlock.reason,
            ...(imageBlock.missingImageIds ? { missingImageIds: imageBlock.missingImageIds } : {}),
          }],
        },
      });

      stage.status = 'failed';
      stage.runId = null;
      stage.replyLength = 0;
      stage.preview = clipText(imageBlock.reason, TURN_PREVIEW_LENGTH);
      stage.errorMessage = imageBlock.reason;
      stage.lastTextDeltaAt = null;
      stage.endedAt = nowIso();
      applyStageCurrentTool(stage, null);

      if (!Boolean(turnState.stopRequested)) {
        failedReplies.push(blockedMessage);
        turnState.failedCount += 1;
      }

      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);

      runStore.updateTask(stageTaskId, {
        status: 'failed',
        runId: null,
        errorMessage: imageBlock.reason,
        endedAt: stage.endedAt,
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_failed', {
        agentId: agent.id,
        agentName: agent.name,
        runId: null,
        errorMessage: imageBlock.reason,
        hop,
      });

      broadcastEvent('conversation_message_updated', { conversationId, message: blockedMessage });
      emitTurnProgress(turnState);

      return {
        stopTurn: false,
        terminationReason: '',
      };
    }

    let activeRunHandle: any = null;
    let bridgePublicCompletionRequested = false;
    const toolInvocation = agentToolBridge.registerInvocation(
      agentToolBridge.createInvocationContext({
        invocationId: queueItem.toolInvocationId || undefined,
        conversationId,
        turnId,
        projectDir: resolvedProjectDir,
        agentId: agent.id,
        agentName: agent.name,
        incomingDeliveryId: queueItem.crossConversationDeliveryId || null,
        assistantMessageId: assistantMessage.id,
        userMessageId: promptUserMessage && promptUserMessage.id ? promptUserMessage.id : null,
        promptUserMessage,
        conversationAgents: conversation.agents,
        runStore,
        stage,
        turnState,
        enqueueAgent,
        allowHandoffs,
        autoCompleteOnPublicPost: true,
        onPublicPostCompleted(event: any = {}) {
          if (bridgePublicCompletionRequested || !activeRunHandle || typeof activeRunHandle.complete !== 'function') {
            return;
          }

          bridgePublicCompletionRequested = true;
          runStore.appendTaskEvent(stageTaskId, 'agent_reply_bridge_auto_completed', {
            conversationId,
            turnId,
            agentId: agent.id,
            agentName: agent.name,
            messageId: assistantMessage.id,
            publicPostCount: event.publicPostCount || toolInvocation.publicPostCount || 0,
            publicPostMode: event.publicPostMode || '',
          });
          activeRunHandle.complete('Chat bridge public reply posted; completing turn without raw final reply.');
        },
      })
    );

    runStore.createTask({
      taskId: stageTaskId,
      parentTaskId: rootTaskId,
      parentRunId: queueItem.parentRunId || null,
      kind: 'conversation_agent_reply',
      title: `${agent.name} reply`,
      status: 'queued',
      assignedAgent: 'pi',
      assignedRole: agent.name,
      provider,
      model,
      requestedSession: sessionName,
      inputText: prompt,
      metadata: {
        conversationId,
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        promptVersion: AGENT_PROMPT_VERSION,
        agentSandboxDir: agentSandbox.sandboxDir,
        agentPrivateDir: agentSandbox.privateDir,
        modelProfileId: agentConfig.profileId,
        modelProfileName: agentConfig.profileName,
        skillIds: agentConfig.skillIds,
        conversationSkillIds: agentConfig.conversationSkillIds,
        hop,
        routingMode,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        triggeredByMessageId: queueItem.triggeredByMessageId || null,
        toolBridgeEnabled: true,
      },
      startedAt: nowIso(),
    });
    runStore.appendTaskEvent(stageTaskId, 'agent_reply_queued', {
      conversationId,
      turnId,
      agentId: agent.id,
      agentName: agent.name,
      promptVersion: AGENT_PROMPT_VERSION,
      modelProfileId: agentConfig.profileId,
      modelProfileName: agentConfig.profileName,
      hop,
      routingMode,
      triggerType: queueItem.triggerType || 'user',
      triggeredByAgentId: queueItem.triggeredByAgentId || null,
    });
    runStore.appendTaskEvent(stageTaskId, 'agent_expectations', {
      schemaVersion: 1,
      promptVersion: AGENT_PROMPT_VERSION,
      policy: {
        id: 'caff_default',
        version: 'v1',
      },
      expectations: {
        'send-public': queuedMetadata.privateOnly ? 'forbidden' : 'required',
        'send-private': queuedMetadata.privateOnly ? 'required' : 'optional',
        'read-context': 'optional',
        'search-messages': 'optional',
        'write-experience': 'optional',
        participants: 'optional',
        'trellis-init': 'optional',
        'trellis-write': 'optional',
      },
      context: {
        conversationId,
        conversationType: conversation && conversation.type ? conversation.type : 'standard',
        turnId,
        agentId: agent.id,
        agentName: agent.name,
        hop,
        routingMode,
        privateOnly: queuedMetadata.privateOnly,
        allowHandoffs,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        triggeredByMessageId: queueItem.triggeredByMessageId || null,
      },
    });

    const handle = startRun(provider, model, prompt, {
      thinking,
      images: invocationImages,
      extensionPaths: piCapabilityExtensionPath ? [piCapabilityExtensionPath] : [],
      agentDir,
      sqlitePath,
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      extraEnv: {
        PI_AGENT_ID: agent.id,
        PI_AGENT_NAME: agent.name,
        PI_AGENT_SANDBOX_DIR: agentSandbox.sandboxDir,
        PI_AGENT_PRIVATE_DIR: agentSandbox.privateDir,
        CAFF_CHAT_API_URL: toolBaseUrl,
        CAFF_CHAT_INVOCATION_ID: toolInvocation.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: toolInvocation.callbackToken,
        CAFF_CHAT_TOOLS_PATH: toPortableShellPath(agentToolScriptPath),
        CAFF_CHAT_TOOLS_RELATIVE_PATH: agentToolRelativePath,
        CAFF_CHAT_CONVERSATION_ID: conversationId,
        CAFF_CHAT_TURN_ID: turnId,
        ...(browserCliPath
          ? {
              CAFF_BROWSER_CLI_PATH: toPortableShellPath(browserCliPath),
              PLAYWRIGHT_CLI_SESSION: createBrowserCliSessionName(conversationId, agent.id),
            }
          : {}),
      },
      session: sessionName,
      streamOutput: false,
      parentRunId: queueItem.parentRunId || null,
      taskId: stageTaskId,
      taskKind: 'conversation_agent_reply',
      taskRole: agent.name,
      metadata: {
        conversationId,
        turnId,
        agentId: agent.id,
        promptVersion: AGENT_PROMPT_VERSION,
        agentSandboxDir: agentSandbox.sandboxDir,
        agentPrivateDir: agentSandbox.privateDir,
        modelProfileId: agentConfig.profileId,
        modelProfileName: agentConfig.profileName,
        skillIds: agentConfig.skillIds,
        conversationSkillIds: agentConfig.conversationSkillIds,
        hop,
        routingMode,
        triggerType: queueItem.triggerType || 'user',
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        toolBridgeEnabled: true,
      },
    });
    activeRunHandle = handle;
    registerTurnHandle(turnState, handle);

    const startedAt = nowIso();
    let rawReply = '';
    let lastLiveSessionToolStepId = '';
    let lastLiveSessionToolSignature = '';
    const liveSessionAnonymousToolTracker = {
      nextIndex: 0,
      activeStepId: '',
      activeFingerprint: '',
      activeToolName: '',
      activeToolKind: '',
    };
    const startedMetadata = {
      ...queuedMetadata,
      sessionPath: handle.sessionPath || '',
      streaming: true,
      toolInvocationId: toolInvocation.invocationId,
    };

    stage.runId = handle.runId || null;
    stage.status = 'running';
    stage.startedAt = startedAt;
    stage.endedAt = null;
    stage.heartbeatCount = 0;
    stage.replyLength = 0;
    stage.preview = '';
    stage.finalContent = '';
    stage.errorMessage = '';
    stage.lastTextDeltaAt = null;
    applyStageCurrentTool(stage, null);
    turnState.updatedAt = startedAt;
    syncCurrentTurnAgent(turnState);

    const startedMessage = store.updateMessage(assistantMessage.id, {
      status: 'streaming',
      taskId: stageTaskId,
      runId: handle.runId || null,
      metadata: startedMetadata,
    });

    runStore.updateTask(stageTaskId, {
      status: 'running',
      parentRunId: queueItem.parentRunId || null,
      runId: handle.runId,
      sessionPath: handle.sessionPath,
      startedAt,
    });
    runStore.appendTaskEvent(stageTaskId, 'agent_reply_started', {
      agentId: agent.id,
      agentName: agent.name,
      runId: handle.runId,
      sessionPath: handle.sessionPath,
      hop,
      routingMode,
    });

    broadcastEvent('conversation_message_updated', { conversationId, message: startedMessage });
    emitTurnProgress(turnState);

    handle.on('pi_event', (event: any) => {
      const liveTool = extractLiveSessionToolFromPiEvent(event && event.piEvent ? event.piEvent : null, {
        agentDir,
        createdAt: nowIso(),
        currentToolName: stage.currentToolName,
        currentToolKind: stage.currentToolKind,
        currentToolStepId: stage.currentToolStepId,
        anonymousTracker: liveSessionAnonymousToolTracker,
      });

      if (!liveTool || !liveTool.currentTool) {
        return;
      }

      const step = liveTool.step || null;
      const stepId = step && step.stepId ? String(step.stepId).trim() : '';
      const stepSignature = liveSessionToolStepSignature(step);
      const changed = updateStageCurrentTool(stage, turnState, emitTurnProgress, liveTool.currentTool);
      const detailChanged = Boolean(
        step &&
          stepId &&
          stepSignature &&
          stepId === lastLiveSessionToolStepId &&
          stepSignature !== lastLiveSessionToolSignature
      );

      if (stepId && stepSignature) {
        lastLiveSessionToolStepId = stepId;
        lastLiveSessionToolSignature = stepSignature;
      } else if (changed) {
        lastLiveSessionToolStepId = '';
        lastLiveSessionToolSignature = '';
      }

      if (!step) {
        return;
      }

      if (changed) {
        broadcastEvent('conversation_tool_event', {
          conversationId,
          turnId,
          taskId: stageTaskId,
          agentId: agent.id,
          agentName: agent.name,
          assistantMessageId: assistantMessage.id,
          messageId: assistantMessage.id,
          phase: 'started',
          step,
        });
        return;
      }

      if (!detailChanged) {
        return;
      }

      broadcastEvent('conversation_tool_event', {
        conversationId,
        turnId,
        taskId: stageTaskId,
        agentId: agent.id,
        agentName: agent.name,
        assistantMessageId: assistantMessage.id,
        messageId: assistantMessage.id,
        phase: 'updated',
        step,
      });
    });

    handle.on('assistant_text_delta', (event: any) => {
      rawReply += event.delta || '';
      updateStageCurrentTool(stage, turnState, emitTurnProgress, null);

      if (!toolInvocation.publicToolUsed) {
        return;
      }

      const previewText = toolInvocation.lastPublicContent || extractStreamingPublicReplyPreview(rawReply) || '';
      const deltaTimestamp = nowIso();
      stage.status = 'running';
      stage.replyLength = previewText.length;
      stage.preview = clipText(previewText, TURN_PREVIEW_LENGTH);
      stage.lastTextDeltaAt = deltaTimestamp;
      turnState.updatedAt = deltaTimestamp;
      syncCurrentTurnAgent(turnState);
      emitTurnProgress(turnState);
    });

    handle.on('heartbeat', (event: any) => {
      stage.heartbeatCount = event.count || 0;
      turnState.updatedAt = nowIso();
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_heartbeat', {
        count: event.count,
        reason: sanitizeReason(event.payload && event.payload.reason),
      });
      emitTurnProgress(turnState);
    });

    handle.on('run_terminating', (event: any) => {
      stage.status = 'terminating';
      stage.errorMessage = event.reason && event.reason.message ? event.reason.message : '';
      applyStageCurrentTool(stage, null);
      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_terminating', event.reason || null);
      emitTurnProgress(turnState);
    });

    try {
      const result = await handle.resultPromise;
      const finalRawReply = String(result.reply || rawReply || '').trim();

      // Fallback: some models print a bash heredoc as plain text instead of emitting a tool_use block.
      // When that happens, the command never runs and the game host cannot see the intended vote / action.
      // We replay the safest subset of bridge commands (send-public/send-private via --content-stdin heredoc)
      // by directly invoking the agent tool bridge, then continue with normal decision parsing.
      if (
        agentToolBridge &&
        !toolInvocation.publicToolUsed &&
        (toolInvocation.privatePostCount || 0) === 0 &&
        finalRawReply
      ) {
        const replay = pickChatBridgeReplay(extractChatBridgeReplaysFromText(finalRawReply), {
          privateOnly: Boolean(queueItem && queueItem.privateOnly),
        });

        if (replay) {
          try {
            const body: any = {
              invocationId: toolInvocation.invocationId,
              callbackToken: toolInvocation.callbackToken,
              visibility: replay.visibility,
              content: replay.content,
            };

            if (replay.visibility === 'public') {
              body.mode = replay.mode || 'replace';
            } else {
              if (replay.recipients.length > 0) {
                body.recipientAgentIds = replay.recipients;
              }

              if (replay.handoff) {
                body.handoff = true;
              }

              if (replay.noHandoff) {
                body.noHandoff = true;
              }
            }

            agentToolBridge.handlePostMessage(body);
          } catch {
            // Ignore fallback failures and keep the raw reply.
          }
        }
      }

      const suppressRawPublicReply = !toolInvocation.publicToolUsed && (toolInvocation.privatePostCount || 0) > 0;
      const decisionSource =
        toolInvocation.publicToolUsed && String(toolInvocation.lastPublicContent || '').trim()
          ? String(toolInvocation.lastPublicContent || '').trim()
          : finalRawReply;
      const decision = parseAgentTurnDecision(decisionSource, conversation.agents, {
        currentAgentId: agent.id,
        allowEmptyReply: suppressRawPublicReply,
      });
      const mentionedAgents = decision.mentions
        .map((agentId: any) => getAgentById(conversation.agents, agentId))
        .filter(Boolean);
      const publicReply = suppressRawPublicReply ? '' : ensureVisibleMentionText(decision.publicReply, mentionedAgents);
      const publiclySilent = !String(publicReply || '').trim();
      const privateOnly = publiclySilent && suppressRawPublicReply;
      const routedMentions = allowHandoffs ? decision.mentions : [];
      const privateHandoffCount = toolInvocation.privateHandoffCount || 0;
      const continuedByPrivateHandoff = allowHandoffs && privateHandoffCount > 0;
      const effectiveFinal = allowHandoffs ? decision.final && !continuedByPrivateHandoff : true;
      const tokenUsage = summarizeTokenUsage(result.usage);
      const modelUsage = summarizeModelUsageCalls(result.usageCalls);
      const finalMetadata = {
        provider,
        model,
        promptVersion: AGENT_PROMPT_VERSION,
        heartbeatCount: result.heartbeatCount || 0,
        sessionName,
        sessionScope: 'agent_turn',
        sessionPath: result.sessionPath || handle.sessionPath || '',
        agentSandboxDir: agentSandbox.sandboxDir,
        agentPrivateDir: agentSandbox.privateDir,
        streaming: false,
        routingMode,
        hop,
        mentions: decision.mentions,
        routedMentions,
        mentionNames: mentionedAgents.map((item: any) => item.name),
        final: effectiveFinal,
        reason: decision.reason || '',
        fallback: Boolean(decision.fallback),
        handoffSuppressed: !allowHandoffs && decision.mentions.length > 0,
        toolBridgeEnabled: true,
        publicToolUsed: Boolean(toolInvocation.publicToolUsed),
        publicPostCount: toolInvocation.publicPostCount || 0,
        privatePostCount: toolInvocation.privatePostCount || 0,
        privateHandoffCount,
        continuedByPrivateHandoff,
        publiclySilent,
        privateOnly,
        silentReply: Boolean(decision.silent),
        triggeredByAgentId: queueItem.triggeredByAgentId || null,
        triggeredByAgentName: queueItem.triggeredByAgentName || '',
        triggeredByMessageId: queueItem.triggeredByMessageId || null,
        triggerType: queueItem.triggerType || 'user',
        usage: result.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage : null,
        tokenUsage,
        modelUsage,
        agentContextSnapshot: contextSnapshot,
      };
      const assistantMessageDone = store.updateMessage(assistantMessage.id, {
        content: publicReply,
        status: 'completed',
        taskId: stageTaskId,
        runId: result.runId || handle.runId || null,
        errorMessage: '',
        metadata: finalMetadata,
      });

      markConversationRetrievalTraceUsage(store, conversationId, {
        assistantMessageId: assistantMessageDone.id,
        agentId: agent.id,
        replyText: publicReply,
      });

      completedReplies.push(assistantMessageDone);
      stage.status = 'completed';
      stage.runId = result.runId || handle.runId || null;
      stage.heartbeatCount = result.heartbeatCount || 0;
      stage.replyLength = publicReply.length;
      stage.preview = clipText(publicReply, TURN_PREVIEW_LENGTH);
      stage.finalContent = publicReply;
      stage.errorMessage = '';
      stage.lastTextDeltaAt = stage.lastTextDeltaAt || null;
      stage.endedAt = nowIso();
      applyStageCurrentTool(stage, null);
      turnState.completedCount += 1;
      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);

      runStore.updateTask(stageTaskId, {
        status: 'succeeded',
        runId: result.runId || handle.runId || null,
        sessionPath: result.sessionPath,
        outputText: publicReply,
        endedAt: stage.endedAt,
        artifactSummary: {
          kind: 'text/plain',
          name: `${agent.name}-reply.txt`,
          mentions: decision.mentions,
          routedMentions,
          final: effectiveFinal,
          hop,
        },
      });
      runStore.addArtifact(stageTaskId, {
        kind: 'text',
        name: `${agent.name}-reply.txt`,
        mimeType: 'text/plain',
        contentText: publicReply,
        metadata: {
          conversationId,
          turnId,
          agentId: agent.id,
          agentName: agent.name,
          hop,
          mentions: decision.mentions,
          routedMentions,
          final: effectiveFinal,
          publicToolUsed: Boolean(toolInvocation.publicToolUsed),
          privateHandoffCount,
          continuedByPrivateHandoff,
          publiclySilent,
          privateOnly,
          silentReply: Boolean(decision.silent),
          rawReply: finalRawReply,
        },
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_succeeded', {
        agentId: agent.id,
        agentName: agent.name,
        runId: result.runId || null,
        replyLength: publicReply.length,
        hop,
        mentions: decision.mentions,
        routedMentions,
        final: effectiveFinal,
        privateHandoffCount,
      });

      emitTurnProgress(turnState);
      broadcastEvent('conversation_message_updated', { conversationId, message: assistantMessageDone });
      broadcastConversationSummary(conversationId);

      if (onAssistantMessageCompleted) {
        try {
          await waitForAssistantMessageCompleted(onAssistantMessageCompleted, assistantMessageDone);
        } catch (error) {
          const errorValue = error as any;
          const errorMessage = errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error');
          console.error('[assistant-message-hook] Failed to handle completed assistant message:', errorMessage);
        }
      }

      if (!allowHandoffs) {
        return {
          stopTurn: false,
          terminationReason: '',
        };
      }

      if (effectiveFinal) {
        if (!finalStopsTurn) {
          return {
            stopTurn: false,
            terminationReason: '',
          };
        }

        runStore.appendTaskEvent(rootTaskId, 'agent_turn_finalized', {
          conversationId,
          turnId,
          agentId: agent.id,
          agentName: agent.name,
          messageId: assistantMessageDone.id,
          hop,
        });

        return {
          stopTurn: true,
          terminationReason: 'agent_final',
        };
      }

      const enqueuedAgentIds =
        enqueueAgent && routedMentions.length > 0
          ? enqueueAgent({
              agentIds: routedMentions,
              triggerType: 'agent',
              triggeredByAgentId: agent.id,
              triggeredByAgentName: agent.name,
              triggeredByMessageId: assistantMessageDone.id,
              parentRunId: result.runId || handle.runId || null,
              enqueueReason: decision.reason || '',
            })
          : [];

      if (enqueuedAgentIds.length > 0) {
        runStore.appendTaskEvent(rootTaskId, 'agent_turn_routed', {
          conversationId,
          turnId,
          fromAgentId: agent.id,
          fromAgentName: agent.name,
          toAgentIds: enqueuedAgentIds,
          messageId: assistantMessageDone.id,
          hop,
        });
        emitTurnProgress(turnState);
      }

      return {
        stopTurn: false,
        terminationReason: '',
      };
    } catch (error) {
      const errorValue = error as any;
      const errorMessage = errorValue && errorValue.message ? errorValue.message : String(errorValue || 'Unknown error');
      const stopRequested = Boolean(turnState.stopRequested);
      const errorUsage = errorValue && errorValue.usage && typeof errorValue.usage === 'object' && !Array.isArray(errorValue.usage) ? errorValue.usage : null;
      const errorTokenUsage = summarizeTokenUsage(errorUsage);
      const errorModelUsage = summarizeModelUsageCalls(errorValue && errorValue.usageCalls);
      const existingMessage = store.getMessage(assistantMessage.id);
      const assistantMessageFailed = store.updateMessage(assistantMessage.id, {
        content: existingMessage && existingMessage.content !== 'Thinking...' ? existingMessage.content : '',
        status: 'failed',
        taskId: stageTaskId,
        runId: errorValue && errorValue.runId ? errorValue.runId : handle.runId || null,
        errorMessage,
        metadata: {
          provider,
          model,
          sessionName,
          sessionScope: 'agent_turn',
          sessionPath: errorValue && errorValue.sessionPath ? errorValue.sessionPath : handle.sessionPath || '',
          agentSandboxDir: agentSandbox.sandboxDir,
          agentPrivateDir: agentSandbox.privateDir,
          failure: true,
          streaming: false,
          routingMode,
          hop,
          cancelled: stopRequested,
          toolBridgeEnabled: true,
          publicToolUsed: Boolean(toolInvocation.publicToolUsed),
          publicPostCount: toolInvocation.publicPostCount || 0,
          privatePostCount: toolInvocation.privatePostCount || 0,
          privateHandoffCount: toolInvocation.privateHandoffCount || 0,
          triggeredByAgentId: queueItem.triggeredByAgentId || null,
          triggeredByAgentName: queueItem.triggeredByAgentName || '',
          triggeredByMessageId: queueItem.triggeredByMessageId || null,
          triggerType: queueItem.triggerType || 'user',
          usage: errorUsage,
          tokenUsage: errorTokenUsage,
          modelUsage: errorModelUsage,
          agentContextSnapshot: contextSnapshot,
        },
      });

      stage.status = 'failed';
      stage.runId = errorValue && errorValue.runId ? errorValue.runId : handle.runId || null;
      stage.replyLength = assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content.length : 0;
      stage.preview = clipText(
        assistantMessageFailed && assistantMessageFailed.content ? assistantMessageFailed.content : errorMessage,
        TURN_PREVIEW_LENGTH
      );
      stage.errorMessage = errorMessage;
      stage.lastTextDeltaAt = stage.lastTextDeltaAt || null;
      stage.endedAt = nowIso();
      applyStageCurrentTool(stage, null);

      if (!stopRequested) {
        failedReplies.push(assistantMessageFailed);
        turnState.failedCount += 1;
      }

      turnState.updatedAt = nowIso();
      syncCurrentTurnAgent(turnState);

      runStore.updateTask(stageTaskId, {
        status: stopRequested ? 'cancelled' : 'failed',
        runId: errorValue && errorValue.runId ? errorValue.runId : handle.runId || null,
        errorMessage,
        endedAt: stage.endedAt,
      });
      runStore.appendTaskEvent(stageTaskId, 'agent_reply_failed', {
        agentId: agent.id,
        agentName: agent.name,
        runId: errorValue && errorValue.runId ? errorValue.runId : handle.runId || null,
        errorMessage,
        hop,
      });

      broadcastEvent('conversation_message_updated', { conversationId, message: assistantMessageFailed });
      broadcastConversationSummary(conversationId);
      emitTurnProgress(turnState);

      if (stopRequested) {
        return {
          stopTurn: true,
          terminationReason: 'stopped_by_user',
        };
      }

      return {
        stopTurn: false,
        terminationReason: '',
      };
    } finally {
      agentToolBridge.unregisterInvocation(toolInvocation && toolInvocation.invocationId);
      unregisterTurnHandle(turnState, handle);
    }
  }

  return {
    executeConversationAgent,
    parseAgentTurnDecision,
  };
}
