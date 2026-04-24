import { readSkillTestingDocument } from './environment-chain';

const MAX_SKILL_TESTING_DOC_PROMPT_LENGTH = 16000;

function normalizePathForJson(value: any) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function normalizePromptText(value: any) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

export function getCanonicalCasePrompt(value: any) {
  if (!value || typeof value !== 'object') {
    return '';
  }
  return normalizePromptText(value.userPrompt ?? value.triggerPrompt ?? value.trigger_prompt);
}

function clipSkillTestPromptBlock(value: any, maxLength = MAX_SKILL_TESTING_DOC_PROMPT_LENGTH) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 16)).trimEnd()}\n...[truncated]`;
}

function stringifySkillTestPromptJson(value: any, maxLength = 5000) {
  try {
    return clipSkillTestPromptBlock(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return '';
  }
}

export function buildSkillTestRunPrompt(testCase: any, skill: any = null) {
  const userPrompt = getCanonicalCasePrompt(testCase);
  if (!userPrompt) {
    return '';
  }

  const loadingMode = String(testCase && testCase.loadingMode || 'dynamic').trim().toLowerCase() || 'dynamic';
  const testType = String(testCase && testCase.testType || 'trigger').trim().toLowerCase() || 'trigger';
  const expectedBehavior = clipSkillTestPromptBlock(testCase && testCase.expectedBehavior, 1200);
  const expectedGoal = clipSkillTestPromptBlock(testCase && testCase.expectedGoal, 1200);
  const note = clipSkillTestPromptBlock(testCase && testCase.note, 800);
  const expectedSteps = Array.isArray(testCase && testCase.expectedSteps) ? testCase.expectedSteps : [];
  const expectedStepsJson = expectedSteps.length > 0 ? stringifySkillTestPromptJson(expectedSteps, 5000) : '';
  const environmentConfig = testCase && testCase.environmentConfig && typeof testCase.environmentConfig === 'object'
    ? testCase.environmentConfig
    : null;
  const environmentConfigJson = environmentConfig && Object.keys(environmentConfig).length > 0
    ? stringifySkillTestPromptJson(environmentConfig, 4000)
    : '';
  const testingDocument = readSkillTestingDocument(skill);
  const testingDocContent = testingDocument && testingDocument.exists && !testingDocument.readError
    ? clipSkillTestPromptBlock(testingDocument.content, MAX_SKILL_TESTING_DOC_PROMPT_LENGTH)
    : '';
  const sections = [
    '[Skill Test Run Contract]',
    'This is a CAFF skill-test run. Follow the target skill and the test contract below.',
    `Loading mode: ${loadingMode}`,
    `Test type: ${testType}`,
  ];

  if (loadingMode === 'full' || testType === 'execution') {
    sections.push('When Expected Goal or Expected Steps are present, treat them as the authoritative completion target. Do not stop at a lighter review-only or analysis-only interpretation of the short user prompt.');
  }
  if (expectedGoal) {
    sections.push(`Expected Goal:\n${expectedGoal}`);
  }
  if (expectedBehavior) {
    sections.push(`Expected Behavior:\n${expectedBehavior}`);
  }
  if (expectedStepsJson) {
    sections.push(`Expected Steps:\n${expectedStepsJson}`);
  }
  if (note) {
    sections.push(`Case Note:\n${note}`);
  }
  if (environmentConfigJson) {
    sections.push(`Structured Environment Config:\n${environmentConfigJson}`);
  }
  if (testingDocContent) {
    sections.push(`Target skill TESTING.md (full content):\n${testingDocContent}`);
  } else if (testingDocument && testingDocument.path) {
    sections.push(`Target skill TESTING.md: not found at ${normalizePathForJson(testingDocument.path)}`);
  }
  sections.push('If TESTING.md lacks an explicit setup detail, do not invent one. Use the document as human-readable contract/context and surface missing gaps honestly through your behavior.');
  sections.push('[User Task]');
  sections.push(userPrompt);
  return sections.join('\n\n');
}
