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
export const SKILL_CREATOR_SKILL_ID = 'skill-creator';
export const ALWAYS_DYNAMIC_MODE_SKILL_IDS = [SKILL_CREATOR_SKILL_ID];

const REQUIRED_MODE_SKILL_IDS = [SKILL_CREATOR_SKILL_ID];
const REQUIRED_MODE_SKILL_ID_SET = new Set(REQUIRED_MODE_SKILL_IDS);

function withRequiredModeSkillIds(skillIds: any) {
  return mergeSkillIds(skillIds, REQUIRED_MODE_SKILL_IDS);
}

function modeHasSkillBindings(mode: any) {
  const skillIds = normalizeSkillIds(mode && mode.skillIds);
  return skillIds.some((skillId: string) => !REQUIRED_MODE_SKILL_ID_SET.has(skillId));
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
    skillIds: withRequiredModeSkillIds(row.skill_ids_json),
    loadingStrategy: normalizeLoadingStrategy(row.loading_strategy),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BUILTIN_MODES = [
  {
    id: 'standard',
    name: '普通协作',
    description: '通用多 Agent 协作 Room，可通过 Mode 挂载 Skills',
    builtin: true,
    skillIds: withRequiredModeSkillIds([]),
    loadingStrategy: 'dynamic',
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
    this.retireLegacyProductModes();
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

  retireLegacyProductModes() {
    const retiredModeIds = ['skill_test_design', 'werewolf', 'who_is_undercover'];
    const retiredSkillIds = new Set(['skill-test-design-workbench', 'werewolf', 'who-is-undercover']);
    const listParticipants = this.db.prepare(`
      SELECT conversation_id, agent_id, conversation_skills_json
      FROM chat_conversation_agents
    `);
    const updateParticipant = this.db.prepare(`
      UPDATE chat_conversation_agents SET conversation_skills_json = ?
      WHERE conversation_id = ? AND agent_id = ?
    `);
    const retire = this.db.transaction(() => {
      for (const participant of listParticipants.all()) {
        const existingSkillIds = normalizeSkillIds(participant.conversation_skills_json);
        const filtered = existingSkillIds.filter((id: string) => !retiredSkillIds.has(id));
        if (filtered.length !== existingSkillIds.length) {
          updateParticipant.run(serializeJson(filtered), participant.conversation_id, participant.agent_id);
        }
      }
      for (const modeId of retiredModeIds) {
        const roomRows = this.db.prepare(`
          WITH RECURSIVE retired_rooms(id, depth) AS (
            SELECT id, 0 FROM chat_conversations WHERE type = ?
            UNION ALL
            SELECT child.id, retired_rooms.depth + 1
            FROM chat_conversations child
            JOIN retired_rooms ON child.parent_conversation_id = retired_rooms.id
          )
          SELECT id, MAX(depth) AS depth FROM retired_rooms GROUP BY id ORDER BY depth DESC
        `).all(modeId);
        const roomIds = roomRows.map((row: any) => String(row.id));
        if (roomIds.length > 0) {
          const placeholders = roomIds.map(() => '?').join(', ');
          const deliveryRows = this.db.prepare(`
            SELECT id, hop_count FROM chat_cross_conversation_deliveries
            WHERE source_conversation_id IN (${placeholders}) OR target_conversation_id IN (${placeholders})
            ORDER BY hop_count DESC, created_at DESC
          `).all(...roomIds, ...roomIds);
          if (deliveryRows.length > 0) {
            // Product retirement is the one destructive migration allowed to
            // remove the otherwise append-only delivery audit trail. DDL is
            // transactional in SQLite, so a later failure restores the guard.
            this.db.exec('DROP TRIGGER IF EXISTS chat_cross_delivery_events_append_only_delete');
            for (const delivery of deliveryRows) {
              this.db.prepare('DELETE FROM chat_cross_conversation_delivery_events WHERE delivery_id = ?').run(delivery.id);
            }
            for (const delivery of deliveryRows) {
              this.db.prepare('DELETE FROM chat_cross_conversation_deliveries WHERE id = ?').run(delivery.id);
            }
            this.db.exec(`
              CREATE TRIGGER chat_cross_delivery_events_append_only_delete
              BEFORE DELETE ON chat_cross_conversation_delivery_events
              BEGIN
                SELECT RAISE(ABORT, 'cross-conversation delivery events are append-only');
              END
            `);
          }
          for (const room of roomRows) {
            this.db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(room.id);
          }
        }
        const mode = this.getStatement.get(modeId);
        if (mode && mode.builtin) {
          this.deleteStatement.run(modeId);
        }
      }
      // Legacy Skill Test tables may still exist in user databases with child
      // tables that reference the case/eval parent tables. Drop dependents
      // first so SQLite foreign-key enforcement cannot reject the retirement.
      for (const tableName of [
        'skill_test_chain_run_steps',
        'skill_test_runs',
        'skill_test_chain_runs',
        'skill_test_environment_assets',
        'skill_test_cases',
        'eval_case_runs',
        'eval_cases',
      ]) {
        const safeName = tableName.replace(/[^a-z0-9_]/gi, '');
        this.db.exec(`DROP TABLE IF EXISTS ${safeName}`);
      }
    });
    retire();
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

          const existingSkillIds = normalizeSkillIds(existingRow.skill_ids_json);
          const mergedSkillIds = mergeSkillIds(existingSkillIds, mode.skillIds);
          const existingEffectiveSkillIds = withRequiredModeSkillIds(existingRow.skill_ids_json);
          const shouldUpdateSkillIds = JSON.stringify(mergedSkillIds) !== JSON.stringify(existingEffectiveSkillIds);
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

    const skillIds = withRequiredModeSkillIds(input.skillIds);
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
