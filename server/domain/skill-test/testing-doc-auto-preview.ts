import { buildTestingDocDraftFromSkillContext } from './testing-doc-draft';
import { buildTestingDocContractSummary } from './testing-doc-target';

export const AUTO_TESTING_DOC_PREVIEW_MESSAGE_ID = 'auto-testing-doc-preview';

function normalizeText(value: any) {
  return String(value || '').trim();
}

function isPlainObject(value: any) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExistingTestingDocDraft(value: any) {
  return Boolean(isPlainObject(value) && normalizeText(value.draftId));
}

export function buildAutomaticTestingDocPreviewState(skill: any, designState: any, options: any = {}) {
  const environmentContract = skill ? buildTestingDocContractSummary(skill) : null;
  const currentState = isPlainObject(designState) ? designState : {};
  const currentDraft = currentState.testingDocDraft;

  if (!skill || !environmentContract || hasExistingTestingDocDraft(currentDraft)) {
    return {
      created: false,
      draft: hasExistingTestingDocDraft(currentDraft) ? currentDraft : null,
      environmentContract,
      nextState: currentState,
    };
  }

  if (environmentContract.exists || normalizeText(environmentContract.status) !== 'missing') {
    return {
      created: false,
      draft: null,
      environmentContract,
      nextState: currentState,
    };
  }

  const createdAt = normalizeText(options.createdAt) || new Date().toISOString();
  const draft = buildTestingDocDraftFromSkillContext(skill, {
    skillId: normalizeText(currentState.skillId || skill.id),
    conversationId: normalizeText(options.conversationId),
    messageId: normalizeText(options.messageId) || AUTO_TESTING_DOC_PREVIEW_MESSAGE_ID,
    agentRole: normalizeText(options.agentRole) || 'system',
    createdBy: normalizeText(options.createdBy) || 'system',
    createdAt,
    fileExistsAtPreview: false,
    fileHashAtPreview: '',
    fileSizeAtPreview: 0,
    status: 'proposed',
  });
  const nextEnvironmentContract = {
    ...environmentContract,
    autoPreviewedAt: createdAt,
    autoPreviewDraftId: draft.draftId,
  };

  return {
    created: true,
    draft,
    environmentContract: nextEnvironmentContract,
    nextState: {
      ...currentState,
      testingDocDraft: draft,
      environmentContract: nextEnvironmentContract,
    },
  };
}
