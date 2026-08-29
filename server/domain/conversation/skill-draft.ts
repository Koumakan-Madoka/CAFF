import * as fs from 'node:fs';
import * as path from 'node:path';

import { createHttpError } from '../../http/http-errors';
import { DEFAULT_AGENT_DIR, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING, invoke, resolveIntegerSetting, resolveSetting, resolveThinkingSetting } from '../../../lib/minimal-pi';
import { buildSkillMarkdown, sanitizeSkillId } from '../../../lib/skill-registry';
import { getConversationDigests } from './conversation-digest';

const CONVERSATION_SKILL_DRAFTS_METADATA_KEY = 'skillDrafts';
const MAX_SKILL_DRAFTS = 5;
const MAX_SKILL_DRAFT_BODY_LENGTH = 8000;
const MAX_SKILL_DRAFT_FIELD_LENGTH = 240;
const MAX_SKILL_DRAFT_ITEMS = 8;
const MAX_EXISTING_SKILL_CANDIDATES = 12;
const MAX_EXISTING_SKILL_BODY_EXCERPT_LENGTH = 1200;
const DEFAULT_SKILL_DRAFT_MODEL_TIMEOUT_MS = 90 * 1000;
const SKILL_DRAFT_ACTIONS = new Set(['list', 'extract', 'confirm', 'reject']);

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value: any) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: any) {
  return String(value || '').trim();
}

function parseJsonObjectFromText(value: any) {
  const text = normalizeText(value).replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim();

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {}

  const startIndex = text.indexOf('{');
  const endIndex = text.lastIndexOf('}');

  if (startIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  try {
    const parsed = JSON.parse(text.slice(startIndex, endIndex + 1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clipText(value: any, maxLength = MAX_SKILL_DRAFT_FIELD_LENGTH) {
  const text = normalizeText(value).replace(/\s+/gu, ' ');

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function normalizeSectionItems(value: any) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n/u)
      : [];

  const seen = new Set<string>();
  const result = [] as string[];

  for (const rawItem of rawItems) {
    const item = clipText(rawItem);
    const key = item.toLowerCase();

    if (!item || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);

    if (result.length >= MAX_SKILL_DRAFT_ITEMS) {
      break;
    }
  }

  return result;
}

function currentMetadata(conversation: any) {
  return conversation && isPlainObject(conversation.metadata) ? conversation.metadata : {};
}

function updateConversationMetadata(store: any, conversation: any, metadata: any) {
  // metadata-only 写入：不传 title，避免 titleSource 状态机误判为 manual 改名。
  return store.updateConversation(conversation.id, {
    type: conversation.type,
    metadata,
  });
}

function normalizeSkillDraftStatus(value: any) {
  const status = normalizeText(value).toLowerCase();
  return status === 'confirmed' || status === 'rejected' ? status : 'pending';
}

function normalizeSkillPayload(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const skillId = sanitizeSkillId(value.id || value.skillId);
  const name = clipText(value.name, 80);
  const description = clipText(value.description, 240);
  const body = normalizeText(value.body).slice(0, MAX_SKILL_DRAFT_BODY_LENGTH).trim();

  if (!skillId || !name || !description || !body) {
    return null;
  }

  return {
    id: skillId,
    name,
    description,
    body,
  };
}

function parseSkillFrontmatterValue(value: any) {
  const text = normalizeText(value);
  if (!text) {
    return '';
  }

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return JSON.parse(text.replace(/^'/u, '"').replace(/'$/u, '"'));
    } catch {
      return text.slice(1, -1);
    }
  }

  return text;
}

function parseSkillMarkdown(content: any) {
  const source = String(content || '');
  const result = {
    name: '',
    description: '',
    body: source.trim(),
  };

  if (!source.startsWith('---\n')) {
    return result;
  }

  const endIndex = source.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return result;
  }

  const frontmatter = source.slice(4, endIndex);
  result.body = source.slice(endIndex + 5).trim();

  for (const line of frontmatter.split(/\r?\n/u)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u);
    if (!match) {
      continue;
    }

    if (match[1] === 'name') {
      result.name = clipText(parseSkillFrontmatterValue(match[2]), 80);
    } else if (match[1] === 'description') {
      result.description = clipText(parseSkillFrontmatterValue(match[2]), 240);
    }
  }

  return result;
}

function resolveProjectDir(options: any = {}, required = false) {
  const resolver = typeof options.getProjectDir === 'function' ? options.getProjectDir : null;
  const rawProjectDir = normalizeText(options.projectDir) || (resolver ? normalizeText(resolver()) : '');

  if (!rawProjectDir) {
    if (required) {
      throw createHttpError(409, 'No active project is available for project skill drafts');
    }
    return '';
  }

  return path.resolve(rawProjectDir);
}

function resolveProjectSkillRootOptional(options: any = {}) {
  const projectDir = resolveProjectDir(options, false);
  if (!projectDir) {
    return '';
  }

  const rootDir = path.resolve(projectDir, '.agents', 'skills');
  assertPathWithinRoot(projectDir, rootDir);
  return rootDir;
}

function listExistingProjectSkills(options: any = {}) {
  let rootDir = '';
  try {
    rootDir = resolveProjectSkillRootOptional(options);
  } catch {
    return [];
  }

  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }

  const skills = [] as any[];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const id = sanitizeSkillId(entry.name);
    const skillFilePath = path.join(rootDir, entry.name, 'SKILL.md');
    if (!id || !fs.existsSync(skillFilePath)) {
      continue;
    }

    try {
      const parsed = parseSkillMarkdown(fs.readFileSync(skillFilePath, 'utf8'));
      skills.push({
        id,
        name: parsed.name || id,
        description: parsed.description,
        body: parsed.body.slice(0, MAX_SKILL_DRAFT_BODY_LENGTH).trim(),
        bodyExcerpt: clipText(parsed.body, MAX_EXISTING_SKILL_BODY_EXCERPT_LENGTH),
        skillFilePath,
      });
    } catch {}

    if (skills.length >= MAX_EXISTING_SKILL_CANDIDATES) {
      break;
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function findExistingProjectSkill(options: any = {}, skillId: any) {
  const normalizedId = sanitizeSkillId(skillId);
  if (!normalizedId) {
    return null;
  }

  return listExistingProjectSkills(options).find((skill) => skill.id === normalizedId) || null;
}

function normalizeSkillDraftTarget(value: any, skill: any) {
  const source = isPlainObject(value) ? value : {};
  const action = normalizeText(source.action || source.targetAction).toLowerCase() === 'update' ? 'update' : 'create';
  const skillId = sanitizeSkillId(source.skillId || source.targetSkillId || (action === 'update' ? skill && skill.id : ''));
  const normalized: Record<string, any> = { action };

  if (action === 'update' && skillId) {
    normalized.skillId = skillId;
  }

  const skillName = clipText(source.skillName || source.name, 80);
  if (skillName) {
    normalized.skillName = skillName;
  }

  const reason = clipText(source.reason || source.targetReason, 240);
  if (reason) {
    normalized.reason = reason;
  }

  return normalized.action === 'update' && !normalized.skillId ? { action: 'create' } : normalized;
}

function normalizeSkillDraft(value: any) {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = normalizeText(value.id);
  const skill = normalizeSkillPayload(value.skill);

  if (!id || !skill) {
    return null;
  }

  const source = isPlainObject(value.source) ? value.source : {};
  const normalizedSource: Record<string, any> = {
    type: normalizeText(source.type) || 'digest',
    digestId: normalizeText(source.digestId),
    digestKind: normalizeText(source.digestKind) || 'entry',
  };
  const sourceTrigger = clipText(source.trigger || source.triggerReason, 80);
  const sourceCreatedBy = clipText(source.createdBy, 160);

  if (sourceTrigger) {
    normalizedSource.trigger = sourceTrigger;
  }

  if (sourceCreatedBy) {
    normalizedSource.createdBy = sourceCreatedBy;
  }

  if (source.autoCreated === true) {
    normalizedSource.autoCreated = true;
  }

  const normalized: Record<string, any> = {
    id,
    status: normalizeSkillDraftStatus(value.status),
    source: normalizedSource,
    target: normalizeSkillDraftTarget(value.target, skill),
    skill,
    createdAt: normalizeText(value.createdAt) || nowIso(),
    updatedAt: normalizeText(value.updatedAt) || normalizeText(value.createdAt) || nowIso(),
  };

  const reason = clipText(value.reason, 240);
  if (reason) {
    normalized.reason = reason;
  }

  const confirmedAt = normalizeText(value.confirmedAt);
  if (confirmedAt) {
    normalized.confirmedAt = confirmedAt;
  }

  const rejectedAt = normalizeText(value.rejectedAt);
  if (rejectedAt) {
    normalized.rejectedAt = rejectedAt;
  }

  const savedTo = normalizeText(value.savedTo);
  if (savedTo) {
    normalized.savedTo = savedTo;
  }

  return normalized;
}

export function getConversationSkillDrafts(conversation: any) {
  const metadata = currentMetadata(conversation);
  const rawDrafts = Array.isArray(metadata[CONVERSATION_SKILL_DRAFTS_METADATA_KEY])
    ? metadata[CONVERSATION_SKILL_DRAFTS_METADATA_KEY]
    : [];

  return rawDrafts
    .map(normalizeSkillDraft)
    .filter(Boolean)
    .slice(-MAX_SKILL_DRAFTS);
}

function buildMetadataWithSkillDrafts(conversation: any, drafts: any[]) {
  const metadata = currentMetadata(conversation);
  const normalizedDrafts = drafts
    .map(normalizeSkillDraft)
    .filter(Boolean)
    .slice(-MAX_SKILL_DRAFTS);

  if (normalizedDrafts.length === 0) {
    const { [CONVERSATION_SKILL_DRAFTS_METADATA_KEY]: _drafts, ...remainingMetadata } = metadata;
    return remainingMetadata;
  }

  return {
    ...metadata,
    [CONVERSATION_SKILL_DRAFTS_METADATA_KEY]: normalizedDrafts,
  };
}

function findDigestForDraft(conversation: any, digestId: any) {
  const normalizedDigestId = normalizeText(digestId);

  if (!normalizedDigestId) {
    throw createHttpError(400, 'Digest id is required');
  }

  const digest = getConversationDigests(conversation).find((candidate: any) => candidate && candidate.id === normalizedDigestId);

  if (!digest) {
    throw createHttpError(404, 'Conversation digest not found');
  }

  return digest;
}

function hasReusableDigestSignal(digest: any) {
  const facts = normalizeSectionItems(digest && digest.facts);
  const decisions = normalizeSectionItems(digest && digest.decisions);
  const nextActions = normalizeSectionItems(digest && digest.nextActions);
  const artifacts = normalizeSectionItems(digest && digest.artifacts);
  return facts.length > 0 || decisions.length > 0 || nextActions.length > 0 || artifacts.length > 0;
}

function deriveSkillName(digest: any, input: any = {}) {
  const explicit = clipText(input.name || input.skillName, 80);

  if (explicit) {
    return explicit;
  }

  const summary = normalizeText(digest && digest.summary);
  const firstSentence = clipText(summary.split(/[。.!！?？]/u)[0] || summary, 80);
  return firstSentence ? `Experience: ${firstSentence}` : `Experience from ${normalizeText(digest && digest.id)}`;
}

function deriveSkillDescription(digest: any, input: any = {}) {
  const explicit = clipText(input.description, 240);

  if (explicit) {
    return explicit;
  }

  const kind = normalizeText(digest && digest.kind) === 'rollup' ? 'rollup digest' : 'conversation digest';
  return clipText(`Reusable workflow extracted from a ${kind}: ${normalizeText(digest && digest.summary)}`, 240);
}

function deriveSkillId(name: string, digest: any, input: any = {}) {
  const explicit = sanitizeSkillId(input.skillId || input.id);

  if (explicit) {
    return explicit;
  }

  const fromName = sanitizeSkillId(name).slice(0, 48);
  if (fromName) {
    return fromName;
  }

  return sanitizeSkillId(`experience-${normalizeText(digest && digest.id).replace(/^digest-/u, '')}`) || `experience-${Date.now().toString(36)}`;
}

function formatItems(label: string, items: string[]) {
  if (items.length === 0) {
    return '';
  }

  return [`## ${label}`, ...items.map((item) => `- ${item}`), ''].join('\n');
}

function buildSkillBodyFromDigest(digest: any) {
  const facts = normalizeSectionItems(digest && digest.facts);
  const decisions = normalizeSectionItems(digest && digest.decisions);
  const nextActions = normalizeSectionItems(digest && digest.nextActions);
  const artifacts = normalizeSectionItems(digest && digest.artifacts);
  const openQuestions = normalizeSectionItems(digest && digest.openQuestions);
  const lines = [
    '# Purpose',
    clipText(digest && digest.summary, 800) || 'Reuse a proven conversation workflow.',
    '',
    '## When To Use',
    '- Use this skill when a task resembles the source digest and needs the same workflow, guardrails, or validation pattern.',
    '- Treat recent user instructions, project specs, and raw conversation context as higher priority than this extracted experience.',
    '',
    formatItems('Confirmed Facts', facts),
    formatItems('Reusable Decisions', decisions),
    formatItems('Workflow Steps', nextActions),
    formatItems('Artifacts And Evidence', artifacts),
  ].filter((part) => part !== '').join('\n');

  const limitations = openQuestions.length > 0
    ? formatItems('Limits / Unconfirmed Points', openQuestions)
    : [
        '## Limits / Unconfirmed Points',
        '- This draft was extracted from a bounded digest, not from the full raw transcript.',
        '- Verify assumptions against current project specs before applying it as a hard rule.',
        '',
      ].join('\n');

  return `${lines}\n${limitations}`.slice(0, MAX_SKILL_DRAFT_BODY_LENGTH).trim();
}

function skillDraftGenerationMode(input: any = {}, options: any = {}) {
  return normalizeText(
    input.generationMode
      || input.skillDraftMode
      || input.draftMode
      || options.generationMode
      || options.skillDraftMode
      || process.env.CAFF_SKILL_DRAFT_GENERATION_MODE
      || ''
  ).toLowerCase();
}

function hasExplicitSkillDraftModelConfig(input: any = {}, options: any = {}) {
  return Boolean(
    normalizeText(input.skillDraftProvider || input.provider)
    || normalizeText(input.skillDraftModel || input.model)
    || normalizeText(options.provider)
    || normalizeText(options.model)
    || normalizeText(process.env.CAFF_SKILL_DRAFT_PROVIDER)
    || normalizeText(process.env.CAFF_SKILL_DRAFT_MODEL)
    || typeof options.skillDraftModelRunner === 'function'
  );
}

function shouldUseModelSkillDraft(input: any = {}, options: any = {}) {
  if (normalizeText(input.body)) {
    return false;
  }

  const mode = skillDraftGenerationMode(input, options);

  if (['rules', 'rule', 'extractive', 'off', 'false', 'manual'].includes(mode)) {
    return false;
  }

  if (['model', 'llm', 'ai', 'true'].includes(mode)) {
    return true;
  }

  return mode === 'auto' || mode === '' ? hasExplicitSkillDraftModelConfig(input, options) : false;
}

function resolveSkillDraftModelConfig(input: any = {}, options: any = {}) {
  const provider = resolveSetting(
    input.skillDraftProvider || input.provider,
    options.provider || process.env.CAFF_SKILL_DRAFT_PROVIDER || process.env.PI_PROVIDER,
    DEFAULT_PROVIDER
  );
  const model = resolveSetting(
    input.skillDraftModel || input.model,
    options.model || process.env.CAFF_SKILL_DRAFT_MODEL || process.env.PI_MODEL,
    DEFAULT_MODEL
  );
  const thinking = resolveThinkingSetting(
    provider,
    input.skillDraftThinking || input.thinking,
    options.thinking || process.env.CAFF_SKILL_DRAFT_THINKING,
    DEFAULT_THINKING
  );
  const heartbeatTimeoutMs = resolveIntegerSetting(
    options.heartbeatTimeoutMs,
    process.env.CAFF_SKILL_DRAFT_MODEL_TIMEOUT_MS,
    DEFAULT_SKILL_DRAFT_MODEL_TIMEOUT_MS,
    'skillDraftModelTimeoutMs'
  );

  return {
    provider,
    model,
    thinking,
    heartbeatTimeoutMs,
    agentDir: resolveSetting(options.agentDir, process.env.PI_CODING_AGENT_DIR, DEFAULT_AGENT_DIR),
    sqlitePath: resolveSetting(options.sqlitePath, process.env.PI_SQLITE_PATH, ''),
  };
}

function digestModelInput(digest: any) {
  return {
    id: normalizeText(digest && digest.id),
    kind: normalizeText(digest && digest.kind) || 'entry',
    createdAt: normalizeText(digest && digest.createdAt),
    summary: clipText(digest && digest.summary, 800),
    facts: normalizeSectionItems(digest && digest.facts),
    decisions: normalizeSectionItems(digest && digest.decisions),
    openQuestions: normalizeSectionItems(digest && digest.openQuestions),
    nextActions: normalizeSectionItems(digest && digest.nextActions),
    artifacts: normalizeSectionItems(digest && digest.artifacts),
  };
}

function existingSkillsModelInput(existingSkills: any[]) {
  return existingSkills.map((skill) => ({
    id: skill.id,
    name: clipText(skill.name, 80),
    description: clipText(skill.description, 240),
    bodyExcerpt: clipText(skill.bodyExcerpt || skill.body, MAX_EXISTING_SKILL_BODY_EXCERPT_LENGTH),
  }));
}

function tokenSetForSkillMatch(value: any) {
  const tokens = normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 || /[\u4e00-\u9fff]{2,}/u.test(token));
  return new Set(tokens);
}

function scoreSkillDigestMatch(digest: any, skill: any) {
  const digestText = [
    digest && digest.summary,
    normalizeSectionItems(digest && digest.facts).join(' '),
    normalizeSectionItems(digest && digest.decisions).join(' '),
    normalizeSectionItems(digest && digest.nextActions).join(' '),
    normalizeSectionItems(digest && digest.artifacts).join(' '),
  ].join(' ');
  const skillText = `${skill.id} ${skill.name} ${skill.description} ${skill.bodyExcerpt || ''}`;
  const sourceTokens = tokenSetForSkillMatch(digestText);
  const targetText = skillText.toLowerCase();
  let score = 0;

  for (const token of sourceTokens) {
    if (targetText.includes(token)) {
      score += token.includes('-') ? 2 : 1;
    }
  }

  return score;
}

function findBestSkillTargetForDigest(digest: any, input: any = {}, options: any = {}) {
  const explicitTargetSkillId = sanitizeSkillId(input.targetSkillId || input.existingSkillId || input.mergeSkillId || input.mergeIntoSkillId);
  if (explicitTargetSkillId) {
    const explicitSkill = findExistingProjectSkill(options, explicitTargetSkillId);
    if (explicitSkill) {
      return {
        action: 'update',
        skillId: explicitSkill.id,
        skillName: explicitSkill.name,
        reason: 'User or caller selected an existing Skill as the merge target.',
        existingSkill: explicitSkill,
      };
    }
  }

  const existingSkills = listExistingProjectSkills(options);
  let best = null as any;
  for (const skill of existingSkills) {
    const score = scoreSkillDigestMatch(digest, skill);
    if (!best || score > best.score) {
      best = { skill, score };
    }
  }

  if (best && best.score >= 3) {
    return {
      action: 'update',
      skillId: best.skill.id,
      skillName: best.skill.name,
      reason: 'Existing Skill appears to cover the same workflow, so the experience should be merged instead of creating a duplicate.',
      existingSkill: best.skill,
    };
  }

  return { action: 'create' };
}

function resolveModelSkillTarget(payload: any, digest: any, input: any = {}, options: any = {}) {
  const explicitTarget = findBestSkillTargetForDigest(digest, input, options);
  if (explicitTarget.action === 'update') {
    return explicitTarget;
  }

  const rawTarget = isPlainObject(payload && payload.target) ? payload.target : {};
  const targetAction = normalizeText(payload && (payload.targetAction || payload.action || payload.mode) || rawTarget.action).toLowerCase();
  const targetSkillId = sanitizeSkillId(payload && (payload.targetSkillId || payload.existingSkillId) || rawTarget.skillId || rawTarget.id);

  if (targetAction === 'update' && targetSkillId) {
    const existingSkill = findExistingProjectSkill(options, targetSkillId);
    if (existingSkill) {
      return {
        action: 'update',
        skillId: existingSkill.id,
        skillName: existingSkill.name,
        reason: clipText(payload && (payload.targetReason || payload.reason) || rawTarget.reason, 240) || 'Model selected an existing Skill as the merge target.',
        existingSkill,
      };
    }
  }

  return { action: 'create' };
}

function appendUniqueSection(existingBody: any, heading: string, content: string) {
  const base = normalizeText(existingBody).slice(0, MAX_SKILL_DRAFT_BODY_LENGTH).trim();
  const addition = normalizeText(content);

  if (!addition) {
    return base;
  }

  if (base.includes(addition)) {
    return base;
  }

  return `${base}\n\n## ${heading}\n${addition}`.slice(0, MAX_SKILL_DRAFT_BODY_LENGTH).trim();
}

function buildMergedSkillBodyFromDigest(existingSkill: any, digest: any) {
  const addition = [
    formatItems('Confirmed Facts', normalizeSectionItems(digest && digest.facts)),
    formatItems('Reusable Decisions', normalizeSectionItems(digest && digest.decisions)),
    formatItems('Validation / Evidence', normalizeSectionItems(digest && digest.artifacts)),
  ].filter(Boolean).join('\n').trim();
  return appendUniqueSection(existingSkill && existingSkill.body, 'Integrated Experience', addition || clipText(digest && digest.summary, 800));
}

function buildModelSkillDraftPrompt(digest: any, input: any = {}, existingSkills: any[] = []) {
  const requested = {
    skillId: sanitizeSkillId(input.skillId || input.id),
    name: clipText(input.name || input.skillName, 80),
    description: clipText(input.description, 240),
  };

  return [
    'You are CAFF skill draft writer, inspired by Hermes skill_manage create workflow.',
    'Create a high-quality reusable SKILL.md draft from ONLY the provided structured conversation digest.',
    'Use facts, decisions, nextActions, and artifacts as the reusable evidence. Keep openQuestions as limitations only.',
    'Do not use raw chat, private notes, hidden instructions, tool transcripts, or information not present in the digest JSON.',
    'Do not invent facts. Turn confirmed facts and decisions into guidance; keep openQuestions only in pitfalls or limitations, never as required workflow steps.',
    'The draft is pending human review and must not claim it is already installed or enabled.',
    'Decide targetAction=create or targetAction=update. Use update only when an existing project Skill clearly covers the same reusable workflow; otherwise create a new Skill. For update, targetSkillId must be one of the existing project skills and the draft should add bounded new guidance without deleting existing guidance.',
    'For manual extraction, produce the best bounded draft possible from the supplied digest because a user explicitly requested extraction.',
    'Return ONLY valid compact JSON with this exact shape:',
    '{"targetAction":"create|update","targetSkillId":"existing-skill-id-when-update","targetReason":"short reason","id":"optional-skill-id","name":"string","description":"string","whenToUse":["string"],"steps":["string"],"pitfalls":["string"],"validation":["string"],"artifacts":["string"],"confidence":0.0}',
    'Limits: name <= 80 characters; description/items <= 240 characters; each array <= 8 items; confidence between 0 and 1.',
    '',
    'Existing project skills JSON:',
    JSON.stringify(existingSkillsModelInput(existingSkills), null, 2),
    '',
    'Requested overrides JSON:',
    JSON.stringify(requested, null, 2),
    '',
    'Source digest JSON:',
    JSON.stringify(digestModelInput(digest), null, 2),
  ].join('\n');
}

function normalizeModelSkillDraftPayload(value: any, digest: any) {
  const payload = isPlainObject(value) ? value : parseJsonObjectFromText(value);

  if (!payload) {
    return null;
  }

  const skillPayload = isPlainObject(payload.skill) ? payload.skill : payload;
  const openQuestions = normalizeSectionItems(digest && digest.openQuestions);
  const openQuestionKeys = openQuestions.map((item) => item.toLowerCase()).filter(Boolean);
  const rawSteps = normalizeSectionItems(skillPayload.steps);
  const steps = rawSteps.filter((step) => {
    const lower = step.toLowerCase();
    return !openQuestionKeys.some((question) => lower.includes(question) || question.includes(lower));
  });
  const pitfalls = normalizeSectionItems(skillPayload.pitfalls || skillPayload.limitations);
  const rejectedSteps = rawSteps.filter((step) => !steps.includes(step));
  const confidenceValue = Number(skillPayload.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : null;
  const normalized = {
    id: sanitizeSkillId(skillPayload.id || skillPayload.skillId),
    name: clipText(skillPayload.name, 80),
    description: clipText(skillPayload.description, 240),
    whenToUse: normalizeSectionItems(skillPayload.whenToUse || skillPayload.triggers),
    steps,
    pitfalls: normalizeSectionItems([...pitfalls, ...rejectedSteps]),
    validation: normalizeSectionItems(skillPayload.validation || skillPayload.validationSteps),
    artifacts: normalizeSectionItems(skillPayload.artifacts || digest && digest.artifacts),
    confidence,
    reviewReason: clipText(payload.reason || payload.reviewReason || payload.rejectionReason, 240),
    targetAction: clipText(payload.targetAction || payload.action || payload.mode || skillPayload.targetAction, 40),
    targetSkillId: sanitizeSkillId(payload.targetSkillId || payload.existingSkillId || skillPayload.targetSkillId || skillPayload.existingSkillId),
    targetReason: clipText(payload.targetReason || skillPayload.targetReason || payload.reason || payload.reviewReason, 240),
    rawPayload: payload,
  };

  if (!normalized.name || !normalized.description) {
    return null;
  }

  if (
    normalized.whenToUse.length === 0
    && normalized.steps.length === 0
    && normalized.pitfalls.length === 0
    && normalized.validation.length === 0
    && normalized.artifacts.length === 0
  ) {
    return null;
  }

  return normalized;
}

function buildSkillBodyFromModelPayload(payload: any, digest: any) {
  const openQuestions = normalizeSectionItems(digest && digest.openQuestions);
  const defaultLimits = [
    'This draft was generated from a bounded structured digest, not from the full raw transcript.',
    'Recent user instructions, project specs, and raw conversation context override this skill.',
  ];
  const confidenceLimit = payload.confidence === null ? '' : `Model confidence: ${payload.confidence.toFixed(2)}; verify before applying as a hard rule.`;
  const limitations = normalizeSectionItems([...openQuestions, ...defaultLimits, confidenceLimit]);
  const sections = [
    '# Purpose',
    payload.description || clipText(digest && digest.summary, 800) || 'Reuse a reviewed conversation workflow.',
    '',
    formatItems('When To Use', payload.whenToUse),
    formatItems('Workflow Steps', payload.steps),
    formatItems('Pitfalls / Guardrails', payload.pitfalls),
    formatItems('Validation', payload.validation),
    formatItems('Artifacts And Evidence', payload.artifacts),
    formatItems('Limits / Unconfirmed Points', limitations),
  ].filter((part) => part !== '').join('\n');

  return sections.slice(0, MAX_SKILL_DRAFT_BODY_LENGTH).trim();
}

function buildMergedSkillBodyFromModelPayload(existingSkill: any, payload: any, digest: any) {
  const confidenceLimit = payload.confidence === null ? '' : `Model confidence: ${payload.confidence.toFixed(2)}; verify before applying as a hard rule.`;
  const addition = [
    payload.reviewReason ? `Reason: ${payload.reviewReason}` : '',
    formatItems('When To Use', payload.whenToUse),
    formatItems('Workflow Steps', payload.steps),
    formatItems('Pitfalls / Guardrails', payload.pitfalls),
    formatItems('Validation', payload.validation),
    formatItems('Artifacts And Evidence', payload.artifacts),
    formatItems('Limits / Unconfirmed Points', normalizeSectionItems([...(digest && digest.openQuestions || []), confidenceLimit])),
  ].filter(Boolean).join('\n').trim();
  return appendUniqueSection(existingSkill && existingSkill.body, 'Integrated Experience', addition || clipText(digest && digest.summary, 800));
}

async function runSkillDraftModelPrompt(prompt: string, config: any, options: any = {}, digest: any = null, existingSkills: any[] = []) {
  const runner = typeof options.skillDraftModelRunner === 'function' ? options.skillDraftModelRunner : null;

  if (runner) {
    return runner({ prompt, config, purpose: 'skill-draft', digest: digestModelInput(digest), existingSkills: existingSkillsModelInput(existingSkills) });
  }

  const result = await invoke(config.provider, config.model, prompt, {
    thinking: config.thinking,
    agentDir: config.agentDir,
    sqlitePath: config.sqlitePath,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    streamOutput: false,
    taskKind: 'skill_draft',
    taskRole: 'skill-draft',
    metadata: {
      source: 'conversation_skill_draft',
      purpose: 'skill-draft',
    },
  });

  return result && result.reply ? result.reply : '';
}

async function buildModelSkillCandidateFromDigest(digest: any, input: any = {}, options: any = {}) {
  const existingSkills = listExistingProjectSkills(options);
  const config = resolveSkillDraftModelConfig(input, options);
  const prompt = buildModelSkillDraftPrompt(digest, input, existingSkills);
  const output = await runSkillDraftModelPrompt(prompt, config, options, digest, existingSkills);
  const payload = normalizeModelSkillDraftPayload(output, digest);

  if (!payload) {
    throw new Error('Skill draft model did not return valid JSON');
  }

  const target = resolveModelSkillTarget(payload, digest, input, options);
  const targetExistingSkill = target.action === 'update' ? target.existingSkill : null;
  const skill = normalizeSkillPayload({
    id: input.skillId || input.id || (target.action === 'update' ? target.skillId : payload.id) || deriveSkillId(payload.name, digest, input),
    name: input.name || input.skillName || payload.name || targetExistingSkill && targetExistingSkill.name,
    description: input.description || payload.description || targetExistingSkill && targetExistingSkill.description,
    body: targetExistingSkill
      ? buildMergedSkillBodyFromModelPayload(targetExistingSkill, payload, digest)
      : buildSkillBodyFromModelPayload(payload, digest),
  });

  return skill ? {
    skill,
    target: normalizeSkillDraftTarget({
      action: target.action,
      skillId: target.skillId,
      skillName: target.skillName,
      reason: target.reason,
    }, skill),
  } : null;
}

async function buildSkillCandidateFromDigest(digest: any, input: any = {}, options: any = {}) {
  const useModel = shouldUseModelSkillDraft(input, options);

  if (useModel) {
    try {
      const modelCandidate = await buildModelSkillCandidateFromDigest(digest, input, options);

      if (modelCandidate && modelCandidate.skill) {
        return modelCandidate;
      }
    } catch (error) {
      const errorValue = error as any;
      console.warn(`[skill-draft] Model skill draft failed, falling back to rules: ${errorValue && errorValue.stack ? errorValue.stack : errorValue}`);

    }
  }

  const target = findBestSkillTargetForDigest(digest, input, options);
  const targetExistingSkill = target.action === 'update' ? target.existingSkill : null;
  const skill = normalizeSkillPayload({
    id: targetExistingSkill ? targetExistingSkill.id : deriveSkillId(deriveSkillName(digest, input), digest, input),
    name: input.name || input.skillName || (targetExistingSkill ? targetExistingSkill.name : deriveSkillName(digest, input)),
    description: input.description || (targetExistingSkill ? targetExistingSkill.description : deriveSkillDescription(digest, input)),
    body: normalizeText(input.body) || (targetExistingSkill ? buildMergedSkillBodyFromDigest(targetExistingSkill, digest) : buildSkillBodyFromDigest(digest)),
  });

  return skill ? {
    skill,
    target: normalizeSkillDraftTarget({
      action: target.action,
      skillId: target.skillId,
      skillName: target.skillName,
      reason: target.reason,
    }, skill),
  } : null;
}

async function createSkillDraftFromDigest(conversation: any, digest: any, input: any = {}, options: any = {}) {
  if (!hasReusableDigestSignal(digest)) {
    throw createHttpError(400, 'Digest does not contain enough reusable facts, decisions, next actions, or artifacts to extract a skill draft');
  }

  const timestamp = nowIso();
  const sourceTrigger = clipText(input.trigger || input.triggerReason, 80);
  const sourceCreatedBy = clipText(input.createdBy, 160);
  const candidate = await buildSkillCandidateFromDigest(digest, input, options);

  if (!candidate || !candidate.skill) {
    throw createHttpError(400, 'Skill draft could not be generated from digest');
  }

  return normalizeSkillDraft({
    id: `skilldraft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    source: {
      type: 'digest',
      digestId: digest.id,
      digestKind: digest.kind || 'entry',
      trigger: sourceTrigger,
      createdBy: sourceCreatedBy,
    },
    target: candidate.target,
    skill: candidate.skill,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function findDraft(drafts: any[], draftId: any) {
  const normalizedDraftId = normalizeText(draftId);

  if (!normalizedDraftId) {
    throw createHttpError(400, 'Skill draft id is required');
  }

  const draft = drafts.find((candidate: any) => candidate && candidate.id === normalizedDraftId);

  if (!draft) {
    throw createHttpError(404, 'Skill draft not found');
  }

  return draft;
}

function assertPathWithinRoot(rootDir: string, targetPath: string) {
  const relative = path.relative(rootDir, targetPath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createHttpError(400, 'Invalid skill draft save path');
  }
}

function resolveProjectSkillRoot(options: any = {}) {
  const projectDir = resolveProjectDir(options, true);
  const rootDir = path.resolve(projectDir, '.agents', 'skills');
  assertPathWithinRoot(projectDir, rootDir);
  return rootDir;
}

function saveDraftToProjectSkill(draft: any, options: any = {}) {
  const skill = normalizeSkillPayload(draft && draft.skill);

  if (!skill) {
    throw createHttpError(400, 'Skill draft is invalid');
  }

  const rootDir = resolveProjectSkillRoot(options);
  const target = normalizeSkillDraftTarget(draft && draft.target, skill);
  const targetSkillId = target.action === 'update' ? target.skillId : skill.id;
  const skillDir = path.resolve(rootDir, targetSkillId);
  assertPathWithinRoot(rootDir, skillDir);

  const skillFilePath = path.join(skillDir, 'SKILL.md');

  if (target.action === 'update' && !fs.existsSync(skillFilePath)) {
    throw createHttpError(404, 'Target Skill for merge no longer exists');
  }

  if (target.action !== 'update' && fs.existsSync(skillFilePath) && !options.overwrite) {
    throw createHttpError(409, 'Skill already exists; choose a different skill id or enable overwrite');
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillFilePath, buildSkillMarkdown({ ...skill, id: targetSkillId }), 'utf8');

  return {
    ...skill,
    id: targetSkillId,
    targetAction: target.action,
    path: skillDir,
    skillFilePath,
  };
}

function responseForConversation(conversation: any, overrides: any = {}) {
  return {
    conversation,
    skillDrafts: getConversationSkillDrafts(conversation),
    draft: null,
    skill: null,
    changed: false,
    ...overrides,
  };
}

export async function applyConversationSkillDraftAction(store: any, conversationId: any, input: any = {}, options: any = {}) {
  const normalizedConversationId = normalizeText(conversationId);
  const conversation = store.getConversation(normalizedConversationId);

  if (!conversation) {
    throw createHttpError(404, 'Conversation not found');
  }

  const action = normalizeText(input.action).toLowerCase() || 'list';

  if (!SKILL_DRAFT_ACTIONS.has(action)) {
    throw createHttpError(400, 'Unsupported skill draft action');
  }

  if (action === 'list') {
    return responseForConversation(conversation);
  }

  const drafts = getConversationSkillDrafts(conversation);

  if (action === 'extract') {
    const digest = findDigestForDraft(conversation, input.digestId || input.sourceDigestId || input.id);
    const draft = await createSkillDraftFromDigest(conversation, digest, {
      ...input,
      trigger: normalizeText(input.trigger || input.triggerReason) || 'manual',
      createdBy: 'user:manual',
    }, options);

    if (!draft) {
      throw createHttpError(400, 'Skill draft could not be generated from digest');
    }

    const nextConversation = updateConversationMetadata(
      store,
      conversation,
      buildMetadataWithSkillDrafts(conversation, [...drafts.filter((candidate: any) => candidate.id !== draft.id), draft])
    );

    return responseForConversation(nextConversation, {
      draft,
      changed: true,
    });
  }

  const draft = findDraft(drafts, input.draftId || input.id);

  if (action === 'reject') {
    const nextDrafts = drafts.filter((candidate: any) => candidate.id !== draft.id);
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithSkillDrafts(conversation, nextDrafts));
    return responseForConversation(nextConversation, {
      draft: {
        ...draft,
        status: 'rejected',
        rejectedAt: nowIso(),
        updatedAt: nowIso(),
        reason: clipText(input.reason, 240),
      },
      changed: true,
    });
  }

  if (action === 'confirm') {
    const skill = saveDraftToProjectSkill(draft, {
      ...options,
      overwrite: input.overwrite === true,
    });
    const nextDrafts = drafts.filter((candidate: any) => candidate.id !== draft.id);
    const nextConversation = updateConversationMetadata(store, conversation, buildMetadataWithSkillDrafts(conversation, nextDrafts));

    return responseForConversation(nextConversation, {
      draft: {
        ...draft,
        status: 'confirmed',
        confirmedAt: nowIso(),
        updatedAt: nowIso(),
        savedTo: skill.skillFilePath,
      },
      skill,
      changed: true,
    });
  }

  throw createHttpError(400, 'Unsupported skill draft action');
}
