import { randomUUID } from 'node:crypto';

import { buildValidationIssue, createValidationHttpError } from './case-schema';

const VALID_TESTING_DOC_SOURCE_KINDS = new Set(['skill_md', 'stable_spec', 'user_supplied', 'missing']);
const VALID_TESTING_DOC_DRAFT_STATUSES = new Set(['proposed', 'needs_user_input', 'confirmed', 'applied', 'rejected', 'superseded']);
const VALID_TESTING_DOC_REQUIREMENT_KINDS = new Set(['command', 'package', 'env', 'capability', 'service']);
const TESTING_DOC_SECTION_ORDER = ['prerequisites', 'setup', 'verification', 'teardown', 'open_questions'];
const TESTING_DOC_SECTION_HEADINGS: Record<string, string> = {
  prerequisites: 'Prerequisites',
  setup: 'Setup',
  verification: 'Verification',
  teardown: 'Teardown',
  open_questions: 'Open Questions',
};

export const DEFAULT_TESTING_DOC_TEXT_MAX_LENGTH = 2400;

function normalizeText(value: any) {
  return String(value || '').trim();
}

function normalizeMultilineText(value: any) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeStringArray(value: any) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized = [] as string[];

  for (const entry of value) {
    const text = normalizeText(entry);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function normalizeClipLength(value: any) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TESTING_DOC_TEXT_MAX_LENGTH;
  }
  return Math.max(240, Math.floor(parsed));
}

function clipTestingDocText(value: any, maxLength: any = DEFAULT_TESTING_DOC_TEXT_MAX_LENGTH) {
  const limit = normalizeClipLength(maxLength);
  const text = normalizeMultilineText(value);
  return text.length > limit ? `${text.slice(0, limit).trim()}\n...[truncated]` : text;
}

function normalizeTestingDocHeadingKey(value: any) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[：:]+$/u, '')
    .replace(/[\s-]+/g, '_');

  if (!normalized) {
    return '';
  }
  if (['prerequisite', 'prerequisites', 'requirement', 'requirements', 'dependencies', 'dependency'].includes(normalized)) {
    return 'prerequisites';
  }
  if (['setup', 'bootstrap', 'bootstrapping', 'initialization', 'init', 'install', 'installation'].includes(normalized)) {
    return 'setup';
  }
  if (['verify', 'verification', 'validate', 'validation', 'check', 'checks'].includes(normalized)) {
    return 'verification';
  }
  if (['teardown', 'cleanup', 'clean_up', 'reset'].includes(normalized)) {
    return 'teardown';
  }
  if (['open_questions', 'open_question', 'questions', 'unknowns', 'known_limits', 'known_limit'].includes(normalized)) {
    return 'open_questions';
  }
  return '';
}

function normalizeTestingDocSourceKind(value: any) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return 'missing';
  }
  return VALID_TESTING_DOC_SOURCE_KINDS.has(normalized) ? normalized : null;
}

function normalizeTestingDocDraftStatus(value: any) {
  const normalized = normalizeText(value).toLowerCase() || 'proposed';
  return VALID_TESTING_DOC_DRAFT_STATUSES.has(normalized) ? normalized : 'proposed';
}

function createTestingDocDraftValidationError(code: string, path: string, message: string) {
  return createValidationHttpError(buildValidationIssue(code, 'error', path, message));
}

function defaultTestingDocSectionContent(key: string) {
  if (key === 'prerequisites') {
    return '- No prerequisites confirmed yet.';
  }
  if (key === 'setup') {
    return '- No setup or bootstrap steps confirmed yet.';
  }
  if (key === 'verification') {
    return '- No verification steps confirmed yet.';
  }
  if (key === 'teardown') {
    return '- No teardown steps confirmed yet.';
  }
  if (key === 'open_questions') {
    return '- Which packages, credentials, services, sandbox permissions, and cleanup steps are required?';
  }
  return '- No confirmed content yet.';
}

function normalizeTestingDocSection(input: any, fallbackKey: string, options: any = {}) {
  const key = normalizeTestingDocHeadingKey(input && input.heading) || fallbackKey;
  const heading = TESTING_DOC_SECTION_HEADINGS[key] || normalizeText(input && input.heading) || TESTING_DOC_SECTION_HEADINGS[fallbackKey] || 'Section';
  const rawSourceKind = input && input.sourceKind;
  const sourceKind = normalizeTestingDocSourceKind(rawSourceKind) || 'missing';

  const rawContent = Array.isArray(input && input.content)
    ? input.content.map((entry: any) => normalizeMultilineText(entry)).filter(Boolean).join('\n')
    : normalizeMultilineText(input && input.content);
  const openQuestions = normalizeStringArray(input && input.openQuestions);
  if (rawSourceKind != null && String(rawSourceKind || '').trim() && sourceKind === 'missing') {
    openQuestions.unshift(`sourceKind ${String(rawSourceKind || '').trim()} 不合法，已按 missing 处理。`);
  }
  const content = clipTestingDocText(rawContent || defaultTestingDocSectionContent(key), options.maxSectionTextLength);

  return {
    key,
    heading,
    content,
    sourceKind,
    sourceRefs: normalizeStringArray(input && input.sourceRefs),
    openQuestions,
  };
}

function buildDefaultTestingDocSections(options: any = {}) {
  return TESTING_DOC_SECTION_ORDER.map((key) => normalizeTestingDocSection({
    heading: TESTING_DOC_SECTION_HEADINGS[key],
    content: defaultTestingDocSectionContent(key),
    sourceKind: 'missing',
    sourceRefs: [],
    openQuestions: key === 'open_questions'
      ? ['补齐环境依赖、初始化、验证和清理信息后再写入稳定契约。']
      : [],
  }, key, options));
}

function extractTestingDocSectionsFromMarkdown(markdown: any, sourceKind: string, sourcePath = 'SKILL.md', options: any = {}) {
  const sections = new Map<string, any>();
  let currentKey = '';
  let currentHeading = '';
  let currentLines: string[] = [];

  function flush() {
    if (!currentKey) {
      currentLines = [];
      return;
    }
    const content = clipTestingDocText(currentLines.join('\n'), options.maxSectionTextLength);
    if (content && !sections.has(currentKey)) {
      sections.set(currentKey, {
        heading: TESTING_DOC_SECTION_HEADINGS[currentKey] || currentHeading,
        content,
        sourceKind,
        sourceRefs: [`${sourcePath}#${currentHeading || TESTING_DOC_SECTION_HEADINGS[currentKey]}`],
        openQuestions: [],
      });
    }
    currentLines = [];
  }

  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^#{1,6}\s+(.*)$/);
    if (headingMatch) {
      flush();
      currentHeading = normalizeText(headingMatch[1]);
      currentKey = normalizeTestingDocHeadingKey(currentHeading);
      continue;
    }

    if (!currentKey) {
      continue;
    }

    const line = String(rawLine || '').trimEnd();
    if (!line.trim()) {
      if (currentLines.length > 0) {
        currentLines.push('');
      }
      continue;
    }
    currentLines.push(line);
  }
  flush();

  return Array.from(sections.values());
}

function mergeTestingDocSections(primarySections: any[], fallbackSections: any[] = [], options: any = {}) {
  const map = new Map<string, any>();
  for (const section of buildDefaultTestingDocSections(options)) {
    map.set(section.key, section);
  }
  for (const section of fallbackSections) {
    const key = normalizeTestingDocHeadingKey(section && section.heading);
    if (key && !map.has(key)) {
      map.set(key, normalizeTestingDocSection(section, key, options));
    } else if (key) {
      const normalized = normalizeTestingDocSection(section, key, options);
      if (normalized.sourceKind !== 'missing') {
        map.set(key, normalized);
      }
    }
  }
  for (const section of primarySections) {
    const key = normalizeTestingDocHeadingKey(section && section.heading);
    if (!key) {
      throw createTestingDocDraftValidationError(
        'testing_doc_section_heading_invalid',
        'testingDocDraft.sections.heading',
        'TESTING.md 草稿段落 heading 不合法'
      );
    }
    map.set(key, normalizeTestingDocSection(section, key, options));
  }
  return TESTING_DOC_SECTION_ORDER.map((key) => map.get(key) || normalizeTestingDocSection({}, key, options));
}

export function summarizeTestingDocDraftReadiness(sections: any[] = []) {
  const byKey = new Map((Array.isArray(sections) ? sections : []).map((section: any) => [section.key, section]));
  const prerequisites = byKey.get('prerequisites');
  const setup = byKey.get('setup');
  const verification = byKey.get('verification');
  const teardown = byKey.get('teardown');
  const openQuestions = Array.from(byKey.values()).flatMap((section: any) => Array.isArray(section.openQuestions) ? section.openQuestions : []);
  const missingCriticalSections = [] as string[];
  const warnings = [] as string[];

  if (!prerequisites || prerequisites.sourceKind === 'missing') {
    missingCriticalSections.push('Prerequisites');
  }
  if (!setup || setup.sourceKind === 'missing') {
    missingCriticalSections.push('Setup');
  }
  if (!verification || verification.sourceKind === 'missing') {
    warnings.push('Verification 尚未确认；当前流程允许写入，但 execution 评估应显式提示风险。');
  }
  if (!teardown || teardown.sourceKind === 'missing') {
    warnings.push('Teardown 尚未确认；当前流程允许写入，但可能留下环境污染风险。');
  }
  if (openQuestions.length > 0) {
    warnings.push('草稿仍包含 Open Questions，需要用户确认后再依赖 execution 导出。');
  }

  return {
    executionBlocked: missingCriticalSections.length > 0 || openQuestions.length > 0,
    missingCriticalSections,
    openQuestions,
    warnings,
  };
}

function stripTestingDocBulletPrefix(value: any) {
  return normalizeText(value)
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function extractTestingDocMachineLines(section: any) {
  const content = normalizeMultilineText(section && section.content);
  if (!content) {
    return [];
  }

  return content
    .split('\n')
    .map((line) => stripTestingDocBulletPrefix(line))
    .map((line) => line.replace(/^`([^`]+)`$/u, '$1').trim())
    .filter((line) => {
      if (!line || line.startsWith('<!--') || line.startsWith('#') || line.startsWith('|')) {
        return false;
      }
      return !/^no\b/i.test(line) && !/^which\b/i.test(line);
    });
}

function normalizeTestingDocMachineRequirement(value: any, index: number) {
  let text = stripTestingDocBulletPrefix(value);
  if (!text) {
    return null;
  }

  let kind = 'command';
  const kindMatch = text.match(/^\[([^\]]+)\]\s+(.+)$/);
  if (kindMatch) {
    const candidateKind = normalizeText(kindMatch[1]).toLowerCase();
    if (VALID_TESTING_DOC_REQUIREMENT_KINDS.has(candidateKind)) {
      kind = candidateKind;
      text = normalizeText(kindMatch[2]);
    }
  }

  if (!text) {
    return null;
  }

  return {
    id: `req-${index + 1}`,
    kind,
    name: text,
    required: true,
  };
}

function buildTestingDocMachineContractBlock(sections: any[]) {
  const byKey = new Map((Array.isArray(sections) ? sections : []).map((section: any) => [section.key, section]));
  const requirements = extractTestingDocMachineLines(byKey.get('prerequisites'))
    .map((line, index) => normalizeTestingDocMachineRequirement(line, index))
    .filter(Boolean);
  const bootstrapCommands = extractTestingDocMachineLines(byKey.get('setup'));
  const verifyCommands = extractTestingDocMachineLines(byKey.get('verification'));

  if (requirements.length === 0 && bootstrapCommands.length === 0 && verifyCommands.length === 0) {
    return '';
  }

  const contract = {
    enabled: true,
    policy: 'required',
    requirements,
    bootstrap: { commands: bootstrapCommands },
    verify: { commands: verifyCommands },
  };

  return [
    '## Machine Contract',
    '',
    '```skill-test-environment',
    JSON.stringify(contract, null, 2),
    '```',
    '',
  ].join('\n');
}

export function buildTestingDocDraftContent(draftOrSections: any) {
  const sections = Array.isArray(draftOrSections)
    ? draftOrSections
    : (Array.isArray(draftOrSections && draftOrSections.sections) ? draftOrSections.sections : []);
  const lines = ['# Testing Environment', ''];
  const machineContractBlock = buildTestingDocMachineContractBlock(sections);
  if (machineContractBlock) {
    lines.push(machineContractBlock);
  }
  for (const section of sections) {
    const heading = normalizeText(section && section.heading) || 'Section';
    const content = normalizeMultilineText(section && section.content) || defaultTestingDocSectionContent(normalizeTestingDocHeadingKey(heading));
    lines.push(`## ${heading}`, content, '');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function normalizeTestingDocDraft(input: any = {}, options: any = {}) {
  const normalizedInput = input && typeof input === 'object' ? input : {};
  const skillId = normalizeText(options.skillId || normalizedInput.skillId);
  if (!skillId) {
    throw createTestingDocDraftValidationError('testing_doc_skill_required', 'skillId', 'TESTING.md 草稿缺少 skillId');
  }

  const targetPath = normalizeText(normalizedInput.targetPath || options.targetPath || 'TESTING.md');
  if (targetPath !== 'TESTING.md') {
    throw createTestingDocDraftValidationError('testing_doc_target_invalid', 'targetPath', 'TESTING.md 草稿只能写入固定 targetPath=TESTING.md');
  }

  const fallbackSections = Array.isArray(options.fallbackSections) ? options.fallbackSections : [];
  const sectionOptions = { maxSectionTextLength: normalizeClipLength(options.maxSectionTextLength) };
  const sections = mergeTestingDocSections(
    Array.isArray(normalizedInput.sections) ? normalizedInput.sections : [],
    fallbackSections,
    sectionOptions
  );
  const content = buildTestingDocDraftContent(sections);
  const sourceKinds = Array.from(new Set(sections.map((section: any) => section.sourceKind).filter(Boolean)));
  const now = normalizeText(options.createdAt || normalizedInput.createdAt) || new Date().toISOString();
  const auditInput = normalizedInput.audit && typeof normalizedInput.audit === 'object' ? normalizedInput.audit : {};
  const fileInput = normalizedInput.file && typeof normalizedInput.file === 'object' ? normalizedInput.file : {};

  return {
    draftId: normalizeText(normalizedInput.draftId) || `testing-doc-${randomUUID()}`,
    skillId,
    targetPath: 'TESTING.md',
    status: normalizeTestingDocDraftStatus(normalizedInput.status || options.status || 'proposed'),
    sections,
    content,
    readiness: summarizeTestingDocDraftReadiness(sections),
    file: {
      existsAtPreview: Boolean(options.fileExistsAtPreview ?? fileInput.existsAtPreview),
      hashAtPreview: normalizeText(options.fileHashAtPreview || fileInput.hashAtPreview),
      sizeAtPreview: Number.isFinite(options.fileSizeAtPreview) ? Number(options.fileSizeAtPreview) : Number(fileInput.sizeAtPreview || 0),
      targetPath: normalizeText(options.targetPath || fileInput.targetPath || 'TESTING.md') || 'TESTING.md',
      overwritePreview: Boolean(options.fileExistsAtPreview ?? fileInput.existsAtPreview),
    },
    audit: {
      conversationId: normalizeText(options.conversationId || auditInput.conversationId),
      messageId: normalizeText(options.messageId || auditInput.messageId),
      agentRole: normalizeText(options.agentRole || auditInput.agentRole || 'scribe') || 'scribe',
      createdBy: normalizeText(options.createdBy || auditInput.createdBy || 'user') || 'user',
      createdAt: normalizeText(auditInput.createdAt) || now,
      sourceKinds,
      appliedBy: normalizeText(auditInput.appliedBy),
      appliedAt: normalizeText(auditInput.appliedAt),
    },
  };
}

export function buildTestingDocDraftFromSkillContext(skill: any, options: any = {}) {
  const skillMarkdown = normalizeMultilineText(skill && (skill.skillMarkdown || skill.body));
  const skillSections = extractTestingDocSectionsFromMarkdown(skillMarkdown, 'skill_md', 'SKILL.md', {
    maxSectionTextLength: options.maxSectionTextLength,
  });
  return normalizeTestingDocDraft(
    {
      ...(options.draft && typeof options.draft === 'object' ? options.draft : {}),
      sections: Array.isArray(options.sections) ? options.sections : (options.draft && Array.isArray(options.draft.sections) ? options.draft.sections : []),
    },
    {
      ...options,
      skillId: options.skillId || skill && skill.id,
      fallbackSections: skillSections,
    }
  );
}

export function normalizeTestingDocDraftState(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  try {
    return normalizeTestingDocDraft(value, { skillId: value.skillId });
  } catch {
    return null;
  }
}
