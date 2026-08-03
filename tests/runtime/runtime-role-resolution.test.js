const assert = require('node:assert/strict');
const test = require('node:test');

const { createRoleService } = require('../../build/server/domain/roles/role-service');

function modelOption(provider, model, family, supportedThinkingLevels = ['off', 'low', 'high']) {
  return {
    key: `${provider}\u001f${model}`,
    provider,
    model,
    label: `${provider} / ${model}`,
    source: 'runtime_registry',
    sourceLabel: 'runtime registry',
    family,
    familySource: 'explicit',
    supportedThinkingLevels,
  };
}

function createService(roles, getOptions) {
  return createRoleService({
    store: {
      listAgents() {
        return structuredClone(roles);
      },
      normalizeConversationParticipantsInput(input) {
        return input.participants.map((participant) => ({
          agentId: participant.agentId,
          modelProfileId: participant.modelProfileId || null,
          conversationSkills: participant.conversationSkillIds || [],
        }));
      },
    },
    modelCatalog: { getOptions },
    resolveRuntimeDefaults() {
      return {
        provider: 'runtime-provider',
        model: 'runtime-model',
        thinking: 'low',
      };
    },
  });
}

test('runtime role resolution uses exact family profiles, preserves custom fallback, and strips family Persona inputs', () => {
  const roles = [
    {
      id: 'role-family-gpt',
      name: 'GPT',
      roleKind: 'model_family',
      modelFamily: 'gpt',
      provider: 'openai',
      model: 'gpt-base',
      thinking: 'low',
      personaPrompt: 'must never reach a family prompt',
      skillIds: ['family-persona-skill'],
      modelProfiles: [
        {
          id: 'deep',
          name: 'Deep',
          provider: 'openai',
          model: 'gpt-deep',
          thinking: 'high',
          personaPrompt: 'profile persona must never reach a family prompt',
        },
      ],
    },
    {
      id: 'custom-reviewer',
      name: 'Reviewer',
      roleKind: 'custom',
      modelFamily: null,
      provider: '',
      model: '',
      thinking: '',
      personaPrompt: 'Base custom persona',
      skillIds: ['custom-persona-skill'],
      modelProfiles: [],
    },
    {
      id: 'custom-profiled',
      name: 'Profiled Reviewer',
      roleKind: 'custom',
      modelFamily: null,
      provider: 'anthropic',
      model: 'claude-base',
      thinking: 'low',
      personaPrompt: 'Base custom persona',
      skillIds: ['custom-persona-skill'],
      modelProfiles: [
        {
          id: 'careful',
          name: 'Careful',
          provider: 'anthropic',
          model: 'claude-careful',
          thinking: 'high',
          personaPrompt: 'Profile custom persona',
        },
      ],
    },
  ];
  const options = [
    modelOption('openai', 'gpt-base', 'gpt'),
    modelOption('openai', 'gpt-deep', 'gpt'),
    modelOption('runtime-provider', 'runtime-model', null),
    modelOption('anthropic', 'claude-base', 'claude'),
    modelOption('anthropic', 'claude-careful', 'claude'),
  ];
  const service = createService(roles, () => options);

  const resolved = service.resolveRuntimeParticipants([
    {
      id: 'role-family-gpt',
      selectedModelProfileId: 'deep',
      conversationSkillIds: ['room-skill'],
    },
    {
      id: 'custom-reviewer',
      selectedModelProfileId: null,
      conversationSkillIds: ['room-skill'],
    },
    {
      id: 'custom-profiled',
      selectedModelProfileId: 'careful',
      conversationSkillIds: [],
    },
  ]);

  assert.deepEqual(resolved[0].runtimeConfig, {
    profileId: 'deep',
    profileName: 'Deep',
    provider: 'openai',
    model: 'gpt-deep',
    thinking: 'high',
    personaPrompt: '',
    skillIds: [],
  });
  assert.deepEqual(resolved[0].conversationSkillIds, ['room-skill']);
  assert.deepEqual(resolved[1].runtimeConfig, {
    profileId: null,
    profileName: 'Default',
    provider: 'runtime-provider',
    model: 'runtime-model',
    thinking: '',
    personaPrompt: 'Base custom persona',
    skillIds: ['custom-persona-skill'],
  });
  assert.equal(resolved[2].runtimeConfig.personaPrompt, 'Profile custom persona');
  assert.equal(resolved[2].runtimeConfig.model, 'claude-careful');
});

test('runtime role resolution aggregates reclassified models, changed thinking capabilities, and stale selected profiles', () => {
  const roles = [
    {
      id: 'role-family-gpt',
      name: 'GPT',
      roleKind: 'model_family',
      modelFamily: 'gpt',
      provider: 'openai',
      model: 'gpt-live',
      thinking: 'low',
      modelProfiles: [],
    },
    {
      id: 'role-family-qwen',
      name: 'Qwen',
      roleKind: 'model_family',
      modelFamily: 'qwen',
      provider: 'qwen',
      model: 'qwen-live',
      thinking: 'high',
      modelProfiles: [],
    },
    {
      id: 'custom-stale-profile',
      name: 'Custom',
      roleKind: 'custom',
      modelFamily: null,
      provider: 'runtime-provider',
      model: 'runtime-model',
      thinking: 'low',
      personaPrompt: 'Custom persona',
      skillIds: [],
      modelProfiles: [],
    },
  ];
  let options = [
    modelOption('openai', 'gpt-live', 'gpt'),
    modelOption('qwen', 'qwen-live', 'qwen', ['off', 'high']),
    modelOption('runtime-provider', 'runtime-model', null),
  ];
  const service = createService(roles, () => options);

  options = [
    modelOption('openai', 'gpt-live', 'claude'),
    modelOption('openai', 'gpt-other', 'gpt'),
    modelOption('qwen', 'qwen-live', 'qwen', ['off']),
    modelOption('runtime-provider', 'runtime-model', null),
  ];

  assert.throws(
    () => service.resolveRuntimeParticipants([
      { id: 'role-family-gpt', selectedModelProfileId: null },
      { id: 'role-family-qwen', selectedModelProfileId: null },
      { id: 'custom-stale-profile', selectedModelProfileId: 'deleted-profile' },
    ]),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'conversation_participants_unavailable');
      assert.equal(error.issues.length, 3);
      assert.deepEqual(
        error.issues.map((issue) => [issue.roleId, issue.availability.status]),
        [
          ['role-family-gpt', 'default_model_out_of_family'],
          ['role-family-qwen', 'thinking_level_unsupported'],
          ['custom-stale-profile', 'profile_missing'],
        ]
      );
      assert.ok(error.issues.every((issue) => Array.isArray(issue.recoveryActions) && issue.recoveryActions.length > 0));
      return true;
    }
  );
});

test('runtime role resolution lets an existing participant recover through a valid selected profile', () => {
  const roles = [{
    id: 'role-family-gpt',
    name: 'GPT',
    roleKind: 'model_family',
    modelFamily: 'gpt',
    provider: 'openai',
    model: 'gpt-base-missing',
    thinking: 'low',
    modelProfiles: [{
      id: 'recovery',
      name: 'Recovery',
      provider: 'openai',
      model: 'gpt-recovery',
      thinking: 'high',
    }],
  }];
  const options = [modelOption('openai', 'gpt-recovery', 'gpt')];
  const service = createService(roles, () => options);

  assert.equal(service.getDirectory().agents[0].availability.status, 'default_model_missing');
  assert.throws(
    () => service.validateConversationParticipants({
      participants: [{ agentId: 'role-family-gpt', modelProfileId: 'recovery' }],
    }),
    (error) => error && error.statusCode === 422 && error.issues[0].code === 'participant_role_unavailable'
  );

  const validated = service.validateConversationParticipants({
    participants: [{ agentId: 'role-family-gpt', modelProfileId: 'recovery' }],
  }, { recoverableRoleIds: new Set(['role-family-gpt']) });
  assert.equal(validated[0].modelProfileId, 'recovery');

  const resolved = service.resolveRuntimeParticipants([{
    id: 'role-family-gpt',
    selectedModelProfileId: 'recovery',
  }]);
  assert.equal(resolved[0].runtimeConfig.model, 'gpt-recovery');
  assert.equal(resolved[0].runtimeConfig.profileId, 'recovery');
});
