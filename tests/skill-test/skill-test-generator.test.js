const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

// Test skill-test-generator module
const { generateSkillTestPrompts, buildLlmGenerationPrompt } = require('../../build/lib/skill-test-generator');

// ---- generateSkillTestPrompts ----

test('generateSkillTestPrompts returns correct number of game prompts', () => {
  const skill = {
    id: 'werewolf',
    name: '狼人杀 Skill',
    description: '用于后端全自动主持的狼人杀玩法。模型只扮演玩家，按后端推进的日夜阶段行动。',
    body: '狼人杀规则...',
  };

  const prompts = generateSkillTestPrompts(skill, { count: 3 });

  assert.equal(prompts.length, 3);
  for (const p of prompts) {
    assert.ok(p.triggerPrompt, 'should have triggerPrompt');
    assert.ok(p.triggerPrompt.length >= 5, 'triggerPrompt should be at least 5 chars');
    assert.ok(p.triggerPrompt.length <= 2000, 'triggerPrompt should be at most 2000 chars');
    assert.ok(p.expectedBehavior, 'should have expectedBehavior');
    assert.ok(p.note, 'should have note');
    assert.ok(Array.isArray(p.expectedTools), 'expectedTools should be array');
  }
});

test('generateSkillTestPrompts detects game skills and uses game templates', () => {
  const skill = {
    id: 'who-is-undercover',
    name: '谁是卧底 Skill',
    description: '用于后端全自动主持的谁是卧底玩法。',
    body: '谁是卧底规则...',
  };

  const prompts = generateSkillTestPrompts(skill, { count: 3 });

  assert.equal(prompts.length, 3);
  // Game prompts should contain the skill name
  for (const p of prompts) {
    assert.ok(
      p.triggerPrompt.includes('谁是卧底') || p.triggerPrompt.includes('卧底'),
      `Game prompt should reference the skill name: "${p.triggerPrompt}"`
    );
  }
});

test('generateSkillTestPrompts uses workflow templates for non-game skills', () => {
  const skill = {
    id: 'before-dev',
    name: 'before-dev',
    description: 'Discovers and injects project-specific coding guidelines from .trellis/spec/ before implementation begins.',
    body: 'Read spec indexes...',
  };

  const prompts = generateSkillTestPrompts(skill, { count: 3 });

  assert.equal(prompts.length, 3);
  // Workflow prompts should contain the skill name
  for (const p of prompts) {
    assert.ok(
      p.triggerPrompt.includes('before-dev'),
      `Workflow prompt should reference the skill name: "${p.triggerPrompt}"`
    );
  }
});

test('generateSkillTestPrompts keeps trigger cases minimal for dynamic mode', () => {
  const skill = {
    id: 'before-dev',
    name: 'before-dev',
    description: 'Discovers and injects project-specific coding guidelines from .trellis/spec/ before implementation begins.',
    body: `Execute these steps:\n\n1. \`python3 ./.trellis/scripts/get_context.py --mode packages\`\n2. \`cat .trellis/spec/<package>/<layer>/index.md\``,
  };

  const prompts = generateSkillTestPrompts(skill, {
    count: 2,
    testType: 'trigger',
    loadingMode: 'dynamic',
  });

  assert.equal(prompts.length, 2);
  for (const p of prompts) {
    assert.deepEqual(p.expectedTools, [
      {
        name: 'read-skill',
        order: 1,
        requiredParams: ['skillId'],
        arguments: { skillId: 'before-dev' },
      },
    ]);
  }
});

test('generateSkillTestPrompts extracts structured expectedTools for execution cases', () => {
  const skill = {
    id: 'before-dev',
    name: 'before-dev',
    description: 'Discovers and injects project-specific coding guidelines from .trellis/spec/ before implementation begins.',
    body: `Execute these steps:\n\n1. \`python3 ./.trellis/scripts/get_context.py --mode packages\`\n2. \`cat .trellis/spec/<package>/<layer>/index.md\`\n3. \`cat .trellis/spec/guides/index.md\``,
  };

  const prompts = generateSkillTestPrompts(skill, {
    count: 1,
    testType: 'execution',
    loadingMode: 'dynamic',
  });

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].expectedTools.length, 4);
  assert.deepEqual(prompts[0].expectedTools[0], {
    name: 'read-skill',
    order: 1,
    requiredParams: ['skillId'],
    arguments: { skillId: 'before-dev' },
  });
  assert.deepEqual(prompts[0].expectedTools[1], {
    name: 'bash',
    order: 2,
    requiredParams: ['command'],
    arguments: { command: '<contains:python3 ./.trellis/scripts/get_context.py --mode packages>' },
  });
  assert.deepEqual(prompts[0].expectedTools[2], {
    name: 'read',
    order: 3,
    requiredParams: ['path'],
    arguments: { path: '<contains:.trellis/spec>' },
  });
  assert.deepEqual(prompts[0].expectedTools[3], {
    name: 'read',
    order: 4,
    requiredParams: ['path'],
    arguments: { path: '<contains:.trellis/spec/guides/index.md>' },
  });
  assert.match(prompts[0].expectedBehavior, /read-skill → bash → read → read/);
});

test('generateSkillTestPrompts extracts command examples from plain text workflow lines', () => {
  const skill = {
    id: 'onboard',
    name: 'onboard',
    description: 'Interactive onboarding for new team members.',
    body: `### Example 2: Planning Session\n\n**[1/4] $start** - Context needed even for non-coding work\n**[2/4] python3 ./.trellis/scripts/task.py create "Planning task" --slug planning-task** - Planning is valuable work`,
  };

  const prompts = generateSkillTestPrompts(skill, {
    count: 1,
    testType: 'execution',
    loadingMode: 'dynamic',
  });

  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].expectedTools, [
    {
      name: 'read-skill',
      order: 1,
      requiredParams: ['skillId'],
      arguments: { skillId: 'onboard' },
    },
    {
      name: 'bash',
      order: 2,
      requiredParams: ['command'],
      arguments: { command: '<contains:python3 ./.trellis/scripts/task.py create "Planning task" --slug planning-task>' },
    },
  ]);
});

test('generateSkillTestPrompts respects count limits', () => {
  const skill = {
    id: 'test',
    name: 'Test Skill',
    description: 'A test skill for counting.',
    body: '',
  };

  // Minimum count
  const one = generateSkillTestPrompts(skill, { count: 1 });
  assert.equal(one.length, 1);

  // Maximum count is 10, but limited by available templates (4 for workflow type)
  const max = generateSkillTestPrompts(skill, { count: 15 });
  assert.ok(max.length <= 10, 'should not exceed max count of 10');
  assert.ok(max.length > 0, 'should produce at least 1 prompt');

  // Default count is 3
  const def = generateSkillTestPrompts(skill);
  assert.equal(def.length, 3);
});

test('generateSkillTestPrompts handles empty/missing skill data', () => {
  const skill = { id: '', name: '', description: '', body: '' };
  const prompts = generateSkillTestPrompts(skill, { count: 2 });

  assert.equal(prompts.length, 2);
  for (const p of prompts) {
    assert.ok(p.triggerPrompt, 'should still produce a prompt');
  }
});

// ---- buildLlmGenerationPrompt ----

test('buildLlmGenerationPrompt produces a non-empty prompt string', () => {
  const skill = {
    id: 'werewolf',
    name: '狼人杀 Skill',
    description: '用于后端全自动主持的狼人杀玩法。',
    body: '狼人杀规则详细内容...',
  };

  const prompt = buildLlmGenerationPrompt(skill, { count: 3 });

  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 100, 'LLM prompt should be substantial');
  assert.ok(prompt.includes('werewolf') || prompt.includes('狼人杀'), 'should mention skill');
  assert.ok(prompt.includes('JSON'), 'should ask for JSON output');
});

test('buildLlmGenerationPrompt uses default count', () => {
  const skill = {
    id: 'test',
    name: 'Test',
    description: 'Test.',
    body: '',
  };

  const prompt = buildLlmGenerationPrompt(skill);
  assert.ok(prompt.includes('3'), 'default count should be 3');
  assert.ok(prompt.includes('requiredParams'), 'LLM prompt should mention structured expectedTools');
});
