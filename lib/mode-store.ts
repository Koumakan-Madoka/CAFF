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
    id: 'coding',
    name: 'Coding',
    description: '面向编码协作的默认会话模式',
    builtin: true,
    skillIds: [],
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
  }

  seedBuiltinModes() {
    for (const mode of BUILTIN_MODES) {
      if (this.getStatement.get(mode.id)) {
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
