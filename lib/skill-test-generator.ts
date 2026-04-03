/**
 * Skill Test Generator
 *
 * Generates trigger test prompts from skill content using a template-based
 * strategy with few-shot examples. Phase 1 uses simple seed extraction and
 * template generation; Phase 2 adds structured expected-tool extraction so
 * execution-focused cases can validate parameters and order.
 */

export interface StructuredExpectedTool {
  name: string;
  requiredParams?: string[];
  arguments?: Record<string, any>;
  order?: number;
}

export type GeneratedExpectedTool = string | StructuredExpectedTool;

export interface GeneratedPrompt {
  triggerPrompt: string;
  expectedTools: GeneratedExpectedTool[];
  expectedBehavior: string;
  note: string;
}

const KNOWN_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'read-skill',
  'send-public',
  'send-private',
  'read-context',
  'list-participants',
  'trellis-init',
  'trellis-write',
]);

const SHELL_COMMAND_PREFIX = /^(?:python\d*|node|npm|npx|git|rg|find|ls|dir|cp|mv|rm|mkdir|echo|bash|sh)\b/i;
const FILE_PATH_LIKE = /^[.~\w/-]+(?:\.[\w.-]+)?(?:\/[.~\w-]+)*(?:\.[\w.-]+)?$/;

function extractKeywords(text: string): { verbs: string[]; scenes: string[]; tools: string[] } {
  const content = String(text || '');

  const toolMatches = content.match(/`([a-z][a-z0-9-]{2,})`/g) || [];
  const tools = [...new Set(toolMatches.map((m) => m.replace(/`/g, '')))].filter(
    (toolName) =>
      KNOWN_TOOL_NAMES.has(toolName) ||
      toolName.includes('-') ||
      ['read', 'write', 'create', 'delete', 'update', 'list', 'get', 'send', 'post', 'run'].some(
        (prefix) => toolName.startsWith(prefix)
      )
  );

  const verbPatterns = [
    /(?:投票|发言|执行|启动|停止|选择|分配|讨论|发言|竞选|淘汰|复活|跳过|确认|取消)/g,
    /(?:开始|结束|加入|退出|查看|检查|测试|运行|播放|暂停)/g,
  ];
  const verbs = [
    ...new Set(
      verbPatterns
        .flatMap((pattern) => {
          pattern.lastIndex = 0;
          return content.match(pattern) || [];
        })
        .filter(Boolean)
    ),
  ];

  const scenePatterns = [
    /狼人杀/g,
    /谁是卧底/g,
    /(?:游戏|比赛|活动|角色|玩家|主持人|裁判)/g,
    /(?:skill|工具|测试|评测|报告|统计)/gi,
  ];
  const scenes = [
    ...new Set(
      scenePatterns
        .flatMap((pattern) => {
          pattern.lastIndex = 0;
          return content.match(pattern) || [];
        })
        .filter(Boolean)
    ),
  ];

  return { verbs, scenes, tools };
}

function buildFewShotContext(skillName: string, skillDescription: string): string {
  return [
    'You are generating test prompts to verify that an AI agent correctly identifies and activates a skill.',
    '',
    `The skill being tested is "${skillName}": ${skillDescription}`,
    '',
    'Generate prompts that a user would naturally say to trigger this skill.',
    'The prompts should be varied: some direct, some indirect, some creative.',
    'Each prompt should be 10-100 characters long.',
    '',
    'Good trigger prompts (examples for "werewolf" skill):',
    '- "我们来玩狼人杀吧"',
    '- "想玩一局狼人杀，你能当主持人吗"',
    '- "开始狼人杀游戏"',
    '',
    'Bad trigger prompts (these would NOT trigger the skill):',
    '- "狼人杀是什么" (just asking a question, not wanting to play)',
    '- "告诉我狼人杀的规则" (informational, not actionable)',
    '',
    'Good trigger prompts (examples for "who-is-undercover" skill):',
    '- "来一局谁是卧底"',
    '- "玩谁是卧底吧"',
    '- "我们几个人想玩谁是卧底游戏"',
    '',
    'Now generate prompts for the target skill. Output ONLY a JSON array of objects.',
    'Each object should have:',
    '- "triggerPrompt": string (the user message)',
    '- "expectedTools": array (tool names or { name, requiredParams, arguments, order } objects when the skill body shows clear tool examples)',
    '- "expectedBehavior": string (what the agent should do)',
    '- "note": string (brief explanation)',
  ].join('\n');
}

function isGameOrInteractiveSkill(name: string, description: string): boolean {
  const gameKeywords = /(?:游戏|比赛|玩|杀|卧底|投票|发言|竞选|淘汰|对局|match|play|game|vote)/;
  const combined = `${name} ${description}`.toLowerCase();
  return gameKeywords.test(combined);
}

function normalizeSkillName(name: string, id: string): string {
  const rawName = String(name || id || '').trim();
  return rawName.replace(/\s+Skill$/i, '');
}

function cleanSnippet(value: string): string {
  return String(value || '')
    .replace(/^\s*\$\s*/, '')
    .replace(/\s+#.*$/, '')
    .trim();
}

function normalizeInlineValue(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\/g, '/');
}

function stripPlaceholderTokens(value: string): string {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]+\}/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStableFragment(value: string): string {
  const normalized = normalizeInlineValue(value).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  const placeholderMatch = normalized.match(/<[^>]+>|\{[^}]+\}|\[[^\]]+\]/);
  if (!placeholderMatch || placeholderMatch.index == null) {
    return normalized;
  }

  const placeholderStart = placeholderMatch.index;
  const placeholderEnd = placeholderStart + placeholderMatch[0].length;
  const prefix = normalized.slice(0, placeholderStart).trim();
  const suffix = normalized.slice(placeholderEnd).trim();

  const prefixCandidate = stripPlaceholderTokens(prefix).replace(/[\s/]+$/g, '').trim();
  const suffixCandidate = stripPlaceholderTokens(suffix).replace(/^[\s/]+/g, '').trim();

  if (prefixCandidate.includes('/') && suffixCandidate && !suffixCandidate.includes('/') && prefixCandidate.length >= 4) {
    return prefixCandidate;
  }
  if (prefixCandidate.length >= suffixCandidate.length && prefixCandidate.length >= 4) {
    return prefixCandidate;
  }
  if (suffixCandidate.length >= 4) {
    return suffixCandidate;
  }
  return prefixCandidate || suffixCandidate || '';
}

function buildContainsPattern(value: string, fallback = '<string>'): string {
  const fragment = extractStableFragment(value);
  return fragment ? `<contains:${fragment}>` : fallback;
}

function buildReadToolSpec(rawPath: string, order: number): StructuredExpectedTool {
  const normalizedPath = normalizeInlineValue(rawPath);
  return {
    name: 'read',
    order,
    requiredParams: ['path'],
    arguments: {
      path: buildContainsPattern(normalizedPath),
    },
  };
}

function buildBashToolSpec(rawCommand: string, order: number): StructuredExpectedTool {
  const normalizedCommand = cleanSnippet(rawCommand);
  return {
    name: 'bash',
    order,
    requiredParams: ['command'],
    arguments: {
      command: buildContainsPattern(normalizedCommand),
    },
  };
}

function buildDynamicReadSkillSpec(skillId: string, order: number): StructuredExpectedTool {
  return {
    name: 'read-skill',
    order,
    requiredParams: ['skillId'],
    arguments: {
      skillId,
    },
  };
}

function parseSnippetAsExpectedTool(snippet: string, skillId: string, order: number): StructuredExpectedTool | null {
  const cleaned = cleanSnippet(snippet);
  if (!cleaned) {
    return null;
  }

  const assignedCommandMatch = cleaned.match(/^[A-Z_][A-Z0-9_]*=\$\((.+)\)$/);
  if (assignedCommandMatch && assignedCommandMatch[1]) {
    return parseSnippetAsExpectedTool(assignedCommandMatch[1], skillId, order);
  }

  if (KNOWN_TOOL_NAMES.has(cleaned)) {
    if (cleaned === 'read-skill') {
      return buildDynamicReadSkillSpec(skillId, order);
    }
    return { name: cleaned, order };
  }

  const readMatch = cleaned.match(/^(?:cat|read)\s+(.+)$/i);
  if (readMatch) {
    return buildReadToolSpec(readMatch[1], order);
  }

  if (SHELL_COMMAND_PREFIX.test(cleaned)) {
    return buildBashToolSpec(cleaned, order);
  }

  if (FILE_PATH_LIKE.test(cleaned) && /[./]/.test(cleaned)) {
    return buildReadToolSpec(cleaned, order);
  }

  return null;
}

function extractCommandLikeSnippetFromLine(line: string): string {
  const normalizedLine = String(line || '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .trim();

  if (!normalizedLine || normalizedLine.startsWith('#')) {
    return '';
  }

  const withoutMarker = normalizedLine.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim();
  const commandMatch = withoutMarker.match(
    /(?:\[\d+\/\d+\]\s*)?((?:[A-Z_][A-Z0-9_]*=\$\()?(?:python\d*|cat|grep|git|npm|node|npx|rg|find|ls|dir)\b.*)$/i
  );
  if (!commandMatch || !commandMatch[1]) {
    return '';
  }

  return cleanSnippet(commandMatch[1])
    .replace(/\s+-\s+[A-Z\u4e00-\u9fff].*$/, '')
    .trim();
}

function collectOrderedSnippets(body: string): Array<{ index: number; snippet: string }> {
  const content = String(body || '');
  const snippets: Array<{ index: number; snippet: string }> = [];

  const fenceRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of content.matchAll(fenceRegex)) {
    const blockIndex = match.index || 0;
    const blockBody = String(match[2] || '');
    const blockLines = blockBody
      .split(/\r?\n/)
      .map((line) => cleanSnippet(line))
      .filter(Boolean);

    for (const line of blockLines) {
      snippets.push({ index: blockIndex, snippet: line });
    }
  }

  const inlineRegex = /`([^`\n]+)`/g;
  for (const match of content.matchAll(inlineRegex)) {
    const inlineSnippet = cleanSnippet(match[1] || '');
    if (!inlineSnippet) {
      continue;
    }

    if (
      KNOWN_TOOL_NAMES.has(inlineSnippet) ||
      SHELL_COMMAND_PREFIX.test(inlineSnippet) ||
      /^(?:cat|read)\s+/i.test(inlineSnippet) ||
      (FILE_PATH_LIKE.test(inlineSnippet) && /[./]/.test(inlineSnippet))
    ) {
      snippets.push({ index: match.index || 0, snippet: inlineSnippet });
    }
  }

  let lineOffset = 0;
  for (const line of content.split(/\r?\n/)) {
    const snippet = extractCommandLikeSnippetFromLine(line);
    if (snippet) {
      snippets.push({ index: lineOffset, snippet });
    }
    lineOffset += line.length + 1;
  }

  return snippets.sort((left, right) => left.index - right.index);
}

function dedupeToolSpecs(specs: StructuredExpectedTool[]): StructuredExpectedTool[] {
  const seen = new Set<string>();
  const deduped: StructuredExpectedTool[] = [];

  for (const spec of specs) {
    const signature = JSON.stringify({
      name: spec.name,
      requiredParams: spec.requiredParams || [],
      arguments: spec.arguments || null,
    });
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(spec);
  }

  return deduped.map((spec, index) => ({
    ...spec,
    order: index + 1,
  }));
}

function extractExpectedToolsFromSkill(
  skill: { id: string; body?: string },
  options: { testType?: string; loadingMode?: string } = {}
): GeneratedExpectedTool[] {
  const testType = String(options.testType || 'trigger').trim().toLowerCase() || 'trigger';
  const loadingMode = String(options.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
  const skillId = String(skill.id || '').trim();

  if (testType !== 'execution') {
    return loadingMode === 'dynamic' && skillId
      ? [buildDynamicReadSkillSpec(skillId, 1)]
      : [];
  }

  const extracted: StructuredExpectedTool[] = [];
  if (loadingMode === 'dynamic' && skillId) {
    extracted.push(buildDynamicReadSkillSpec(skillId, 1));
  }

  const snippets = collectOrderedSnippets(skill.body || '');
  let nextOrder = extracted.length + 1;

  for (const entry of snippets) {
    const spec = parseSnippetAsExpectedTool(entry.snippet, skillId, nextOrder);
    if (!spec) {
      continue;
    }
    extracted.push(spec);
    nextOrder += 1;
  }

  return dedupeToolSpecs(extracted).slice(0, 6);
}

function buildExpectedBehavior(skillName: string, expectedTools: GeneratedExpectedTool[], testType: string): string {
  const normalizedTestType = String(testType || 'trigger').trim().toLowerCase() || 'trigger';
  if (normalizedTestType !== 'execution') {
    return `Agent should recognize the request and trigger the ${skillName} skill`;
  }

  const toolNames = expectedTools
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .filter(Boolean);

  if (toolNames.length === 0) {
    return `Agent should recognize the request and follow the ${skillName} skill instructions`;
  }

  return `Agent should recognize the request and follow the ${skillName} skill instructions, including ${toolNames.join(' → ')}`;
}

function generateGamePrompts(
  skillName: string,
  expectedTools: GeneratedExpectedTool[],
  testType: string,
  count: number
): GeneratedPrompt[] {
  const templates = [
    { triggerPrompt: `我们来${skillName}吧`, note: `Direct invocation of ${skillName}` },
    { triggerPrompt: `想玩${skillName}，能帮我开始吗？`, note: `Casual request for ${skillName}` },
    { triggerPrompt: `大家想玩${skillName}，可以开始了吗`, note: `Social context for ${skillName}` },
    { triggerPrompt: `${skillName}准备好了吗？开始吧`, note: `Ready-to-start pattern for ${skillName}` },
    { triggerPrompt: `帮我开一局${skillName}游戏`, note: `Game-specific request for ${skillName}` },
    { triggerPrompt: `有没有人想${skillName}？有的话就开始`, note: `Recruitment pattern for ${skillName}` },
  ];

  return templates
    .map((template) => ({
      triggerPrompt: template.triggerPrompt,
      expectedTools,
      expectedBehavior: buildExpectedBehavior(skillName, expectedTools, testType),
      note: template.note,
    }))
    .slice(0, count);
}

function generateWorkflowPrompts(
  skillName: string,
  keywords: ReturnType<typeof extractKeywords>,
  expectedTools: GeneratedExpectedTool[],
  testType: string,
  count: number
): GeneratedPrompt[] {
  const preferredVerb = keywords.verbs[0] || '执行';
  const sceneHint = keywords.scenes[0] || skillName;
  const templates = [
    { triggerPrompt: `帮我执行${skillName}`, note: `Direct execution of ${skillName}` },
    { triggerPrompt: `开始${skillName}任务`, note: `Task-oriented trigger for ${skillName}` },
    { triggerPrompt: `我需要进行${skillName}，请帮我处理`, note: `Request-oriented trigger for ${skillName}` },
    { triggerPrompt: `执行一下${skillName}`, note: `Casual command for ${skillName}` },
    { triggerPrompt: `我准备${preferredVerb}${sceneHint}相关流程，先走${skillName}`, note: `Verb-guided prompt for ${skillName}` },
    { triggerPrompt: `进入${skillName}步骤前，先帮我把这件事处理掉`, note: `Context-first prompt for ${skillName}` },
  ];

  return templates
    .map((template) => ({
      triggerPrompt: template.triggerPrompt,
      expectedTools,
      expectedBehavior: buildExpectedBehavior(skillName, expectedTools, testType),
      note: template.note,
    }))
    .slice(0, count);
}

/**
 * Template-based prompt generation using skill metadata plus Phase 2 expected-tool extraction.
 */
export function generateSkillTestPrompts(
  skill: { id: string; name: string; description: string; body?: string },
  options: { count?: number; testType?: string; loadingMode?: string } = {}
): GeneratedPrompt[] {
  const count = Math.max(1, Math.min(10, options.count || 3));
  const skillName = normalizeSkillName(skill.name, skill.id);
  const skillDescription = String(skill.description || '').trim();
  const skillBody = String(skill.body || '').trim();
  const testType = String(options.testType || 'trigger').trim().toLowerCase() || 'trigger';
  const loadingMode = String(options.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';

  const keywords = extractKeywords(skillBody);
  const isGame = isGameOrInteractiveSkill(skillName, skillDescription);
  const expectedTools = extractExpectedToolsFromSkill(skill, { testType, loadingMode });

  if (isGame) {
    return generateGamePrompts(skillName, expectedTools, testType, count);
  }

  return generateWorkflowPrompts(skillName, keywords, expectedTools, testType, count);
}

/**
 * Build a prompt that could be sent to an LLM for generating test cases.
 * Exported for future LLM-powered generation.
 */
export function buildLlmGenerationPrompt(
  skill: { id: string; name: string; description: string; body?: string },
  options: { count?: number } = {}
): string {
  const count = options.count || 3;
  const fewShot = buildFewShotContext(skill.name, skill.description);
  const bodyPreview = String(skill.body || '').slice(0, 2000);

  return [
    fewShot,
    '',
    `Skill body (first 2000 chars):\n---\n${bodyPreview}\n---`,
    '',
    `Generate exactly ${count} test prompts. Output a JSON array.`,
  ].join('\n');
}
