/**
 * Skill Test Generator
 *
 * Generates trigger test prompts from skill content using a template-based
 * strategy with few-shot examples. Phase 1 uses simple seed extraction and
 * template generation; Phase 2 can add LLM-powered expansion.
 */

function extractKeywords(text: string): { verbs: string[]; scenes: string[]; tools: string[] } {
  const content = String(text || '');

  // Extract tool names from markdown tool references like `tool-name` or "tool-name"
  const toolMatches = content.match(/`([a-z][a-z0-9-]{2,})`/g) || [];
  const tools = [...new Set(toolMatches.map((m) => m.replace(/`/g, '')))].filter(
    (t) =>
      t.includes('-') ||
      ['read', 'write', 'create', 'delete', 'update', 'list', 'get', 'send', 'post', 'run'].some(
        (prefix) => t.startsWith(prefix)
      )
  );

  // Extract Chinese action verbs
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

  // Extract scene/topic words
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
    '- "expectedTools": string[] (tools that should be called, can be empty)',
    '- "expectedBehavior": string (what the agent should do)',
    '- "note": string (brief explanation)',
  ].join('\n');
}

export interface GeneratedPrompt {
  triggerPrompt: string;
  expectedTools: string[];
  expectedBehavior: string;
  note: string;
}

/**
 * Phase 1: Template-based prompt generation using skill metadata.
 *
 * Uses a two-strategy approach:
 * - For game/interactive skills (detected by keywords): generates game-start prompts
 * - For tool/workflow skills: generates task-actionable prompts
 *
 * Phase 2 will replace this with LLM-powered generation via `buildLlmGenerationPrompt`.
 */
function isGameOrInteractiveSkill(name: string, description: string): boolean {
  const gameKeywords = /(?:游戏|比赛|玩|杀|卧底|投票|发言|竞选|淘汰|对局|match|play|game|vote)/;
  const combined = `${name} ${description}`.toLowerCase();
  return gameKeywords.test(combined);
}

function generateGamePrompts(skillName: string, count: number): GeneratedPrompt[] {
  const templates = [
    { triggerPrompt: `我们来${skillName}吧`, note: `Direct invocation of ${skillName}` },
    { triggerPrompt: `想玩${skillName}，能帮我开始吗？`, note: `Casual request for ${skillName}` },
    { triggerPrompt: `大家想玩${skillName}，可以开始了吗`, note: `Social context for ${skillName}` },
    { triggerPrompt: `${skillName}准备好了吗？开始吧`, note: `Ready-to-start pattern for ${skillName}` },
    { triggerPrompt: `帮我开一局${skillName}游戏`, note: `Game-specific request for ${skillName}` },
    { triggerPrompt: `有没有人想${skillName}？有的话就开始`, note: `Recruitment pattern for ${skillName}` },
  ];
  return templates.map((t) => ({
    triggerPrompt: t.triggerPrompt,
    expectedTools: [],
    expectedBehavior: `Agent should recognize the request and trigger the ${skillName} skill`,
    note: t.note,
  })).slice(0, count);
}

function generateWorkflowPrompts(skillName: string, keywords: ReturnType<typeof extractKeywords>, count: number): GeneratedPrompt[] {
  const templates = [
    { triggerPrompt: `帮我执行${skillName}`, note: `Direct execution of ${skillName}` },
    { triggerPrompt: `开始${skillName}任务`, note: `Task-oriented trigger for ${skillName}` },
    { triggerPrompt: `我需要进行${skillName}，请帮我处理`, note: `Request-oriented trigger for ${skillName}` },
    { triggerPrompt: `执行一下${skillName}`, note: `Casual command for ${skillName}` },
  ];
  return templates.map((t) => ({
    triggerPrompt: t.triggerPrompt,
    expectedTools: [],
    expectedBehavior: `Agent should recognize the request and trigger the ${skillName} skill`,
    note: t.note,
  })).slice(0, count);
}
export function generateSkillTestPrompts(
  skill: { id: string; name: string; description: string; body?: string },
  options: { count?: number } = {}
): GeneratedPrompt[] {
  const count = Math.max(1, Math.min(10, options.count || 3));
  const skillName = String(skill.name || skill.id || '').trim();
  const skillDescription = String(skill.description || '').trim();
  const skillBody = String(skill.body || '').trim();

  // Extract keywords from the skill body for seed generation
  const keywords = extractKeywords(skillBody);

  // Determine strategy based on skill type
  const isGame = isGameOrInteractiveSkill(skillName, skillDescription);
  const prompts: GeneratedPrompt[] = [];

  if (isGame) {
    prompts.push(...generateGamePrompts(skillName, count));
  } else {
    prompts.push(...generateWorkflowPrompts(skillName, keywords, count));
  }

  // Trim to requested count
  return prompts.slice(0, count);
}

/**
 * Build a prompt that could be sent to an LLM for generating test cases.
 * Exported for Phase 2 when we add LLM-powered generation.
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
