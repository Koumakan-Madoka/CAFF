import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { extractSystemModelVisibleText } from './system-model-output';

export const CONVERSATION_DIGEST_SUBMISSION_TOOL_NAME = 'submit_conversation_digest';
export const RECOVERY_NOTE_SUBMISSION_TOOL_NAME = 'submit_recovery_note';
export const RECOVERY_NOTE_NON_EXECUTION_STATEMENT = '这是只读现场整理，不会执行或重放原任务。';

const digestItem = Type.String({ minLength: 1, maxLength: 240 });
const digestItems = Type.Array(digestItem, { maxItems: 8 });
const digestExperienceItems = Type.Array(Type.Object({
  sourceDraftId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  title: Type.String({ minLength: 1, maxLength: 240 }),
  category: Type.String({ minLength: 1, maxLength: 80 }),
  scenario: Type.String({ maxLength: 240 }),
  steps: Type.Array(digestItem, { maxItems: 5 }),
  pitfalls: Type.Array(digestItem, { maxItems: 5 }),
  validation: Type.Array(digestItem, { maxItems: 5 }),
  artifacts: Type.Array(digestItem, { maxItems: 5 }),
  confidence: Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
  ]),
}, { additionalProperties: false }), { maxItems: 5 });

export const CONVERSATION_DIGEST_SUBMISSION_TOOL = {
  name: CONVERSATION_DIGEST_SUBMISSION_TOOL_NAME,
  description: 'Submit the complete bounded conversation digest. This schema-only return channel performs no action.',
  parameters: Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 800 }),
    facts: digestItems,
    decisions: digestItems,
    openQuestions: digestItems,
    nextActions: digestItems,
    artifacts: digestItems,
    experience: digestExperienceItems,
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema' as const, strict: 'prefer' as const },
};

const recoveryItems = Type.Array(
  Type.String({ minLength: 1, maxLength: 200 }),
  { maxItems: 5 }
);

export const RECOVERY_NOTE_SUBMISSION_TOOL = {
  name: RECOVERY_NOTE_SUBMISSION_TOOL_NAME,
  description: 'Submit six bounded evidence sections for a read-only recovery note. This schema-only return channel performs no action.',
  parameters: Type.Object({
    alreadyCompleted: recoveryItems,
    failureLocation: recoveryItems,
    possiblyEffective: recoveryItems,
    notCompleted: recoveryItems,
    recoveryPoint: recoveryItems,
    unknown: recoveryItems,
  }, { additionalProperties: false }),
  constrainedSampling: { type: 'json_schema' as const, strict: 'prefer' as const },
};

const validators = new WeakMap<object, ReturnType<typeof Compile>>();

function normalizeContentType(value: any) {
  return typeof value === 'string'
    ? value.replace(/[_-]/gu, '').trim().toLowerCase()
    : '';
}

function isPlainObject(value: any) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assistantMessage(output: any) {
  return output && (output.message || output.assistantMessage || output);
}

function validatorFor(tool: any) {
  const parameters = tool && tool.parameters;
  if (!parameters || typeof parameters !== 'object') {
    throw new SystemModelSubmissionError('submission_tool_schema_missing', 'System model submission tool schema is unavailable');
  }

  let validator = validators.get(parameters);
  if (!validator) {
    validator = Compile(parameters);
    validators.set(parameters, validator);
  }
  return validator;
}

function firstValidationIssue(validator: ReturnType<typeof Compile>, value: any) {
  const first = validator.Errors(value)[0];
  if (!first) {
    return '';
  }
  const message = typeof first.message === 'string' ? first.message : 'schema validation failed';
  return message;
}

export class SystemModelSubmissionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SystemModelSubmissionError';
    this.code = code;
  }
}

export function extractSingleSystemModelSubmission(output: any, tool: any) {
  const message = assistantMessage(output);
  const content = Array.isArray(message && message.content) ? message.content : [];
  const visibleText = extractSystemModelVisibleText(output);
  const toolCalls = content.filter((item: any) => normalizeContentType(item && item.type) === 'toolcall');

  if (visibleText) {
    throw new SystemModelSubmissionError(
      'submission_visible_text_not_allowed',
      'System model submission included visible text outside the tool call'
    );
  }
  if (toolCalls.length !== 1) {
    throw new SystemModelSubmissionError(
      'submission_call_count_invalid',
      `System model submission requires exactly one tool call; received ${toolCalls.length}`
    );
  }

  const toolCall = toolCalls[0];
  if (String(toolCall && toolCall.name || '').trim() !== tool.name) {
    throw new SystemModelSubmissionError(
      'submission_tool_name_invalid',
      `System model submission called an unexpected tool; expected ${tool.name}`
    );
  }
  if (!isPlainObject(toolCall.arguments)) {
    throw new SystemModelSubmissionError(
      'submission_arguments_invalid',
      'System model submission arguments must be an object'
    );
  }

  const validator = validatorFor(tool);
  if (!validator.Check(toolCall.arguments)) {
    const issue = firstValidationIssue(validator, toolCall.arguments);
    throw new SystemModelSubmissionError(
      'submission_schema_invalid',
      `System model submission arguments failed schema validation${issue ? `: ${issue}` : ''}`
    );
  }

  return toolCall.arguments;
}

function normalizeRecoveryLine(value: any) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

export function renderRecoveryNote(submission: any) {
  const sections = [
    ['已经完成', submission.alreadyCompleted],
    ['失败位置', submission.failureLocation],
    ['可能已生效但需核验', submission.possiblyEffective],
    ['尚未完成', submission.notCompleted],
    ['建议恢复点', submission.recoveryPoint],
    ['无法从现场判断', submission.unknown],
  ];
  const lines = [
    '## 执行异常后的现场摘要',
    '',
    `> ${RECOVERY_NOTE_NON_EXECUTION_STATEMENT}原失败 Trace 保持 failed。`,
  ];

  for (const [heading, rawItems] of sections) {
    const items = (Array.isArray(rawItems) ? rawItems : [])
      .map(normalizeRecoveryLine)
      .filter(Boolean);
    lines.push('', `### ${heading}`, ...(items.length > 0 ? items.map((item) => `- ${item}`) : ['- 无。']));
  }

  return lines.join('\n');
}
