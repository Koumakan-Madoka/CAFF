const assert = require('node:assert/strict');
const test = require('node:test');

const { createConfiguredModelCatalog } = require('../../build/server/domain/models/configured-model-catalog');
const { createRoleService } = require('../../build/server/domain/roles/role-service');

function modelOption(provider, model, family, supportedThinkingLevels = ['off', 'low', 'high']) {
  return {
    key: `${provider}\u001f${model}`,
    provider,
    model,
    label: `${provider} / ${model}`,
    source: 'models_json',
    sourceLabel: 'models.json',
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
      getAgent(roleId) {
        return structuredClone(roles.find((role) => role.id === roleId) || null);
      },
      getRoleIdentity() {
        return null;
      },
      saveCustomRoleConfig(candidate) {
        const index = roles.findIndex((role) => role.id === candidate.id);
        if (index === -1) roles.push(structuredClone(candidate));
        else roles[index] = structuredClone(candidate);
        return structuredClone(candidate);
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

test('registry-only models make existing roles explicitly unavailable instead of leaking into the directory', () => {
  const catalog = createConfiguredModelCatalog({
    loadRuntimeModels: () => [{
      provider: 'moonshotai',
      id: 'kimi-k2.5',
      name: 'Kimi K2.5',
      supportedThinkingLevels: ['off', 'low', 'high'],
    }],
    readProviderDocument: () => ({ providers: {} }),
    readRuntimeDefault: () => ({ provider: '', model: '' }),
  });
  const service = createService([{
    id: 'role-family-kimi',
    name: 'Kimi',
    roleKind: 'model_family',
    modelFamily: 'kimi',
    provider: 'moonshotai',
    model: 'kimi-k2.5',
    thinking: 'low',
    modelProfiles: [],
  }], () => catalog.getOptions());

  assert.equal(catalog.getOptions().some((option) => option.model === 'kimi-k2.5'), false);
  assert.deepEqual(service.getDirectory().agents[0].availability, {
    status: 'no_family_models',
    familyModelCount: 0,
  });
  assert.throws(
    () => service.validateConversationParticipants({
      participants: [{ agentId: 'role-family-kimi', modelProfileId: null }],
    }),
    (error) => error && error.statusCode === 422 && error.issues[0].code === 'participant_role_unavailable'
  );
});

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

test('platform recovery scribe is excluded from the role directory and rejected as a participant', () => {
  const roles = [
    {
      id: 'recovery_scribe',
      name: '系统书记',
      roleKind: 'custom',
      provider: 'openai',
      model: 'gpt-live',
      thinking: 'low',
      modelProfiles: [],
    },
    {
      id: 'legacy-scribe-impersonator',
      name: 'Recovery_Scribe',
      roleKind: 'custom',
      provider: 'openai',
      model: 'gpt-live',
      thinking: 'low',
      modelProfiles: [],
    },
    {
      id: 'regular-agent',
      name: 'Regular Agent',
      roleKind: 'custom',
      provider: 'openai',
      model: 'gpt-live',
      thinking: 'low',
      modelProfiles: [],
    },
  ];
  const service = createService(roles, () => [modelOption('openai', 'gpt-live', 'gpt')]);

  assert.deepEqual(service.getDirectory().agents.map((role) => role.id), ['regular-agent']);
  assert.throws(
    () => service.validateConversationParticipants({
      participants: [{ agentId: 'recovery_scribe' }],
    }),
    (error) => error
      && error.statusCode === 422
      && error.code === 'participant_system_actor_not_routable'
  );
  assert.throws(
    () => service.resolveRuntimeParticipants([{ id: 'recovery_scribe' }]),
    (error) => error
      && error.statusCode === 409
      && error.issues[0].code === 'participant_system_actor_not_routable'
  );
  assert.throws(
    () => service.createCustomRole({ id: 'recovery_scribe', name: 'Ordinary Scribe' }),
    (error) => error
      && error.statusCode === 422
      && error.code === 'role_identity_not_reusable'
  );
  assert.throws(
    () => service.createCustomRole({ id: 'ordinary-scribe', name: 'Recovery Scribe' }),
    (error) => error
      && error.statusCode === 422
      && error.code === 'role_name_reserved'
  );
  assert.throws(
    () => service.createCustomRole({ id: 'ordinary-scribe-cn', name: '系统书记' }),
    (error) => error
      && error.statusCode === 422
      && error.code === 'role_name_reserved'
  );
  assert.throws(
    () => service.createCustomRole({ id: 'ordinary-scribe-alias', name: 'Recovery-Scribe' }),
    (error) => error
      && error.statusCode === 422
      && error.code === 'role_name_reserved'
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
