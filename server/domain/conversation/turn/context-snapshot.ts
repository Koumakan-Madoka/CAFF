import { createHash } from 'node:crypto';

const SNAPSHOT_SCHEMA_VERSION = 2;
const APPROX_CHARS_PER_TOKEN = 4;
const CONTENT_PREVIEW_LENGTH = 180;
const SUMMARY_PREVIEW_LENGTH = 360;
const PROTECTED_CONTENT_PLACEHOLDER = '【受保护内容】此分区由运行时显式标记为仅展示存在状态。Inspector 展示其来源、tokens、hash 和这条说明，不渲染原文。';

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bghp_[A-Za-z0-9_]{8,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gu,
  /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]{6,}/giu,
  /\b[A-Fa-f0-9]{8,}\b/gu,
  /\b(?=[A-Za-z0-9+/_-]{20,}={0,2}\b)(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]+={0,2}\b/gu,
];

const SENSITIVE_CONTEXT_PATTERNS: RegExp[] = [
  /\b(PI_AGENT_PRIVATE_DIR|CAFF_CHAT_TOOLS_PATH|CAFF_CHAT_CALLBACK_TOKEN|CAFF_CHAT_API_URL)(\s*(?:=|:|points to[^:\r\n]*:)\s*)([^\r\n]+)/giu,
];

const PRESENCE_KEYWORDS = [
  'hidden system instructions',
  'hidden developer instructions',
  'auth environment values',
];

const SUMMARY_KEYWORDS = [
  'retrieved long-term experience memory',
  'last recalled evidence cache',
  'conversation digest',
  'mode state context',
  'gameplay mode',
];

const SECTION_VISIBILITY: Record<string, 'full' | 'summary' | 'presence'> = {
  workspace_header: 'full',
  public_persona: 'full',
  private_persona: 'full',
  persona_skills: 'full',
  conversation_skills: 'full',
  trellis_context: 'full',
  conversation_digest: 'full',
  retrieved_memory: 'full',
  retrieval_trace: 'full',
  session_goal: 'full',
  local_sandbox: 'full',
  routing_instructions: 'full',
  rules: 'full',
  command_format_rules: 'full',
  participants: 'full',
  dynamic_skill_loading: 'full',
  tool_instructions: 'full',
  browser_tool_instructions: 'full',
  gameplay_mode: 'full',
  mode_state: 'full',
  private_mailbox: 'full',
  memory_cards: 'full',
  conversation_history: 'full',
  session_delta: 'full',
  turn_trigger: 'full',
  final_instruction: 'full',
};

const SECTION_DISPLAY_TITLES: Record<string, string> = {
  workspace_header: '工作区身份',
  public_persona: '公开角色设定',
  private_persona: '私有角色指令',
  persona_skills: '角色专属技能',
  conversation_skills: '本会话技能',
  trellis_context: 'Trellis 项目上下文',
  conversation_digest: '当前聊天室摘要',
  retrieved_memory: '召回的长期记忆',
  retrieval_trace: '最近召回证据缓存',
  session_goal: '会话目标',
  local_sandbox: '本地沙盒',
  routing_instructions: '路由说明',
  rules: '回复规则',
  command_format_rules: '命令安全与格式',
  participants: '其他可见参与者',
  dynamic_skill_loading: '动态 Skill 加载',
  tool_instructions: '聊天桥接工具',
  browser_tool_instructions: '浏览器工具',
  gameplay_mode: '游戏模式',
  mode_state: '模式状态上下文',
  private_mailbox: '仅自己可见的私有信箱',
  memory_cards: '精选记忆卡片（已停用）',
  conversation_history: '会话历史',
  session_delta: '本轮追加内容',
  turn_trigger: '本轮路由状态',
  final_instruction: '最终回复指令',
};

export type ContextSnapshotVisibility = 'full' | 'summary' | 'presence';
export type ContextSnapshotDeliveryMode = 'fresh' | 'resume' | 'unknown';

export type RetainedSessionPrefixReference = {
  sessionName: string;
  staticSegmentHash: string;
  cursorMessageId: string;
  cursorMessageCount: number;
  cursorFirstMessageId: string;
  cursorMaxUpdatedAt: string | null;
  lastReplyAt: string;
};

export type ContextPromptSectionInput = {
  sectionKey: string;
  title: string;
  source?: string;
  content: string;
  visibility?: ContextSnapshotVisibility;
  truncated?: boolean;
  truncationNote?: string;
};

function sha256(value: string) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function estimateTokens(value: string) {
  const byteLength = Buffer.byteLength(String(value || ''), 'utf8');
  if (byteLength <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(String(value || '').length / APPROX_CHARS_PER_TOKEN));
}

function clipText(value: string, maxLength: number) {
  const text = String(value || '').trim();
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(1, maxLength - 16)).trimEnd()}...[truncated]`;
}

function normalizeKey(value: string) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section';
}

function normalizeDeliveryMode(value: any, fallback: ContextSnapshotDeliveryMode = 'unknown'): ContextSnapshotDeliveryMode {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'fresh' || normalized === 'resume' ? normalized : fallback;
}

function normalizeRetainedSessionPrefix(value: any, deliveryMode: ContextSnapshotDeliveryMode): RetainedSessionPrefixReference | null {
  if (deliveryMode !== 'resume' || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const sessionName = String(value.sessionName || '').trim();
  if (!sessionName) {
    return null;
  }
  const cursorMessageCount = Number(value.cursorMessageCount);
  return {
    sessionName,
    staticSegmentHash: String(value.staticSegmentHash || '').trim(),
    cursorMessageId: String(value.cursorMessageId || '').trim(),
    cursorMessageCount: Number.isInteger(cursorMessageCount) && cursorMessageCount >= 0 ? cursorMessageCount : 0,
    cursorFirstMessageId: String(value.cursorFirstMessageId || '').trim(),
    cursorMaxUpdatedAt: value.cursorMaxUpdatedAt ? String(value.cursorMaxUpdatedAt).trim() : null,
    lastReplyAt: String(value.lastReplyAt || '').trim(),
  };
}

function displayTitleForSection(sectionKey: string, title: string) {
  const key = normalizeKey(sectionKey);
  const originalTitle = String(title || key || 'Section').trim() || 'Section';
  const localizedTitle = SECTION_DISPLAY_TITLES[key];

  if (!localizedTitle) {
    return originalTitle;
  }
  if (originalTitle === localizedTitle || originalTitle.includes(localizedTitle)) {
    return originalTitle;
  }

  return `${localizedTitle} / ${originalTitle}`;
}

function containsSecretLikeValue(value: string) {
  const text = String(value || '');
  return [...SECRET_PATTERNS, ...SENSITIVE_CONTEXT_PATTERNS].some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function redactContextInspectorSecrets(value: string) {
  let text = String(value || '');
  for (const pattern of SENSITIVE_CONTEXT_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (_match: string, name: string, separator: string) => `${name}${separator}[REDACTED]`);
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, '[REDACTED]');
  }
  return text;
}

function visibilityForSection(section: ContextPromptSectionInput): ContextSnapshotVisibility {
  if (section.visibility === 'full' || section.visibility === 'summary' || section.visibility === 'presence') {
    return section.visibility;
  }

  const key = normalizeKey(section.sectionKey);
  if (SECTION_VISIBILITY[key]) {
    return SECTION_VISIBILITY[key];
  }

  const title = String(section.title || '').trim().toLowerCase();
  if (PRESENCE_KEYWORDS.some((keyword) => title.includes(keyword))) {
    return 'presence';
  }
  if (SUMMARY_KEYWORDS.some((keyword) => title.includes(keyword))) {
    return 'summary';
  }

  return 'full';
}

function displayPolicyNote(visibility: ContextSnapshotVisibility, redacted: boolean) {
  if (visibility === 'presence') {
    return '受保护：此分区由运行时显式标记为仅展示存在状态，因此只展示元数据。';
  }
  if (visibility === 'summary') {
    return '仅展示元数据和安全摘要；Inspector 不渲染原始全文。';
  }
  if (redacted) {
    return '原文可见；疑似密钥、令牌或本地敏感路径已在渲染前局部脱敏。';
  }
  return '原文可见；未发现需要脱敏的敏感片段。';
}

function summarizeContent(value: string) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return 'No content.';
  }
  return clipText(text, SUMMARY_PREVIEW_LENGTH);
}

function buildDisplayContent(section: ContextPromptSectionInput, visibility: ContextSnapshotVisibility, redacted: boolean) {
  if (visibility === 'presence') {
    return PROTECTED_CONTENT_PLACEHOLDER;
  }

  if (visibility === 'summary') {
    return summarizeContent(redactContextInspectorSecrets(section.content));
  }

  return redacted ? redactContextInspectorSecrets(section.content) : section.content;
}

function sectionIsTruncated(section: ContextPromptSectionInput) {
  if (section.truncated !== undefined) {
    return Boolean(section.truncated);
  }

  return /\.\.\.\[truncated\]/iu.test(String(section.content || ''));
}

export function createAgentContextSnapshot(input: any = {}) {
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode, 'fresh');
  const retainedSessionPrefix = normalizeRetainedSessionPrefix(input.retainedSessionPrefix, deliveryMode);
  const sections = (Array.isArray(input.sections) ? input.sections : [])
    .filter((section: any) => section && String(section.content || '').trim())
    .map((section: ContextPromptSectionInput, index: number) => {
      const sectionKey = normalizeKey(section.sectionKey || `section_${index + 1}`);
      const rawContent = String(section.content || '');
      const visibility = visibilityForSection(section);
      const secretLike = containsSecretLikeValue(rawContent);
      const redacted = visibility !== 'presence' && secretLike;
      const displayContent = buildDisplayContent(section, visibility, redacted);
      const byteSize = Buffer.byteLength(rawContent, 'utf8');
      const approxTokens = estimateTokens(rawContent);
      const truncated = sectionIsTruncated(section);

      return {
        sectionKey,
        title: String(section.title || sectionKey).trim() || sectionKey,
        displayTitle: displayTitleForSection(sectionKey, section.title || sectionKey),
        source: String(section.source || 'prompt').trim() || 'prompt',
        visibility,
        contentHash: sha256(rawContent),
        displayContentHash: sha256(displayContent),
        approxTokens,
        byteSize,
        truncated,
        truncationNote: truncated
          ? String(section.truncationNote || 'Section content indicates truncation.').trim()
          : '',
        redacted,
        policyNote: displayPolicyNote(visibility, redacted),
        contentPreview: clipText(displayContent, CONTENT_PREVIEW_LENGTH),
        displayContent,
      };
    });

  const totalApproxTokens = sections.reduce((sum: number, section: any) => sum + Math.max(0, Number(section.approxTokens || 0)), 0);
  const totalByteSize = sections.reduce((sum: number, section: any) => sum + Math.max(0, Number(section.byteSize || 0)), 0);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: sha256([
      input.conversationId,
      input.turnId,
      input.messageId,
      input.agentId,
      input.promptVersion,
      deliveryMode,
      retainedSessionPrefix ? JSON.stringify(retainedSessionPrefix) : '',
      sections.map((section: any) => section.contentHash).join('|'),
    ].join('|')).slice(0, 24),
    capturedAt: new Date().toISOString(),
    conversationId: String(input.conversationId || '').trim(),
    turnId: String(input.turnId || '').trim(),
    messageId: String(input.messageId || '').trim(),
    agentId: String(input.agentId || '').trim(),
    agentName: String(input.agentName || '').trim(),
    promptVersion: String(input.promptVersion || '').trim(),
    deliveryMode,
    retainedSessionPrefix,
    immutable: true,
    totalApproxTokens,
    totalByteSize,
    sections,
  };
}

export function summarizeAgentContextSnapshot(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  const deliveryMode = normalizeDeliveryMode(snapshot.deliveryMode);
  return {
    schemaVersion: snapshot.schemaVersion || SNAPSHOT_SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId || '',
    capturedAt: snapshot.capturedAt || '',
    conversationId: snapshot.conversationId || '',
    turnId: snapshot.turnId || '',
    messageId: snapshot.messageId || '',
    agentId: snapshot.agentId || '',
    agentName: snapshot.agentName || '',
    promptVersion: snapshot.promptVersion || '',
    deliveryMode,
    retainedSessionPrefix: normalizeRetainedSessionPrefix(snapshot.retainedSessionPrefix, deliveryMode),
    immutable: snapshot.immutable !== false,
    totalApproxTokens: Math.max(0, Number(snapshot.totalApproxTokens || 0)),
    totalByteSize: Math.max(0, Number(snapshot.totalByteSize || 0)),
    sectionCount: sections.length,
    sections: sections.map((section: any) => ({
      sectionKey: section.sectionKey || '',
      title: section.title || '',
      displayTitle: section.displayTitle || displayTitleForSection(section.sectionKey || '', section.title || ''),
      source: section.source || '',
      visibility: section.visibility || 'presence',
      contentHash: section.contentHash || '',
      displayContentHash: section.displayContentHash || '',
      approxTokens: Math.max(0, Number(section.approxTokens || 0)),
      byteSize: Math.max(0, Number(section.byteSize || 0)),
      truncated: Boolean(section.truncated),
      truncationNote: section.truncationNote || '',
      redacted: Boolean(section.redacted),
      policyNote: section.policyNote || '',
      contentPreview: section.contentPreview || '',
    })),
  };
}

function snapshotSectionIntegrity(section: any) {
  const displayContent = String(section && section.displayContent || '');
  const expected = String(section && section.displayContentHash || '').trim();
  return !expected || sha256(displayContent) === expected;
}

export function materializeAgentContextSnapshot(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const summary = summarizeAgentContextSnapshot(snapshot);
  const sections = (Array.isArray(snapshot.sections) ? snapshot.sections : []).map((section: any, index: number) => {
    const safeSection = summary && summary.sections ? summary.sections[index] || {} : {};
    const integrityOk = snapshotSectionIntegrity(section);
    return {
      ...safeSection,
      integrityOk,
      displayContent: integrityOk
        ? String(section && section.displayContent || '')
        : '【快照完整性警告】已存展示内容的 hash 与当前内容不一致，可能已损坏。',
    };
  });

  return {
    ...summary,
    integrityOk: sections.every((section: any) => section.integrityOk !== false),
    sections,
  };
}

function markdownEscape(value: string) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function exportAgentContextSnapshotMarkdown(snapshot: any) {
  const materialized = materializeAgentContextSnapshot(snapshot);

  if (!materialized) {
    return '# Agent Context Snapshot\n\nNo snapshot is available.\n';
  }

  const deliveryLabel = materialized.deliveryMode === 'resume'
    ? 'resume（仅追加本轮增量，旧前缀由 Session 保留）'
    : materialized.deliveryMode === 'fresh'
      ? 'fresh（本轮完整注入）'
      : 'unknown（旧版快照未记录实际投递方式）';
  const lines = [
    '# Agent Context Snapshot / 智能体上下文快照',
    '',
    `- 智能体 / Agent: ${materialized.agentName || materialized.agentId || 'unknown'}`,
    `- 回合 / Turn: ${materialized.turnId || 'unknown'}`,
    `- 消息 / Message: ${materialized.messageId || 'unknown'}`,
    `- 捕获时间 / Captured at: ${materialized.capturedAt || 'unknown'}`,
    `- Prompt 版本 / Prompt version: ${materialized.promptVersion || 'unknown'}`,
    `- 投递方式 / Delivery mode: ${deliveryLabel}`,
  ];

  if (materialized.retainedSessionPrefix) {
    const retained = materialized.retainedSessionPrefix;
    lines.push(
      `- 保留的 Session 前缀 / Retained session prefix: ${retained.sessionName}`,
      `- 前缀游标 / Prefix cursor: ${retained.cursorMessageCount} messages, last=${retained.cursorMessageId || 'unknown'}`,
      `- 静态段 Hash / Static segment hash: ${retained.staticSegmentHash || 'unknown'}`
    );
  }

  lines.push(
    `- 近似 tokens / Total approximate tokens: ${materialized.totalApproxTokens}`,
    `- 字节数 / Total byte size: ${materialized.totalByteSize}`,
    `- 完整性 / Integrity: ${materialized.integrityOk ? 'ok' : 'warning'}`,
    '',
    '| 分区 / Section | 来源 / Source | 可见性 / Visibility | Tokens | 字节 / Bytes | Hash | 是否截断 / Truncated |',
    '| --- | --- | --- | ---: | ---: | --- | --- |'
  );

  for (const section of materialized.sections) {
    lines.push(
      `| ${markdownEscape(section.displayTitle || section.title)} | ${markdownEscape(section.source)} | ${markdownEscape(section.visibility)} | ${section.approxTokens} | ${section.byteSize} | ${markdownEscape(String(section.contentHash || '').slice(0, 12))} | ${section.truncated ? 'yes' : 'no'} |`
    );
  }

  for (const section of materialized.sections) {
    lines.push(
      '',
      `## ${section.displayTitle || section.title || section.sectionKey || 'Section'}`,
      '',
      `- 来源 / Source: ${section.source || 'prompt'}`,
      `- 可见性 / Visibility: ${section.visibility || 'presence'}`,
      `- 近似 tokens / Approx tokens: ${section.approxTokens}`,
      `- 字节数 / Byte size: ${section.byteSize}`,
      `- 内容哈希 / Content hash: ${section.contentHash || ''}`,
      `- 是否截断 / Truncated: ${section.truncated ? 'yes' : 'no'}${section.truncationNote ? ` (${section.truncationNote})` : ''}`,
      `- 策略说明 / Policy: ${section.policyNote || ''}`,
      '',
      '```text',
      section.displayContent || '[empty]',
      '```'
    );
  }

  return `${lines.join('\n')}\n`;
}
