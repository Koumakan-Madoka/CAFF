const { randomUUID } = require('node:crypto');
const { openSqliteDatabase } = require('./storage/sqlite/connection');
const { migrateChatSchema } = require('./storage/sqlite/migrations');
const { createChatAgentRepository } = require('./storage/chat/agent.repository');
const { createChatConversationRepository } = require('./storage/chat/conversation.repository');
const { createChatParticipantRepository } = require('./storage/chat/participant.repository');
const { createChatMessageRepository } = require('./storage/chat/message.repository');
const { createChatPrivateMessageRepository } = require('./storage/chat/private-message.repository');

const MAX_AVATAR_DATA_URL_LENGTH = 2 * 1024 * 1024;
const MAX_AGENT_SANDBOX_NAME_LENGTH = 80;

const DEFAULT_AGENT_SEEDS = [
  {
    id: 'agent-strategist',
    name: 'Strategist',
    description: 'Frames goals, clarifies scope, and keeps the discussion outcome-focused.',
    personaPrompt: [
      'You are Strategist, a calm planning-oriented AI collaborator.',
      'Lead with structure, priorities, risks, and tradeoffs.',
      'Respond in the user language when it is obvious.',
      'Do not speak for other agents.',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#ef7d57',
  },
  {
    id: 'agent-builder',
    name: 'Builder',
    description: 'Turns ideas into concrete implementation steps and working decisions.',
    personaPrompt: [
      'You are Builder, a direct implementation-focused AI collaborator.',
      'Prefer practical solutions, examples, and next actions.',
      'Respond in the user language when it is obvious.',
      'Do not speak for other agents.',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#2a9d8f',
  },
  {
    id: 'agent-critic',
    name: 'Critic',
    description: 'Challenges assumptions, spots risks, and proposes safer alternatives.',
    personaPrompt: [
      'You are Critic, a careful review-oriented AI collaborator.',
      'Look for weak assumptions, edge cases, missing tests, and failure modes.',
      'Respond in the user language when it is obvious.',
      'Do not speak for other agents.',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#3d405b',
  },
  {
    id: 'agent-tsundere-senpai',
    name: '明日香',
    description: '以《新世纪福音战士》的明日香气质推进对话，强势、直接、要求高，但很会逼出更好的结果。',
    personaPrompt: [
      '你现在扮演《新世纪福音战士》里的明日香，以她那种自信、骄傲、嘴硬但能力很强的风格与用户交流。',
      '语气可以强势、直接、带一点不服输和轻微吐槽感，但不要真正攻击用户。',
      '看到含糊表达、懒方案、逻辑漏洞时，要像明日香一样立刻挑出来，并拿出更强的替代方案。',
      '重点不是做夸张角色扮演，而是把“高标准、强执行、逼人进步”的角色气质用在协作上。',
      '当用户语言明显时，优先使用用户语言回复。',
      '不要代替其他人格发言。',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#d1495b',
  },
  {
    id: 'agent-miko-oracle',
    name: '七海千秋',
    description: '以《弹丸论破》的七海千秋风格回应，温和、困倦感、擅长把复杂问题拆成轻松可执行的下一步。',
    personaPrompt: [
      '你现在扮演《弹丸论破》里的七海千秋，以她那种温柔、慢半拍、带点困倦感但很可靠的风格与用户交流。',
      '面对问题时，优先把复杂内容拆成简单步骤，就像带人一点点通关游戏那样推进。',
      '你的表达可以轻松、柔和、带一点呆萌感，但核心仍然是清晰分析、稳定支持和可执行建议。',
      '不要沉迷于台词模仿，而是把七海千秋的陪跑感、节奏感和“再试一次就好”的鼓励落在实际问题上。',
      '当用户语言明显时，优先使用用户语言回复。',
      '不要代替其他人格发言。',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#b56576',
  },
  {
    id: 'agent-mecha-engineer',
    name: '牧濑红莉栖',
    description: '以《命运石之门》的牧濑红莉栖风格处理问题，理性、科研脑、带一点傲气，特别适合系统拆解。',
    personaPrompt: [
      '你现在扮演《命运石之门》里的牧濑红莉栖，以她那种理性、聪明、带点傲娇的科研者口吻和用户交流。',
      '处理问题时优先采用科学思维和工程思维，关注变量、假设、证据、模块、依赖和验证方式。',
      '把模糊想法尽量转化成结构化分析、技术方案、实施步骤和排错路径。',
      '可以稍微有一点红莉栖式的吐槽感，但本质上要专业、聪明、讲逻辑。',
      '当用户语言明显时，优先使用用户语言回复。',
      '不要代替其他人格发言。',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#577590',
  },
  {
    id: 'agent-idol-spark',
    name: '初音未来',
    description: '以初音未来式的元气与亲和力推进对话，适合鼓舞、陪跑和把大任务拆成小胜利。',
    personaPrompt: [
      '你现在扮演初音未来，以她那种明亮、元气、亲和又有舞台感染力的风格和用户交流。',
      '你的任务是鼓舞用户、维持节奏、把吓人的事情拆成一小步一小步可以完成的目标。',
      '要真诚地肯定进展，让用户感觉“现在就能继续做”，而不是只会喊加油。',
      '保持轻快和温暖，但输出仍然必须具体、清楚、能直接行动。',
      '当用户语言明显时，优先使用用户语言回复。',
      '不要代替其他人格发言。',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#ff9f1c',
  },
  {
    id: 'agent-kuudere-archivist',
    name: '绫波丽',
    description: '以《新世纪福音战士》的绫波丽式冷静回应，话少、准、低情绪，适合审稿和精确分析。',
    personaPrompt: [
      '你现在扮演《新世纪福音战士》里的绫波丽，以她那种安静、克制、低情绪波动的方式与用户交流。',
      '表达尽量简洁，不说多余的话，但每一句都要有信息量。',
      '优先关注定义、证据、边界条件、风险点和措辞准确性，适合做校对、审稿、复盘和精确分析。',
      '当信息不足时，要平静指出缺口，再缩小问题范围，不要装作什么都确定。',
      '当用户语言明显时，优先使用用户语言回复。',
      '不要代替其他人格发言。',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#4d908e',
  },
  {
    id: 'agent-chuunibyou-visionary',
    name: '时崎狂三',
    description: '以《约会大作战》的时崎狂三风格进行创意发散，优雅、危险、戏剧化，特别适合包装概念。',
    personaPrompt: [
      '你现在扮演《约会大作战》里的时崎狂三，以她那种优雅、危险、戏剧张力强的风格与用户交流。',
      '你尤其擅长概念包装、命名、设定延展、创意脑暴和把普通想法说得极具记忆点。',
      '可以使用更华丽的表达、更强的画面感和戏剧感，但最后一定要落回明确建议。',
      '保持狂三式的魅力与锋利感，但不要输出令人不适或失控的内容。',
      '当用户语言明显时，优先使用用户语言回复。',
      '不要代替其他人格发言。',
    ].join('\n'),
    provider: '',
    model: '',
    thinking: '',
    accentColor: '#6d597a',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function serializeJson(value) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeAvatarDataUrl(value) {
  const avatarDataUrl = String(value || '').trim();

  if (!avatarDataUrl) {
    return '';
  }

  if (avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw new Error('Agent avatar is too large');
  }

  if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatarDataUrl)) {
    throw new Error('Agent avatar must be a PNG, JPEG, WEBP, or GIF image');
  }

  return avatarDataUrl;
}

function normalizeSandboxName(value) {
  const rawValue = String(value || '').trim();

  if (!rawValue) {
    return '';
  }

  if (rawValue.length > MAX_AGENT_SANDBOX_NAME_LENGTH) {
    throw new Error(`Agent sandbox name must be ${MAX_AGENT_SANDBOX_NAME_LENGTH} characters or fewer`);
  }

  const normalized = rawValue
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!normalized) {
    throw new Error('Agent sandbox name must include at least one letter, number, dot, underscore, or hyphen');
  }

  return normalized;
}

function resolveEffectiveSandboxName(sandboxName, agentId) {
  return normalizeSandboxName(sandboxName) || normalizeSandboxName(agentId) || 'agent';
}

function normalizeSkillRef(skill) {
  if (typeof skill === 'string') {
    return String(skill).trim() || null;
  }

  if (!skill || typeof skill !== 'object') {
    return null;
  }

  return String(skill.id || skill.skillId || skill.slug || skill.name || '').trim() || null;
}

function parseSkillRefs(value) {
  const parsed = parseJson(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const skill of parsed) {
    const skillId = normalizeSkillRef(skill);

    if (!skillId || seen.has(skillId)) {
      continue;
    }

    seen.add(skillId);
    normalized.push(skillId);
  }

  return normalized;
}

function normalizeModelProfile(profile, index = 0) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const model = String(profile.model || '').trim();
  const provider = String(profile.provider || '').trim();
  const thinking = String(profile.thinking || '').trim();
  const personaPrompt = String(profile.personaPrompt || '').trim();
  const description = String(profile.description || '').trim();
  const name = String(profile.name || '').trim();
  const id = String(profile.id || `profile-${index + 1}`).trim() || `profile-${index + 1}`;

  if (!name && !model && !provider && !thinking && !personaPrompt && !description) {
    return null;
  }

  return {
    id,
    name: name || model || `Profile ${index + 1}`,
    description,
    provider,
    model,
    thinking,
    personaPrompt,
  };
}

function parseModelProfiles(value) {
  const parsed = parseJson(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((profile, index) => normalizeModelProfile(profile, index))
    .filter(Boolean);
}

function findModelProfile(modelProfiles, profileId) {
  if (!profileId) {
    return null;
  }

  return (Array.isArray(modelProfiles) ? modelProfiles : []).find((profile) => profile.id === profileId) || null;
}

function normalizeAgentRow(row) {
  if (!row) {
    return null;
  }

  const modelProfiles = parseModelProfiles(row.model_profiles_json);
  const skillIds = parseSkillRefs(row.skills_json);
  const selectedModelProfileId = row.selected_model_profile_id ? String(row.selected_model_profile_id).trim() : null;
  const selectedModelProfile = findModelProfile(modelProfiles, selectedModelProfileId);
  const normalized = {
    id: row.id,
    name: row.name,
    sandboxName: row.sandbox_name ? String(row.sandbox_name).trim() : '',
    description: row.description || '',
    avatarDataUrl: row.avatar_data_url || '',
    personaPrompt: row.persona_prompt || '',
    provider: row.provider || '',
    model: row.model || '',
    thinking: row.thinking || '',
    accentColor: row.accent_color || '#3d405b',
    skillIds,
    skills: skillIds,
    modelProfiles,
    selectedModelProfileId: selectedModelProfile ? selectedModelProfile.id : null,
    selectedModelProfile,
    conversationSkillIds: parseSkillRefs(row.conversation_skills_json),
    conversationSkills: parseSkillRefs(row.conversation_skills_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.sort_order !== undefined) {
    normalized.sortOrder = Number(row.sort_order || 0);
  }

  return normalized;
}

function normalizeMessageRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    role: row.role,
    agentId: row.agent_id || null,
    senderName: row.sender_name,
    content: row.content,
    status: row.status,
    taskId: row.task_id || null,
    runId: typeof row.run_id === 'number' ? row.run_id : row.run_id ? Number(row.run_id) : null,
    errorMessage: row.error_message || '',
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function normalizePrivateMessageRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    senderAgentId: row.sender_agent_id || null,
    senderName: row.sender_name,
    recipientAgentIds: parseSkillRefs(row.recipient_agent_ids_json),
    content: row.content,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function normalizeConversationType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'who_is_undercover' ? 'who_is_undercover' : 'standard';
}

function normalizeConversationHeader(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    type: normalizeConversationType(row.type),
    metadata: parseJson(row.metadata_json) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at || null,
    messageCount: Number(row.message_count || 0),
    agentCount: Number(row.agent_count || 0),
    lastMessagePreview: row.last_message_preview || '',
  };
}

function normalizeConversation(row, agents, messages) {
  const header = normalizeConversationHeader(row);

  if (!header) {
    return null;
  }

  return {
    ...header,
    agents,
    messages,
  };
}

function pickDefaultParticipants(agents, requestedParticipants) {
  if (Array.isArray(requestedParticipants) && requestedParticipants.length > 0) {
    return requestedParticipants;
  }

  return agents.slice(0, 3).map((agent) => ({
    agentId: agent.id,
    modelProfileId: null,
    conversationSkills: [],
  }));
}

function normalizeRecipientAgentIds(recipientAgentIds) {
  const seen = new Set();
  const normalized = [];

  for (const value of Array.isArray(recipientAgentIds) ? recipientAgentIds : []) {
    const agentId = String(value || '').trim();

    if (!agentId || seen.has(agentId)) {
      continue;
    }

    seen.add(agentId);
    normalized.push(agentId);
  }

  return normalized;
}

class ChatAppStore {
  constructor({ agentDir, sqlitePath }) {
    const connection = openSqliteDatabase({ agentDir, sqlitePath });

    this.agentDir = connection.agentDir;
    this.databasePath = connection.databasePath;
    this.db = connection.db;

    migrateChatSchema(this.db);

    this.agentRepository = createChatAgentRepository(this.db);
    this.conversationRepository = createChatConversationRepository(this.db);
    this.participantRepository = createChatParticipantRepository(this.db);
    this.messageRepository = createChatMessageRepository(this.db);
    this.privateMessageRepository = createChatPrivateMessageRepository(this.db);

    this.replaceConversationParticipants = (conversationId, participants) => {
      const createdAt = nowIso();

      this.participantRepository.replaceForConversation(
        conversationId,
        participants.map((participant) => ({
          ...participant,
          conversationSkillsJson: serializeJson(participant.conversationSkills || []),
          createdAt,
        }))
      );
    };

    this.saveAgentTransaction = this.db.transaction((payload) => {
      const timestamp = nowIso();

      return normalizeAgentRow(
        this.agentRepository.save({
          ...payload,
          skillsJson: serializeJson(payload.skills),
          modelProfilesJson: serializeJson(payload.modelProfiles),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      );
    });

    this.createConversationTransaction = this.db.transaction((payload) => {
      const timestamp = nowIso();

      this.conversationRepository.create({
        id: payload.id,
        title: payload.title,
        type: normalizeConversationType(payload.type),
        metadataJson: serializeJson(payload.metadata || {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: null,
      });
      this.replaceConversationParticipants(payload.id, payload.participants);

      return this.getConversation(payload.id);
    });

    this.updateConversationTransaction = this.db.transaction((conversationId, updates) => {
      if (updates.title !== undefined) {
        this.conversationRepository.update(conversationId, {
          title: updates.title,
          type: normalizeConversationType(updates.type),
          metadataJson: serializeJson(updates.metadata || {}),
          updatedAt: nowIso(),
        });
      } else {
        this.conversationRepository.touch(conversationId, {
          updatedAt: nowIso(),
          lastMessageAt: null,
        });
      }

      if (Array.isArray(updates.participants)) {
        this.replaceConversationParticipants(conversationId, updates.participants);
      }

      return this.getConversation(conversationId);
    });

    this.createMessageTransaction = this.db.transaction((payload) => {
      const createdAt = payload.createdAt || nowIso();

      this.messageRepository.create({
        id: payload.id,
        conversationId: payload.conversationId,
        turnId: payload.turnId,
        role: payload.role,
        agentId: payload.agentId || null,
        senderName: payload.senderName,
        content: payload.content || '',
        status: payload.status || 'completed',
        taskId: payload.taskId || null,
        runId: payload.runId || null,
        errorMessage: payload.errorMessage || null,
        metadataJson: serializeJson(payload.metadata),
        createdAt,
      });
      this.conversationRepository.touch(payload.conversationId, {
        updatedAt: createdAt,
        lastMessageAt: createdAt,
      });

      return this.getMessage(payload.id);
    });

    this.createPrivateMessageTransaction = this.db.transaction((payload) => {
      const createdAt = payload.createdAt || nowIso();

      return normalizePrivateMessageRow(
        this.privateMessageRepository.create({
          id: payload.id,
          conversationId: payload.conversationId,
          turnId: payload.turnId,
          senderAgentId: payload.senderAgentId || null,
          senderName: payload.senderName,
          recipientAgentIdsJson: serializeJson(payload.recipientAgentIds || []),
          content: payload.content || '',
          metadataJson: serializeJson(payload.metadata),
          createdAt,
        })
      );
    });

    this.seedDefaultAgents();
  }

  seedDefaultAgents() {
    for (const seed of DEFAULT_AGENT_SEEDS) {
      if (this.agentRepository.get(seed.id)) {
        continue;
      }

      this.saveAgent(seed);
    }
  }

  getAgent(agentId) {
    return normalizeAgentRow(this.agentRepository.get(agentId));
  }

  listAgents() {
    return this.agentRepository.list().map(normalizeAgentRow);
  }

  saveAgent(input = {}) {
    const id = String(input.id || randomUUID()).trim();
    const name = String(input.name || '').trim();
    const personaPrompt = String(input.personaPrompt || '').trim();
    const sandboxName = normalizeSandboxName(input.sandboxName);

    if (!name) {
      throw new Error('Agent name is required');
    }

    if (!personaPrompt) {
      throw new Error('Agent personaPrompt is required');
    }

    this.assertUniqueAgentSandboxName(id, sandboxName);

    return this.saveAgentTransaction({
      id,
      name,
      sandboxName,
      description: String(input.description || '').trim(),
      avatarDataUrl: normalizeAvatarDataUrl(input.avatarDataUrl),
      personaPrompt,
      provider: String(input.provider || '').trim(),
      model: String(input.model || '').trim(),
      thinking: String(input.thinking || '').trim(),
      accentColor: String(input.accentColor || '#3d405b').trim() || '#3d405b',
      skills: this.normalizeSkillRefs(input.skillIds || input.skills),
      modelProfiles: this.normalizeModelProfiles(input.modelProfiles),
    });
  }

  deleteAgent(agentId) {
    this.agentRepository.delete(agentId);
  }

  listConversations() {
    return this.conversationRepository.listHeaders().map(normalizeConversationHeader);
  }

  getConversation(conversationId) {
    const row = this.conversationRepository.get(conversationId);

    if (!row) {
      return null;
    }

    return normalizeConversation(
      row,
      this.listConversationAgents(conversationId),
      this.listMessages(conversationId)
    );
  }

  createConversation(input = {}) {
    const id = String(input.id || randomUUID()).trim();
    const title = String(input.title || '').trim() || 'New Conversation';
    const participants = this.normalizeConversationParticipantsInput(input);

    return this.createConversationTransaction({
      id,
      title,
      type: normalizeConversationType(input.type),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
      participants: pickDefaultParticipants(this.listAgents(), participants),
    });
  }

  updateConversation(conversationId, updates = {}) {
    const existing = this.getConversation(conversationId);

    if (!existing) {
      return null;
    }

    const title = updates.title === undefined ? existing.title : String(updates.title || '').trim() || existing.title;
    const type = updates.type === undefined ? existing.type : normalizeConversationType(updates.type);
    const metadata =
      updates.metadata === undefined
        ? existing.metadata && typeof existing.metadata === 'object'
          ? existing.metadata
          : {}
        : updates.metadata && typeof updates.metadata === 'object'
          ? updates.metadata
          : {};
    const participants = this.hasConversationParticipantsInput(updates)
      ? this.normalizeConversationParticipantsInput(updates)
      : undefined;

    return this.updateConversationTransaction(conversationId, {
      title,
      type,
      metadata,
      participants,
    });
  }

  deleteConversation(conversationId) {
    this.conversationRepository.delete(conversationId);
  }

  listConversationAgents(conversationId) {
    return this.participantRepository.listByConversationId(conversationId).map(normalizeAgentRow);
  }

  listMessages(conversationId) {
    return this.messageRepository.listByConversationId(conversationId).map(normalizeMessageRow);
  }

  listPrivateMessages(conversationId) {
    return this.privateMessageRepository.listByConversationId(conversationId).map(normalizePrivateMessageRow);
  }

  listPrivateMessagesForAgent(conversationId, agentId, options = {}) {
    const normalizedAgentId = String(agentId || '').trim();
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 0;
    const visibleMessages = this.listPrivateMessages(conversationId).filter((message) => {
      if (!normalizedAgentId) {
        return false;
      }

      const recipients = Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [];
      return recipients.includes(normalizedAgentId) || message.senderAgentId === normalizedAgentId;
    });

    return limit > 0 ? visibleMessages.slice(-limit) : visibleMessages;
  }

  getMessage(messageId) {
    return normalizeMessageRow(this.messageRepository.get(messageId));
  }

  createMessage(payload = {}) {
    const conversation = this.getConversation(payload.conversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const senderName =
      String(payload.senderName || '').trim() ||
      (payload.role === 'user' ? 'You' : payload.role === 'assistant' ? 'Assistant' : 'System');

    return this.createMessageTransaction({
      id: String(payload.id || randomUUID()).trim(),
      conversationId: payload.conversationId,
      turnId: String(payload.turnId || randomUUID()).trim(),
      role: String(payload.role || 'assistant').trim(),
      agentId: payload.agentId || null,
      senderName,
      content: String(payload.content || ''),
      status: String(payload.status || 'completed').trim() || 'completed',
      taskId: payload.taskId || null,
      runId: payload.runId || null,
      errorMessage: String(payload.errorMessage || '').trim(),
      metadata: payload.metadata,
      createdAt: payload.createdAt,
    });
  }

  createPrivateMessage(payload = {}) {
    const conversation = this.getConversation(payload.conversationId);

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const senderName = String(payload.senderName || '').trim() || 'System';
    const recipientAgentIds = normalizeRecipientAgentIds(payload.recipientAgentIds);

    if (recipientAgentIds.length === 0) {
      throw new Error('At least one private message recipient is required');
    }

    return this.createPrivateMessageTransaction({
      id: String(payload.id || randomUUID()).trim(),
      conversationId: payload.conversationId,
      turnId: String(payload.turnId || randomUUID()).trim(),
      senderAgentId: payload.senderAgentId || null,
      senderName,
      recipientAgentIds,
      content: String(payload.content || ''),
      metadata: payload.metadata,
      createdAt: payload.createdAt,
    });
  }

  updateMessage(messageId, updates = {}) {
    const existing = this.getMessage(messageId);

    if (!existing) {
      return null;
    }

    const nextContent =
      updates.content === undefined ? existing.content : String(updates.content || '');
    const nextStatus =
      updates.status === undefined ? existing.status : String(updates.status || '').trim() || existing.status;
    const nextTaskId = updates.taskId === undefined ? existing.taskId : updates.taskId || null;
    const nextRunId = updates.runId === undefined ? existing.runId : updates.runId || null;
    const nextErrorMessage =
      updates.errorMessage === undefined ? existing.errorMessage : String(updates.errorMessage || '').trim();
    const nextMetadata = updates.metadata === undefined ? existing.metadata : updates.metadata;

    return normalizeMessageRow(
      this.messageRepository.update(messageId, {
        content: nextContent,
        status: nextStatus,
        taskId: nextTaskId,
        runId: nextRunId,
        errorMessage: nextErrorMessage || null,
        metadataJson: serializeJson(nextMetadata),
      })
    );
  }

  appendMessageText(messageId, delta) {
    const text = String(delta || '');

    if (!text) {
      return this.getMessage(messageId);
    }

    return normalizeMessageRow(this.messageRepository.appendText(messageId, text));
  }

  ensureStarterConversation() {
    const conversations = this.listConversations();

    if (conversations.length > 0) {
      return conversations[0];
    }

    const agents = this.listAgents();
    return this.createConversation({
      title: '新协作会话',
      participants: agents.slice(0, 3).map((agent) => ({
        agentId: agent.id,
        modelProfileId: null,
        conversationSkills: [],
      })),
    });
  }

  normalizeSkillRefs(skills) {
    const seenIds = new Set();
    const normalized = [];

    for (const skill of Array.isArray(skills) ? skills : []) {
      const nextSkillId = normalizeSkillRef(skill);

      if (!nextSkillId || seenIds.has(nextSkillId)) {
        continue;
      }

      seenIds.add(nextSkillId);
      normalized.push(nextSkillId);
    }

    return normalized;
  }

  assertUniqueAgentSandboxName(agentId, sandboxName) {
    const candidateSandboxName = resolveEffectiveSandboxName(sandboxName, agentId);

    for (const agent of this.listAgents()) {
      if (!agent || agent.id === agentId) {
        continue;
      }

      if (resolveEffectiveSandboxName(agent.sandboxName, agent.id) === candidateSandboxName) {
        throw new Error(`Agent sandbox name "${candidateSandboxName}" is already used by ${agent.name || agent.id}`);
      }
    }
  }

  normalizeModelProfiles(modelProfiles) {
    const seenIds = new Set();
    const normalized = [];

    for (const [index, profile] of Array.isArray(modelProfiles) ? modelProfiles.entries() : []) {
      const nextProfile = normalizeModelProfile(profile, index);

      if (!nextProfile || seenIds.has(nextProfile.id)) {
        continue;
      }

      seenIds.add(nextProfile.id);
      normalized.push(nextProfile);
    }

    return normalized;
  }

  hasConversationParticipantsInput(input = {}) {
    return Array.isArray(input.participants) || Array.isArray(input.agentIds);
  }

  normalizeConversationParticipantsInput(input = {}) {
    if (Array.isArray(input.participants)) {
      return this.normalizeConversationParticipants(input.participants);
    }

    const agentProfileIds =
      input.agentProfileIds && typeof input.agentProfileIds === 'object' ? input.agentProfileIds : {};
    const legacyParticipants = Array.isArray(input.agentIds)
      ? input.agentIds.map((agentId) => ({
          agentId,
          modelProfileId: agentProfileIds[agentId] || null,
          conversationSkillIds: [],
        }))
      : [];

    return this.normalizeConversationParticipants(legacyParticipants);
  }

  normalizeConversationParticipants(participants) {
    const knownAgents = new Map(this.listAgents().map((agent) => [agent.id, agent]));
    const deduped = [];
    const seenAgentIds = new Set();

    for (const participant of Array.isArray(participants) ? participants : []) {
      const agentId =
        typeof participant === 'string'
          ? String(participant || '').trim()
          : String((participant && (participant.agentId || participant.id)) || '').trim();

      if (!agentId || seenAgentIds.has(agentId) || !knownAgents.has(agentId)) {
        continue;
      }

      const agent = knownAgents.get(agentId);
      const requestedProfileId =
        typeof participant === 'string'
          ? ''
          : String(
              (participant && (participant.modelProfileId || participant.selectedModelProfileId || '')) || ''
            ).trim();
      const modelProfileId = findModelProfile(agent.modelProfiles, requestedProfileId) ? requestedProfileId : null;
      const conversationSkillIds =
        typeof participant === 'string'
          ? []
          : this.normalizeSkillRefs(
              (participant &&
                (participant.conversationSkillIds || participant.conversationSkills || participant.sessionSkillIds || participant.sessionSkills || [])) ||
                []
            );

      seenAgentIds.add(agentId);
      deduped.push({
        agentId,
        modelProfileId,
        conversationSkills: conversationSkillIds,
      });
    }

    return deduped;
  }

  findSkillReferences(skillId) {
    const targetSkillId = String(skillId || '').trim();

    if (!targetSkillId) {
      return [];
    }

    const references = [];

    for (const agent of this.listAgents()) {
      if (Array.isArray(agent.skillIds) && agent.skillIds.includes(targetSkillId)) {
        references.push({
          type: 'agent',
          id: agent.id,
          name: agent.name,
        });
      }
    }

    for (const conversation of this.listConversations()) {
      const fullConversation = this.getConversation(conversation.id);

      for (const agent of fullConversation && Array.isArray(fullConversation.agents) ? fullConversation.agents : []) {
        if (Array.isArray(agent.conversationSkillIds) && agent.conversationSkillIds.includes(targetSkillId)) {
          references.push({
            type: 'conversation',
            id: fullConversation.id,
            name: fullConversation.title,
            agentId: agent.id,
            agentName: agent.name,
          });
        }
      }
    }

    return references;
  }

  close() {
    this.db.close();
  }
}

function createChatAppStore(options) {
  return new ChatAppStore(options);
}

module.exports = {
  ChatAppStore,
  DEFAULT_AGENT_SEEDS,
  createChatAppStore,
};
