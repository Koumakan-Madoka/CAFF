const { randomUUID } = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value: any) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializeJson(value: any) {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value === undefined ? null : value);
}

function dedupSkillIds(items: any[]) {
  const seen = new Set();
  const normalized = [];

  for (const item of items) {
    const skillId = String(item || '').trim();

    if (!skillId || seen.has(skillId)) {
      continue;
    }

    seen.add(skillId);
    normalized.push(skillId);
  }

  return normalized;
}

function normalizeSkillIds(value: any) {
  if (Array.isArray(value)) {
    return dedupSkillIds(value);
  }

  const parsed = parseJson(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return dedupSkillIds(parsed);
}

function mergeSkillIds(...groups: any[]) {
  const merged = [] as string[];

  for (const group of groups) {
    merged.push(...normalizeSkillIds(group));
  }

  return dedupSkillIds(merged);
}

function normalizeModeName(value: any) {
  return String(value || '').trim().toLowerCase();
}

const LEGACY_FEISHU_CODING_MODE_ID = 'coding';
const CODING_MODE_NAME = 'coding';
export const SKILL_TEST_DESIGN_WORKBENCH_SKILL_ID = 'skill-test-design-workbench';

function modeHasSkillBindings(mode: any) {
  return Array.isArray(mode && mode.skillIds) && mode.skillIds.length > 0;
}

function normalizeLoadingStrategy(value: any) {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'full') {
    return 'full';
  }

  return 'dynamic';
}

function normalizeModeRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    builtin: Boolean(row.builtin),
    skillIds: normalizeSkillIds(row.skill_ids_json),
    loadingStrategy: normalizeLoadingStrategy(row.loading_strategy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BUILTIN_MODES = [
  {
    id: 'standard',
    name: '普通对话',
    description: '标准对话模式，不自动注入额外 skill',
    builtin: true,
    skillIds: [],
    loadingStrategy: 'dynamic',
  },
  {
    id: 'skill_test_design',
    name: 'Skill Test 设计',
    description: '围绕单个 skill 进行追问、测试矩阵规划与草稿导出的专用模式',
    builtin: true,
    skillIds: [SKILL_TEST_DESIGN_WORKBENCH_SKILL_ID],
    loadingStrategy: 'dynamic',
  },
  {
    id: 'werewolf',
    name: '狼人杀',
    description: '后端全自动主持的狼人杀游戏模式',
    builtin: true,
    skillIds: [],
    loadingStrategy: 'full',
  },
  {
    id: 'who_is_undercover',
    name: '谁是卧底',
    description: '后端全自动主持的谁是卧底游戏模式',
    builtin: true,
    skillIds: [],
    loadingStrategy: 'full',
  },
];

export class ModeStore {
  db: any;
  getStatement: any;
  listStatement: any;
  insertStatement: any;
  updateStatement: any;
  deleteStatement: any;

  constructor(db: any) {
    this.db = db;

    this.getStatement = db.prepare(`
      SELECT *
      FROM modes
      WHERE id = ?
      LIMIT 1
    `);

    this.listStatement = db.prepare(`
      SELECT *
      FROM modes
      ORDER BY builtin DESC, created_at ASC, id ASC
    `);

    this.insertStatement = db.prepare(`
      INSERT INTO modes (id, name, description, builtin, skill_ids_json, loading_strategy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateStatement = db.prepare(`
      UPDATE modes
      SET name = ?, description = ?, skill_ids_json = ?, loading_strategy = ?, updated_at = ?
      WHERE id = ?
    `);

    this.deleteStatement = db.prepare('DELETE FROM modes WHERE id = ?');

    this.seedBuiltinModes();
    this.migrateLegacyFeishuCodingMode();
  }

  resolveCodingMode() {
    const modes = this.list();
    const namedCodingModes = modes.filter((mode: any) => (
      mode
      && (mode.id === LEGACY_FEISHU_CODING_MODE_ID || normalizeModeName(mode.name) === CODING_MODE_NAME)
    ));

    return namedCodingModes.find((mode: any) => !mode.builtin && modeHasSkillBindings(mode))
      || namedCodingModes.find((mode: any) => !mode.builtin)
      || namedCodingModes.find((mode: any) => mode.id === LEGACY_FEISHU_CODING_MODE_ID && modeHasSkillBindings(mode))
      || null;
  }

  applyModeSkillIdsToConversationParticipants(conversationIds: any[], mode: any) {
    const modeSkillIds = normalizeSkillIds(mode && mode.skillIds);
    const normalizedConversationIds = Array.from(new Set(
      (Array.isArray(conversationIds) ? conversationIds : [])
        .map((conversationId) => String(conversationId || '').trim())
        .filter(Boolean)
    ));

    if (modeSkillIds.length === 0 || normalizedConversationIds.length === 0) {
      return;
    }

    const listParticipants = this.db.prepare(`
      SELECT conversation_id, agent_id, conversation_skills_json
      FROM chat_conversation_agents
      WHERE conversation_id = ?
    `);
    const updateParticipant = this.db.prepare(`
      UPDATE chat_conversation_agents
      SET conversation_skills_json = ?
      WHERE conversation_id = ? AND agent_id = ?
    `);

    for (const conversationId of normalizedConversationIds) {
      const participants = listParticipants.all(conversationId);

      for (const participant of participants) {
        const mergedSkillIds = mergeSkillIds(participant.conversation_skills_json, modeSkillIds);
        updateParticipant.run(
          serializeJson(mergedSkillIds),
          participant.conversation_id,
          participant.agent_id,
        );
      }
    }
  }

  migrateLegacyFeishuCodingMode() {
    const legacyMode = normalizeModeRow(this.getStatement.get(LEGACY_FEISHU_CODING_MODE_ID));

    if (!legacyMode || !legacyMode.builtin || modeHasSkillBindings(legacyMode)) {
      return;
    }

    const preferredMode = this.resolveCodingMode();

    if (!preferredMode || preferredMode.id === legacyMode.id || !modeHasSkillBindings(preferredMode)) {
      return;
    }

    const conversationRows = this.db.prepare('SELECT id FROM chat_conversations WHERE type = ?').all(legacyMode.id);
    const conversationIds = conversationRows.map((row: any) => row.id);
    const migrateLegacyMode = this.db.transaction(() => {
      this.db.prepare('UPDATE chat_conversations SET type = ?, updated_at = ? WHERE type = ?')
        .run(preferredMode.id, nowIso(), legacyMode.id);
      this.applyModeSkillIdsToConversationParticipants(conversationIds, preferredMode);
      this.deleteStatement.run(legacyMode.id);
    });

    migrateLegacyMode();
  }

  seedBuiltinModes() {
    for (const mode of BUILTIN_MODES) {
      const existingRow = this.getStatement.get(mode.id);

      if (existingRow) {
        if (Array.isArray(mode.skillIds) && mode.skillIds.length > 0) {
          const existingMode: any = normalizeModeRow(existingRow);
          if (!existingMode) {
            continue;
          }

          const existingSkillIds = Array.isArray(existingMode.skillIds) ? existingMode.skillIds : [];
          const mergedSkillIds = mergeSkillIds(existingSkillIds, mode.skillIds);
          const shouldUpdateSkillIds = JSON.stringify(mergedSkillIds) !== JSON.stringify(existingSkillIds);
          const shouldUpdateLoadingStrategy = existingMode.loadingStrategy !== mode.loadingStrategy;

          if (shouldUpdateSkillIds || shouldUpdateLoadingStrategy) {
            this.updateStatement.run(
              existingMode.name || mode.name,
              existingMode.description || mode.description,
              serializeJson(mergedSkillIds),
              mode.loadingStrategy,
              nowIso(),
              mode.id,
            );
          }
        }
        continue;
      }

      const timestamp = nowIso();
      this.insertStatement.run(
        mode.id,
        mode.name,
        mode.description,
        mode.builtin ? 1 : 0,
        serializeJson(mode.skillIds),
        mode.loadingStrategy,
        timestamp,
        timestamp,
      );
    }
  }

  list() {
    return this.listStatement.all().map(normalizeModeRow);
  }

  get(modeId: any) {
    return normalizeModeRow(this.getStatement.get(String(modeId || '').trim()));
  }

  save(input: any = {}) {
    const id = String(input.id || randomUUID()).trim();
    const name = String(input.name || '').trim();
    const description = String(input.description || '').trim();

    if (!name) {
      throw new Error('Mode name is required');
    }

    const skillIds = normalizeSkillIds(input.skillIds);
    const loadingStrategy = normalizeLoadingStrategy(input.loadingStrategy);
    const timestamp = nowIso();

    const existing = this.getStatement.get(id);

    if (existing) {
      this.updateStatement.run(
        name,
        description,
        serializeJson(skillIds),
        loadingStrategy,
        timestamp,
        id,
      );
    } else {
      this.insertStatement.run(
        id,
        name,
        description,
        0,
        serializeJson(skillIds),
        loadingStrategy,
        timestamp,
        timestamp,
      );
    }

    return this.get(id);
  }

  delete(modeId: any) {
    const normalizedId = String(modeId || '').trim();
    const mode = this.get(normalizedId);

    if (mode && mode.builtin) {
      throw new Error('Cannot delete builtin mode');
    }

    this.deleteStatement.run(normalizedId);
  }
}

export function createModeStore(db: any) {
  return new ModeStore(db);
}
