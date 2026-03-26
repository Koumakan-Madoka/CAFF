export function normalizeMentionToken(value: any) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^[^\p{L}\p{N}_-]+/gu, '')
    .replace(/[^\p{L}\p{N}._-]+$/gu, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const MENTION_LINE_BOUNDARY_RE = /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』]/u;
const MENTION_HANDLE_CONTINUATION_RE = /[A-Za-z0-9_.-]/;
const MENTION_TOKEN_RE = /@([\p{L}\p{N}._-]+)/gu;
const ESCAPED_NEWLINE_RE = /\\r\\n|\\n|\\r/g;
const MENTION_SEPARATOR_RE = /[\s\p{P}\p{S}]+/gu;

export function buildAgentMentionLookup(agents: any) {
  const lookup = new Map();

  for (const agent of Array.isArray(agents) ? agents : []) {
    const aliases = new Set();
    const id = String(agent && agent.id ? agent.id : '').trim();
    const name = String(agent && agent.name ? agent.name : '').trim();

    if (id) {
      aliases.add(id);

      if (id.startsWith('agent-') && id.length > 6) {
        aliases.add(id.slice(6));
      }
    }

    if (name) {
      aliases.add(name);
      aliases.add(name.replace(/\s+/g, ''));
      aliases.add(name.replace(/\s+/g, '-'));
      aliases.add(name.replace(/\s+/g, '_'));
    }

    for (const alias of aliases) {
      const normalized = normalizeMentionToken(alias);

      if (normalized && !lookup.has(normalized)) {
        lookup.set(normalized, id);
      }
    }
  }

  return lookup;
}

export function resolveMentionValues(values: any, agents: any, options: any = {}) {
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.excludeAgentId || '';
  const result: any[] = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = normalizeMentionToken(value);

    if (!normalized) {
      continue;
    }

    const agentId = lookup.get(normalized);

    if (!agentId || agentId === excludeAgentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);
  }

  return result;
}

function normalizeMentionRoutingSource(text: any) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(ESCAPED_NEWLINE_RE, '\n');
}

function isMentionBoundaryChar(character: any) {
  return !character || MENTION_LINE_BOUNDARY_RE.test(character) || !MENTION_HANDLE_CONTINUATION_RE.test(character);
}

function isMentionOnlySuffix(text: any) {
  return !String(text || '')
    .replace(MENTION_TOKEN_RE, '')
    .replace(MENTION_SEPARATOR_RE, '')
    .trim();
}

function collectMentionedAgentIdsFromSegment(
  segment: any,
  lookup: any,
  excludeAgentId: any,
  seen: any,
  limit: any,
  result: any[],
) {
  const source = String(segment || '');
  let match;

  MENTION_TOKEN_RE.lastIndex = 0;

  while ((match = MENTION_TOKEN_RE.exec(source)) !== null) {
    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;
    const charBefore = startIndex > 0 ? source[startIndex - 1] : '';
    const charAfter = source[endIndex] || '';

    if (!isMentionBoundaryChar(charBefore) || !isMentionBoundaryChar(charAfter)) {
      continue;
    }

    const agentId = lookup.get(normalizeMentionToken(match[1]));

    if (!agentId || agentId === excludeAgentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);

    if (result.length >= limit) {
      break;
    }
  }
}

export function extractMentionedAgentIds(text: any, agents: any, options: any = {}) {
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.excludeAgentId || '';
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER;
  const result: any[] = [];
  const seen = new Set();
  const source = normalizeMentionRoutingSource(text);
  const lines = source.split(/\r?\n/);
  let lastNonEmptyLine = '';

  for (const line of lines) {
    const normalizedLine = String(line || '').trim();

    if (!normalizedLine) {
      continue;
    }

    lastNonEmptyLine = normalizedLine;

    if (!normalizedLine.startsWith('@')) {
      continue;
    }

    collectMentionedAgentIdsFromSegment(normalizedLine, lookup, excludeAgentId, seen, limit, result);

    if (result.length >= limit) {
      break;
    }
  }

  if (result.length >= limit || !lastNonEmptyLine || lastNonEmptyLine.startsWith('@') || !lastNonEmptyLine.includes('@')) {
    return result;
  }

  let firstMentionIndex = -1;
  let match;

  MENTION_TOKEN_RE.lastIndex = 0;

  while ((match = MENTION_TOKEN_RE.exec(lastNonEmptyLine)) !== null) {
    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;
    const charBefore = startIndex > 0 ? lastNonEmptyLine[startIndex - 1] : '';
    const charAfter = lastNonEmptyLine[endIndex] || '';

    if (!isMentionBoundaryChar(charBefore) || !isMentionBoundaryChar(charAfter)) {
      continue;
    }

    firstMentionIndex = startIndex;
    break;
  }

  if (firstMentionIndex === -1) {
    return result;
  }

  const trailingMentionBlock = lastNonEmptyLine.slice(firstMentionIndex);

  if (!isMentionOnlySuffix(trailingMentionBlock)) {
    return result;
  }

  collectMentionedAgentIdsFromSegment(trailingMentionBlock, lookup, excludeAgentId, seen, limit, result);

  return result;
}

export function extractRoutingMentionedAgentIds(text: any, agents: any, options: any = {}) {
  const lookup = options.lookup || buildAgentMentionLookup(agents);
  const excludeAgentId = options.excludeAgentId || '';
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : Number.MAX_SAFE_INTEGER;
  const result: any[] = [];
  const seen = new Set();
  const source = String(text || '');
  const mentionRegex = /\*\*@([\p{L}\p{N}._-]+)\*\*/gu;
  let match;

  while ((match = mentionRegex.exec(source)) !== null) {
    const agentId = lookup.get(normalizeMentionToken(match[1]));

    if (!agentId || agentId === excludeAgentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    result.push(agentId);

    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

export function stripTurnRoutingTags(text: any) {
  return String(text || '')
    .replace(/(^|\s)#(?:ideate|execute)\b/giu, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function resolveTurnExecutionMode(text: any, targetCount: any) {
  const source = String(text || '');
  let explicitIntent = '';
  let match;
  const intentRegex = /(^|\s)#(ideate|execute)\b/giu;

  while ((match = intentRegex.exec(source)) !== null) {
    explicitIntent = String(match[2] || '').toLowerCase();
  }

  const cleanedText = stripTurnRoutingTags(source);
  const mode =
    explicitIntent === 'execute'
      ? 'serial'
      : explicitIntent === 'ideate'
        ? targetCount > 1
          ? 'parallel'
          : 'serial'
        : targetCount > 1
          ? 'parallel'
          : 'serial';

  return {
    mode,
    explicitIntent,
    cleanedText: cleanedText || source.trim(),
  };
}

export function getAgentById(agents: any, agentId: any) {
  return Array.isArray(agents) ? agents.find((agent: any) => agent.id === agentId) || null : null;
}

export function formatAgentMention(agent: any) {
  const name = String(agent && agent.name ? agent.name : '').trim();

  if (name) {
    return `@${name.replace(/\s+/g, '')}`;
  }

  return `@${String(agent && agent.id ? agent.id : '').trim()}`;
}

function hasVisibleMentionText(text: any, tag: any) {
  const source = String(text || '');
  const normalizedTag = normalizeMentionToken(tag);

  if (!normalizedTag) {
    return false;
  }

  const mentionRegex = /\*\*@([^\s@()[\]{}<>*]+)\*\*|@([^\s@()[\]{}<>*]+)/gu;
  let match;

  while ((match = mentionRegex.exec(source)) !== null) {
    const boldToken = match[1] || '';
    const plainToken = match[2] || '';
    const token = boldToken || plainToken;

    if (!token) {
      continue;
    }

    if (normalizeMentionToken(token) === normalizedTag) {
      return true;
    }
  }

  return false;
}

export function ensureVisibleMentionText(replyText: any, mentionedAgents: any) {
  const reply = String(replyText || '').trim();

  if (!Array.isArray(mentionedAgents) || mentionedAgents.length === 0) {
    return reply;
  }

  const missingTags = mentionedAgents
    .map(formatAgentMention)
    .filter((tag: any) => {
      return !hasVisibleMentionText(reply, tag);
    });

  if (missingTags.length === 0) {
    return reply;
  }

  if (!reply) {
    return missingTags.join(' ');
  }

  return `${reply}\n\n${missingTags.join(' ')}`;
}
