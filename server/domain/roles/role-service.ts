import { buildConfiguredModelKey } from '../models/configured-model-catalog';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  resolveSetting,
} from '../../../lib/minimal-pi';
import {
  LEGACY_SYSTEM_ROLE_IDS,
  SYSTEM_MODEL_FAMILY_ROLE_IDS,
} from './system-role-catalog';

const SYSTEM_ROLE_ID_SET = new Set(SYSTEM_MODEL_FAMILY_ROLE_IDS);
const RESERVED_ROLE_ID_SET = new Set([
  ...SYSTEM_MODEL_FAMILY_ROLE_IDS,
  ...LEGACY_SYSTEM_ROLE_IDS,
]);
const FAMILY_EDITABLE_FIELDS = Object.freeze([
  'provider',
  'model',
  'thinking',
  'modelProfiles',
  'isDefaultChatRole',
]);
const CUSTOM_EDITABLE_FIELDS = Object.freeze([
  'name',
  'description',
  'sandboxName',
  'avatarDataUrl',
  'personaPrompt',
  'provider',
  'model',
  'thinking',
  'accentColor',
  'skillIds',
  'modelProfiles',
  'isDefaultChatRole',
]);
const FAMILY_UPDATE_FIELD_SET = new Set(FAMILY_EDITABLE_FIELDS);
const FAMILY_RUNTIME_FIELD_SET = new Set(['provider', 'model', 'thinking', 'modelProfiles']);

function normalize(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOwn(value: any, key: string) {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function createRoleError(
  statusCode: number,
  code: string,
  message: string,
  path = '',
  details: Record<string, unknown> = {}
) {
  const error: any = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.issues = [{
    code,
    message,
    ...(path ? { path } : {}),
    ...details,
  }];
  return error;
}

function roleNotFound(roleId: string) {
  return createRoleError(404, 'role_not_found', `Role not found: ${roleId}`);
}

function buildCatalogIndex(modelOptions: any[]) {
  const byKey = new Map<string, any>();
  const byModel = new Map<string, any[]>();

  for (const option of Array.isArray(modelOptions) ? modelOptions : []) {
    const provider = normalize(option?.provider);
    const model = normalize(option?.model);
    if (!model) {
      continue;
    }
    const key = normalize(option?.key) || buildConfiguredModelKey(provider, model);
    const normalizedOption = {
      ...option,
      key,
      provider,
      model,
      supportedThinkingLevels: Array.isArray(option?.supportedThinkingLevels)
        ? option.supportedThinkingLevels.map(normalize).filter(Boolean)
        : ['off'],
    };
    byKey.set(key, normalizedOption);
    const matchingModels = byModel.get(model) || [];
    matchingModels.push(normalizedOption);
    byModel.set(model, matchingModels);
  }

  return { byKey, byModel };
}

function findExactCatalogOption(catalog: any, provider: any, model: any) {
  const normalizedModel = normalize(model);
  if (!normalizedModel) {
    return null;
  }
  return catalog.byKey.get(buildConfiguredModelKey(provider, normalizedModel)) || null;
}

function resolveConfiguredModel(
  catalog: any,
  provider: any,
  model: any,
  path: string,
  expectedFamily: string | null
) {
  const normalizedProvider = normalize(provider);
  const normalizedModel = normalize(model);

  if (!normalizedModel) {
    throw createRoleError(422, 'model_not_configured', 'A configured model is required', path);
  }

  let option = findExactCatalogOption(catalog, normalizedProvider, normalizedModel);
  const modelMatches = catalog.byModel.get(normalizedModel) || [];

  if (!option && !normalizedProvider && modelMatches.length === 1) {
    option = modelMatches[0];
  }

  if (!option) {
    const code = modelMatches.length > 0 ? 'provider_model_mismatch' : 'model_not_configured';
    const message = code === 'provider_model_mismatch'
      ? 'Provider does not match the configured model option'
      : 'Model is not present in the configured model catalog';
    throw createRoleError(422, code, message, path, {
      modelKey: buildConfiguredModelKey(normalizedProvider, normalizedModel),
    });
  }

  if (expectedFamily && option.family !== expectedFamily) {
    throw createRoleError(422, 'model_out_of_family', 'Model does not belong to this role family', path, {
      expectedFamily,
      actualFamily: option.family || null,
      modelKey: option.key,
    });
  }

  return option;
}

function assertThinkingSupported(option: any, thinking: any, path: string) {
  const normalizedThinking = normalize(thinking);
  if (!normalizedThinking) {
    return '';
  }
  const supported = new Set(
    Array.isArray(option?.supportedThinkingLevels)
      ? option.supportedThinkingLevels.map(normalize).filter(Boolean)
      : []
  );
  if (!supported.has(normalizedThinking)) {
    throw createRoleError(
      422,
      'thinking_level_unsupported',
      'Thinking level is not supported by the selected model',
      path,
      {
        modelKey: option?.key || '',
        supportedThinkingLevels: [...supported],
      }
    );
  }
  return normalizedThinking;
}

function normalizeProfiles(
  profiles: any,
  catalog: any,
  roleKind: 'model_family' | 'custom',
  expectedFamily: string | null
) {
  const normalizedProfiles = [];

  for (const [index, profile] of (Array.isArray(profiles) ? profiles : []).entries()) {
    if (!profile || typeof profile !== 'object') {
      continue;
    }
    if (roleKind === 'model_family' && hasOwn(profile, 'personaPrompt')) {
      throw createRoleError(
        422,
        'family_persona_not_allowed',
        'Model-family profiles cannot define Persona prompts',
        `modelProfiles[${index}].personaPrompt`
      );
    }
    const option = resolveConfiguredModel(
      catalog,
      profile.provider,
      profile.model,
      `modelProfiles[${index}].model`,
      expectedFamily
    );
    const thinking = assertThinkingSupported(
      option,
      profile.thinking,
      `modelProfiles[${index}].thinking`
    );
    const id = normalize(profile.id) || `profile-${index + 1}`;
    const name = normalize(profile.name) || option.model || `Profile ${index + 1}`;
    normalizedProfiles.push({
      id,
      name,
      description: normalize(profile.description),
      provider: option.provider,
      model: option.model,
      thinking,
      personaPrompt: roleKind === 'custom' ? normalize(profile.personaPrompt) : '',
    });
  }

  return normalizedProfiles;
}

function roleAvailability(role: any, modelOptions: any[], catalog: any) {
  const roleKind = role?.roleKind === 'model_family' ? 'model_family' : 'custom';
  const expectedFamily = roleKind === 'model_family' ? normalize(role?.modelFamily) : null;
  const familyOptions = expectedFamily
    ? modelOptions.filter((option) => option?.family === expectedFamily)
    : [];
  const familyModelCount = familyOptions.length;

  if (expectedFamily && familyModelCount === 0) {
    return { status: 'no_family_models', familyModelCount: 0 };
  }

  const baseModel = normalize(role?.model);
  if (baseModel) {
    const option = findExactCatalogOption(catalog, role?.provider, baseModel);
    if (!option) {
      return { status: 'default_model_missing', familyModelCount };
    }
    if (expectedFamily && option.family !== expectedFamily) {
      return {
        status: 'default_model_out_of_family',
        familyModelCount,
        modelKey: option.key,
      };
    }
    const thinking = normalize(role?.thinking);
    if (thinking && !option.supportedThinkingLevels.includes(thinking)) {
      return {
        status: 'thinking_level_unsupported',
        familyModelCount,
        modelKey: option.key,
      };
    }
  } else if (expectedFamily || normalize(role?.provider) || normalize(role?.thinking)) {
    return { status: 'default_model_missing', familyModelCount };
  }

  for (const profile of Array.isArray(role?.modelProfiles) ? role.modelProfiles : []) {
    const option = findExactCatalogOption(catalog, profile?.provider, profile?.model);
    if (!option) {
      return {
        status: 'profile_model_missing',
        familyModelCount,
        profileId: normalize(profile?.id),
      };
    }
    if (expectedFamily && option.family !== expectedFamily) {
      return {
        status: 'profile_model_out_of_family',
        familyModelCount,
        profileId: normalize(profile?.id),
      };
    }
    const thinking = normalize(profile?.thinking);
    if (thinking && !option.supportedThinkingLevels.includes(thinking)) {
      return {
        status: 'thinking_level_unsupported',
        familyModelCount,
        modelKey: option.key,
        profileId: normalize(profile?.id),
      };
    }
  }

  return { status: 'available', familyModelCount };
}

function projectRole(role: any, modelOptions: any[], catalog: any) {
  const systemManaged = role?.roleKind === 'model_family';
  return {
    ...role,
    systemManaged,
    availability: roleAvailability(role, modelOptions, catalog),
    editableFields: systemManaged ? [...FAMILY_EDITABLE_FIELDS] : [...CUSTOM_EDITABLE_FIELDS],
  };
}

function runtimeRecoveryActions(availability: any) {
  const status = normalize(availability?.status);

  if (status === 'profile_missing' || status.startsWith('profile_')) {
    return ['select_valid_profile', 'repair_role_profiles', 'remove_participant'];
  }
  if (status === 'thinking_level_unsupported') {
    return ['repair_role_thinking', 'select_valid_profile', 'remove_participant'];
  }
  return ['repair_role_model', 'repair_provider_configuration', 'remove_participant'];
}

function runtimeParticipantIssue(index: number, role: any, availability: any, profileId = '') {
  const normalizedProfileId = normalize(profileId);
  const profileMissing = availability?.status === 'profile_missing';

  return {
    code: profileMissing ? 'participant_profile_invalid' : 'participant_role_unavailable',
    message: profileMissing
      ? 'Selected model profile no longer exists for this role'
      : 'Conversation participant role is not currently runnable',
    path: profileMissing
      ? `participants[${index}].modelProfileId`
      : `participants[${index}].agentId`,
    roleId: normalize(role?.id),
    roleName: normalize(role?.name),
    ...(normalizedProfileId ? { profileId: normalizedProfileId } : {}),
    availability,
    recoveryActions: runtimeRecoveryActions(availability),
  };
}

function createRuntimeParticipantsError(issues: any[]) {
  const error: any = new Error('Conversation participants are not currently runnable');
  error.statusCode = 409;
  error.code = 'conversation_participants_unavailable';
  error.issues = issues;
  return error;
}

export function createRoleService(options: any = {}) {
  const store = options.store;
  const modelCatalog = options.modelCatalog;

  if (!store || typeof store.listAgents !== 'function') {
    throw new Error('RoleService requires a chat store');
  }
  if (!modelCatalog || typeof modelCatalog.getOptions !== 'function') {
    throw new Error('RoleService requires a configured model catalog');
  }
  const resolveRuntimeDefaults = typeof options.resolveRuntimeDefaults === 'function'
    ? options.resolveRuntimeDefaults
    : () => ({
        provider: resolveSetting('', process.env.PI_PROVIDER, DEFAULT_PROVIDER),
        model: resolveSetting('', process.env.PI_MODEL, DEFAULT_MODEL),
      });

  function getDirectory() {
    const modelOptions = modelCatalog.getOptions();
    const catalog = buildCatalogIndex(modelOptions);
    return {
      agents: store.listAgents().map((role: any) => projectRole(role, modelOptions, catalog)),
      modelOptions,
    };
  }

  function validateConversationParticipants(input: any = {}) {
    const normalizedParticipants = Array.isArray(input)
      ? store.normalizeConversationParticipants(input)
      : store.normalizeConversationParticipantsInput(input);
    const directory = getDirectory();
    const rolesById = new Map(directory.agents.map((role: any) => [role.id, role]));

    for (const [index, participant] of normalizedParticipants.entries()) {
      const role: any = rolesById.get(participant.agentId);
      if (!role || role.availability?.status !== 'available') {
        throw createRoleError(
          422,
          'participant_role_unavailable',
          'Conversation participant role is not currently runnable',
          `participants[${index}].agentId`,
          {
            roleId: participant.agentId,
            roleName: normalize(role?.name),
            availability: role?.availability || { status: 'role_missing' },
          }
        );
      }
    }

    return normalizedParticipants;
  }

  function resolveRuntimeParticipants(participants: any) {
    const requestedParticipants = Array.isArray(participants) ? participants : [];
    const directory = getDirectory();
    const rolesById = new Map(directory.agents.map((role: any) => [role.id, role]));
    const catalog = buildCatalogIndex(directory.modelOptions);
    const blockers = [] as any[];
    const resolved = [] as any[];
    const runtimeDefaults = resolveRuntimeDefaults() || {};

    for (const [index, participant] of requestedParticipants.entries()) {
      const roleId = normalize(participant?.id || participant?.agentId);
      const role: any = rolesById.get(roleId);
      if (!role) {
        blockers.push(runtimeParticipantIssue(index, { id: roleId, name: normalize(participant?.name) }, {
          status: 'role_missing',
        }));
        continue;
      }

      const selectedProfileId = normalize(
        participant?.selectedModelProfileId || participant?.modelProfileId || participant?.selectedModelProfile?.id
      );
      const selectedProfile = selectedProfileId
        ? (Array.isArray(role.modelProfiles) ? role.modelProfiles : []).find(
            (profile: any) => normalize(profile?.id) === selectedProfileId
          ) || null
        : null;

      if (selectedProfileId && !selectedProfile) {
        blockers.push(runtimeParticipantIssue(index, role, {
          status: 'profile_missing',
          profileId: selectedProfileId,
        }, selectedProfileId));
        continue;
      }

      if (role.availability?.status !== 'available') {
        blockers.push(runtimeParticipantIssue(index, role, role.availability, selectedProfileId));
        continue;
      }

      const roleKind = role.roleKind === 'model_family' ? 'model_family' : 'custom';
      const effectiveSource = selectedProfile || role;
      let provider = normalize(effectiveSource?.provider);
      let model = normalize(effectiveSource?.model);
      const thinking = normalize(effectiveSource?.thinking);

      if (roleKind === 'custom' && !model) {
        provider = normalize(runtimeDefaults.provider);
        model = normalize(runtimeDefaults.model);
      }

      try {
        const option = resolveConfiguredModel(
          catalog,
          provider,
          model,
          selectedProfileId ? `participants[${index}].modelProfileId` : `participants[${index}].agentId`,
          roleKind === 'model_family' ? normalize(role.modelFamily) : null
        );
        const canonicalThinking = assertThinkingSupported(
          option,
          thinking,
          selectedProfileId ? `participants[${index}].modelProfileId` : `participants[${index}].agentId`
        );
        const participantConversationSkillIds = Array.isArray(
          participant?.conversationSkillIds || participant?.conversationSkills
        )
          ? participant.conversationSkillIds || participant.conversationSkills
          : [];

        resolved.push({
          ...participant,
          ...role,
          id: role.id,
          name: role.name,
          selectedModelProfileId: selectedProfileId || null,
          selectedModelProfile: selectedProfile,
          conversationSkillIds: [...participantConversationSkillIds],
          conversationSkills: [...participantConversationSkillIds],
          runtimeConfig: {
            profileId: selectedProfileId || null,
            profileName: selectedProfile ? normalize(selectedProfile.name) || 'Profile' : 'Default',
            provider: option.provider,
            model: option.model,
            thinking: canonicalThinking,
            personaPrompt: roleKind === 'model_family'
              ? ''
              : normalize(selectedProfile ? selectedProfile.personaPrompt : role.personaPrompt),
            skillIds: roleKind === 'model_family'
              ? []
              : [...(Array.isArray(role.skillIds || role.skills) ? role.skillIds || role.skills : [])],
          },
        });
      } catch (error) {
        const errorValue = error as any;
        const issue = Array.isArray(errorValue?.issues) ? errorValue.issues[0] : null;
        const availability = {
          status: normalize(issue?.code) || 'default_model_missing',
          ...(issue && issue.modelKey ? { modelKey: issue.modelKey } : {}),
          ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
        };
        blockers.push(runtimeParticipantIssue(index, role, availability, selectedProfileId));
      }
    }

    if (blockers.length > 0) {
      throw createRuntimeParticipantsError(blockers);
    }

    return resolved;
  }

  function mutationResult(roleId: string) {
    const directory = getDirectory();
    const agent = directory.agents.find((role: any) => role.id === roleId);
    if (!agent) {
      throw roleNotFound(roleId);
    }
    return { agent, ...directory };
  }

  function assertCustomIdentityAvailable(roleId: string) {
    if (!roleId) {
      return;
    }
    if (RESERVED_ROLE_ID_SET.has(roleId) || store.getRoleIdentity(roleId)) {
      throw createRoleError(
        422,
        'role_identity_not_reusable',
        'Role identity cannot be reused',
        'id'
      );
    }
  }

  function buildCustomCandidate(existing: any, input: any, catalog: any) {
    const source = input && typeof input === 'object' ? input : {};
    const name = hasOwn(source, 'name') ? normalize(source.name) : normalize(existing?.name);
    if (!name) {
      throw createRoleError(422, 'role_name_required', 'Role name is required', 'name');
    }
    const model = hasOwn(source, 'model') ? normalize(source.model) : normalize(existing?.model);
    const provider = hasOwn(source, 'provider') ? normalize(source.provider) : normalize(existing?.provider);
    const thinking = hasOwn(source, 'thinking') ? normalize(source.thinking) : normalize(existing?.thinking);
    let canonicalProvider = provider;
    let canonicalModel = model;
    let canonicalThinking = thinking;

    if (model) {
      const option = resolveConfiguredModel(catalog, provider, model, 'model', null);
      canonicalProvider = option.provider;
      canonicalModel = option.model;
      canonicalThinking = assertThinkingSupported(option, thinking, 'thinking');
    } else if (provider || thinking) {
      throw createRoleError(422, 'model_not_configured', 'A configured model is required', 'model');
    } else {
      canonicalProvider = '';
      canonicalModel = '';
      canonicalThinking = '';
    }

    const rawProfiles = hasOwn(source, 'modelProfiles') ? source.modelProfiles : existing?.modelProfiles;
    return {
      id: normalize(existing?.id) || normalize(source.id),
      name,
      description: hasOwn(source, 'description') ? normalize(source.description) : normalize(existing?.description),
      sandboxName: hasOwn(source, 'sandboxName') ? normalize(source.sandboxName) : normalize(existing?.sandboxName),
      avatarDataUrl: hasOwn(source, 'avatarDataUrl') ? normalize(source.avatarDataUrl) : normalize(existing?.avatarDataUrl),
      personaPrompt: hasOwn(source, 'personaPrompt') ? normalize(source.personaPrompt) : normalize(existing?.personaPrompt),
      provider: canonicalProvider,
      model: canonicalModel,
      thinking: canonicalThinking,
      accentColor: hasOwn(source, 'accentColor') ? normalize(source.accentColor) : normalize(existing?.accentColor),
      skillIds: hasOwn(source, 'skillIds')
        ? source.skillIds
        : hasOwn(source, 'skills')
          ? source.skills
          : existing?.skillIds,
      modelProfiles: normalizeProfiles(rawProfiles, catalog, 'custom', null),
      isDefaultChatRole: hasOwn(source, 'isDefaultChatRole')
        ? Boolean(source.isDefaultChatRole)
        : Boolean(existing?.isDefaultChatRole),
    };
  }

  function createCustomRole(input: any = {}) {
    const roleKind = normalize(input.roleKind);
    if ((roleKind && roleKind !== 'custom') || normalize(input.modelFamily)) {
      throw createRoleError(422, 'custom_role_only', 'POST /api/agents creates custom roles only');
    }
    const requestedId = normalize(input.id);
    assertCustomIdentityAvailable(requestedId);
    const modelOptions = modelCatalog.getOptions();
    const catalog = buildCatalogIndex(modelOptions);
    const candidate = buildCustomCandidate(null, { ...input, id: requestedId }, catalog);
    const saved = store.saveCustomRoleConfig(candidate);
    return mutationResult(saved.id);
  }

  function updateCustomRole(existing: any, input: any, catalog: any) {
    if (hasOwn(input, 'id') && normalize(input.id) && normalize(input.id) !== existing.id) {
      throw createRoleError(422, 'role_locked_field', 'Stable role ID cannot be changed', 'id');
    }
    if (hasOwn(input, 'roleKind') && normalize(input.roleKind) && normalize(input.roleKind) !== 'custom') {
      throw createRoleError(422, 'role_locked_field', 'Role kind cannot be changed', 'roleKind');
    }
    if (hasOwn(input, 'modelFamily') && normalize(input.modelFamily)) {
      throw createRoleError(422, 'role_locked_field', 'Custom roles cannot acquire a model family', 'modelFamily');
    }
    const candidate = buildCustomCandidate(existing, input, catalog);
    const saved = store.saveCustomRoleConfig(candidate);
    return mutationResult(saved.id);
  }

  function updateFamilyRole(existing: any, input: any, modelOptions: any[], catalog: any) {
    if (hasOwn(input, 'personaPrompt')) {
      throw createRoleError(
        422,
        'family_persona_not_allowed',
        'Model-family roles cannot define Persona prompts',
        'personaPrompt'
      );
    }
    if (hasOwn(input, 'skillIds') || hasOwn(input, 'skills')) {
      throw createRoleError(
        422,
        'family_skills_not_allowed',
        'Model-family roles cannot define Persona skills',
        hasOwn(input, 'skillIds') ? 'skillIds' : 'skills'
      );
    }
    if (
      hasOwn(input, 'modelProfiles')
      && (Array.isArray(input.modelProfiles) ? input.modelProfiles : []).some(
        (profile: any) => profile && typeof profile === 'object' && hasOwn(profile, 'personaPrompt')
      )
    ) {
      const profileIndex = input.modelProfiles.findIndex(
        (profile: any) => profile && typeof profile === 'object' && hasOwn(profile, 'personaPrompt')
      );
      throw createRoleError(
        422,
        'family_persona_not_allowed',
        'Model-family profiles cannot define Persona prompts',
        `modelProfiles[${profileIndex}].personaPrompt`
      );
    }
    const lockedField = Object.keys(input || {}).find((key) => !FAMILY_UPDATE_FIELD_SET.has(key));
    if (lockedField) {
      throw createRoleError(
        422,
        'role_locked_field',
        `System-managed field cannot be changed: ${lockedField}`,
        lockedField
      );
    }

    const touchesRuntime = Object.keys(input || {}).some((key) => FAMILY_RUNTIME_FIELD_SET.has(key));
    const candidate = {
      ...existing,
      provider: hasOwn(input, 'provider') ? normalize(input.provider) : normalize(existing.provider),
      model: hasOwn(input, 'model') ? normalize(input.model) : normalize(existing.model),
      thinking: hasOwn(input, 'thinking') ? normalize(input.thinking) : normalize(existing.thinking),
      modelProfiles: hasOwn(input, 'modelProfiles') ? input.modelProfiles : existing.modelProfiles,
      isDefaultChatRole: hasOwn(input, 'isDefaultChatRole')
        ? Boolean(input.isDefaultChatRole)
        : Boolean(existing.isDefaultChatRole),
    };

    if (touchesRuntime) {
      const option = resolveConfiguredModel(
        catalog,
        candidate.provider,
        candidate.model,
        'model',
        existing.modelFamily
      );
      candidate.provider = option.provider;
      candidate.model = option.model;
      candidate.thinking = assertThinkingSupported(option, candidate.thinking, 'thinking');
      candidate.modelProfiles = normalizeProfiles(
        candidate.modelProfiles,
        catalog,
        'model_family',
        existing.modelFamily
      );
    }

    const availability = roleAvailability(candidate, modelOptions, catalog);
    if (candidate.isDefaultChatRole && availability.status !== 'available') {
      throw createRoleError(
        422,
        'role_default_unavailable',
        'Unavailable model-family roles cannot become chat defaults',
        'isDefaultChatRole',
        { availability }
      );
    }

    const saved = store.saveSystemRoleConfig(candidate);
    return mutationResult(saved.id);
  }

  function updateRole(roleId: any, input: any = {}) {
    const normalizedRoleId = normalize(roleId);
    const existing = store.getAgent(normalizedRoleId);
    if (!existing) {
      throw roleNotFound(normalizedRoleId);
    }
    const modelOptions = modelCatalog.getOptions();
    const catalog = buildCatalogIndex(modelOptions);
    return existing.roleKind === 'model_family'
      ? updateFamilyRole(existing, input, modelOptions, catalog)
      : updateCustomRole(existing, input, catalog);
  }

  function retireRole(roleId: any) {
    const normalizedRoleId = normalize(roleId);
    const existing = store.getAgent(normalizedRoleId);
    if (!existing) {
      throw roleNotFound(normalizedRoleId);
    }
    if (existing.roleKind === 'model_family' || SYSTEM_ROLE_ID_SET.has(normalizedRoleId)) {
      throw createRoleError(
        409,
        'system_role_delete_forbidden',
        'System model-family roles cannot be deleted'
      );
    }
    store.retireRoleConfig(normalizedRoleId, 'custom_role_deleted');
    return {
      deletedId: normalizedRoleId,
      ...getDirectory(),
    };
  }

  return {
    createCustomRole,
    getDirectory,
    retireRole,
    resolveRuntimeParticipants,
    updateRole,
    validateConversationParticipants,
  };
}
