import { createHash } from 'node:crypto';

import {
  LEGACY_SYSTEM_ROLE_IDS,
  SYSTEM_MODEL_FAMILY_ROLES,
} from '../../server/domain/roles/system-role-catalog';

export const MODEL_FAMILY_ROLE_MIGRATION_ID = '2026-08-03-model-family-roles-v1';

function hasTable(db: any, tableName: string) {
  const statement = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `);
  return typeof statement?.get === 'function' && Boolean(statement.get(tableName));
}

function tableColumns(db: any, tableName: string): Set<string> {
  return new Set<string>(
    db.prepare(`PRAGMA table_info(${tableName})`).all().map((row: any) => String(row.name))
  );
}

export function hasLegacyModelFamilyRoleSchema(db: any) {
  return hasTable(db, 'chat_agents') && !tableColumns(db, 'chat_agents').has('role_kind');
}

function stableHash(rows: any[]) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function countRows(db: any, tableName: string) {
  if (!hasTable(db, tableName)) {
    return 0;
  }
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count || 0);
}

function rowsOrEmpty(db: any, tableName: string, sql: string, params: any[] = []) {
  return hasTable(db, tableName) ? db.prepare(sql).all(...params) : [];
}

function columnExpression(columns: Set<string>, columnName: string, fallbackSql = 'NULL') {
  return columns.has(columnName) ? columnName : `${fallbackSql} AS ${columnName}`;
}

function legacyAgentProjection(db: any) {
  const columns = tableColumns(db, 'chat_agents');
  return [
    'id',
    'name',
    columnExpression(columns, 'sandbox_name'),
    columnExpression(columns, 'description', "''"),
    columnExpression(columns, 'avatar_data_url'),
    'persona_prompt',
    columnExpression(columns, 'provider', "''"),
    columnExpression(columns, 'model', "''"),
    columnExpression(columns, 'thinking', "''"),
    columnExpression(columns, 'accent_color'),
    columnExpression(columns, 'skills_json'),
    columnExpression(columns, 'model_profiles_json'),
    'created_at',
    'updated_at',
  ].join(', ');
}

function legacyAgentConfigProjection(db: any) {
  const columns = tableColumns(db, 'chat_agents');
  return [
    'id',
    'name',
    columnExpression(columns, 'sandbox_name'),
    columnExpression(columns, 'description', "''"),
    columnExpression(columns, 'avatar_data_url'),
    'persona_prompt',
    columnExpression(columns, 'provider', "''"),
    columnExpression(columns, 'model', "''"),
    columnExpression(columns, 'thinking', "''"),
    columnExpression(columns, 'accent_color'),
    columnExpression(columns, 'skills_json'),
    columnExpression(columns, 'model_profiles_json'),
  ].join(', ');
}

function captureCounts(db: any) {
  return {
    conversations: countRows(db, 'chat_conversations'),
    messages: countRows(db, 'chat_messages'),
    privateMessages: countRows(db, 'chat_private_messages'),
    memoryCards: countRows(db, 'chat_memory_cards'),
    summaries: countRows(db, 'chat_summary_segments'),
    externalEvents: countRows(db, 'chat_external_events'),
  };
}

function captureCriticalSnapshot(db: any) {
  const legacyPlaceholders = LEGACY_SYSTEM_ROLE_IDS.map(() => '?').join(',');
  return {
    counts: captureCounts(db),
    messageHash: stableHash(rowsOrEmpty(db, 'chat_messages', `
      SELECT id, agent_id, sender_name, content, status, task_id, run_id, error_message, metadata_json, created_at
      FROM chat_messages
      ORDER BY id
    `)),
    privateHash: stableHash(rowsOrEmpty(db, 'chat_private_messages', `
      SELECT id, sender_agent_id, sender_name, recipient_agent_ids_json, content, metadata_json, created_at
      FROM chat_private_messages
      ORDER BY id
    `)),
    customAgentHash: stableHash(db.prepare(`
      SELECT ${legacyAgentProjection(db)}
      FROM chat_agents
      WHERE id NOT IN (${legacyPlaceholders})
      ORDER BY id
    `).all(...LEGACY_SYSTEM_ROLE_IDS)),
    memoryCounts: rowsOrEmpty(db, 'chat_memory_cards', `
      SELECT agent_id, COUNT(*) AS count
      FROM chat_memory_cards
      GROUP BY agent_id
      ORDER BY agent_id
    `),
    legacyParticipantCount: hasTable(db, 'chat_conversation_agents') ? Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM chat_conversation_agents
      WHERE agent_id IN (${legacyPlaceholders})
    `).get(...LEGACY_SYSTEM_ROLE_IDS)?.count || 0) : 0,
  };
}

function ensureMigrationLedger(db: any) {
  db.exec(`
CREATE TABLE IF NOT EXISTS chat_schema_migrations (
  migration_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  backup_path TEXT,
  pre_counts_json TEXT NOT NULL,
  audit_json TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
  `);
}

export function reconcileSystemModelFamilyRoles(db: any, timestamp = new Date().toISOString()) {
  const insertIdentity = db.prepare(`
    INSERT INTO chat_role_identities (
      role_id,
      display_name_snapshot,
      avatar_data_url_snapshot,
      accent_color_snapshot,
      origin_kind,
      model_family_snapshot,
      lifecycle_state,
      retired_reason,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 'model_family', ?, 'active', NULL, ?, ?)
    ON CONFLICT(role_id) DO UPDATE SET
      display_name_snapshot = excluded.display_name_snapshot,
      avatar_data_url_snapshot = excluded.avatar_data_url_snapshot,
      accent_color_snapshot = excluded.accent_color_snapshot,
      origin_kind = 'model_family',
      model_family_snapshot = excluded.model_family_snapshot,
      lifecycle_state = 'active',
      retired_reason = NULL,
      updated_at = excluded.updated_at
    WHERE chat_role_identities.display_name_snapshot IS NOT excluded.display_name_snapshot
      OR chat_role_identities.avatar_data_url_snapshot IS NOT excluded.avatar_data_url_snapshot
      OR chat_role_identities.accent_color_snapshot IS NOT excluded.accent_color_snapshot
      OR chat_role_identities.origin_kind IS NOT 'model_family'
      OR chat_role_identities.model_family_snapshot IS NOT excluded.model_family_snapshot
      OR chat_role_identities.lifecycle_state IS NOT 'active'
      OR chat_role_identities.retired_reason IS NOT NULL
  `);
  const insertConfig = db.prepare(`
    INSERT INTO chat_agents (
      id,
      name,
      sandbox_name,
      description,
      avatar_data_url,
      persona_prompt,
      provider,
      model,
      thinking,
      accent_color,
      skills_json,
      model_profiles_json,
      role_kind,
      model_family,
      is_default_chat_role,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, NULL, '', '', '', '', ?, '[]', '[]', 'model_family', ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      sandbox_name = excluded.sandbox_name,
      description = excluded.description,
      avatar_data_url = NULL,
      persona_prompt = '',
      accent_color = excluded.accent_color,
      skills_json = '[]',
      role_kind = 'model_family',
      model_family = excluded.model_family,
      updated_at = excluded.updated_at
    WHERE chat_agents.name IS NOT excluded.name
      OR chat_agents.sandbox_name IS NOT excluded.sandbox_name
      OR chat_agents.description IS NOT excluded.description
      OR chat_agents.avatar_data_url IS NOT NULL
      OR chat_agents.persona_prompt IS NOT ''
      OR chat_agents.accent_color IS NOT excluded.accent_color
      OR chat_agents.skills_json IS NOT '[]'
      OR chat_agents.role_kind IS NOT 'model_family'
      OR chat_agents.model_family IS NOT excluded.model_family
  `);

  for (const role of SYSTEM_MODEL_FAMILY_ROLES) {
    insertIdentity.run(
      role.id,
      role.name,
      null,
      role.accentColor,
      role.modelFamily,
      timestamp,
      timestamp
    );
    insertConfig.run(
      role.id,
      role.name,
      role.id,
      role.description,
      role.accentColor,
      role.modelFamily,
      timestamp,
      timestamp
    );
  }
}

function assertMigrationAudit(db: any, before: any) {
  const afterCounts = captureCounts(db);
  if (JSON.stringify(afterCounts) !== JSON.stringify(before.counts)) {
    throw new Error('model-family migration count audit failed');
  }

  const messageHash = stableHash(db.prepare(`
    SELECT id, agent_id, sender_name, content, status, task_id, run_id, error_message, metadata_json, created_at
    FROM chat_messages
    ORDER BY id
  `).all());
  const privateHash = stableHash(db.prepare(`
    SELECT id, sender_agent_id, sender_name, recipient_agent_ids_json, content, metadata_json, created_at
    FROM chat_private_messages
    ORDER BY id
  `).all());
  const legacyPlaceholders = LEGACY_SYSTEM_ROLE_IDS.map(() => '?').join(',');
  const customAgentHash = stableHash(db.prepare(`
    SELECT
      id, name, sandbox_name, description, avatar_data_url, persona_prompt, provider,
      model, thinking, accent_color, skills_json, model_profiles_json, created_at, updated_at
    FROM chat_agents
    WHERE role_kind = 'custom'
    ORDER BY id
  `).all());
  const memoryCounts = db.prepare(`
    SELECT agent_id, COUNT(*) AS count
    FROM chat_memory_cards
    GROUP BY agent_id
    ORDER BY agent_id
  `).all();
  const activeLegacyCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_agents
    WHERE id IN (${legacyPlaceholders})
  `).get(...LEGACY_SYSTEM_ROLE_IDS)?.count || 0);
  const activeLegacyParticipantCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_conversation_agents
    WHERE agent_id IN (${legacyPlaceholders})
  `).get(...LEGACY_SYSTEM_ROLE_IDS)?.count || 0);
  const historyCount = countRows(db, 'chat_conversation_agent_history');
  const familyCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM chat_agents
    WHERE role_kind = 'model_family'
  `).get()?.count || 0);
  const foreignKeyFailures = db.pragma('foreign_key_check');

  if (
    messageHash !== before.messageHash
    || privateHash !== before.privateHash
    || customAgentHash !== before.customAgentHash
    || JSON.stringify(memoryCounts) !== JSON.stringify(before.memoryCounts)
    || activeLegacyCount !== 0
    || activeLegacyParticipantCount !== 0
    || historyCount !== before.legacyParticipantCount
    || familyCount !== SYSTEM_MODEL_FAMILY_ROLES.length
    || foreignKeyFailures.length > 0
  ) {
    throw new Error('model-family migration content audit failed');
  }

  return {
    counts: afterCounts,
    messageHash,
    privateHash,
    customAgentHash,
    memoryCounts,
    legacyHistoryCount: historyCount,
    familyRoleCount: familyCount,
    foreignKeyCheckPassed: true,
  };
}

export function migrateLegacyModelFamilyRoles(db: any, options: any = {}) {
  if (!hasLegacyModelFamilyRoleSchema(db)) {
    return false;
  }

  const databaseName = String(db.name || '').trim();
  const isMemoryDatabase = !databaseName || databaseName === ':memory:';
  const backupPath = String(options.backupPath || '').trim();
  if (!isMemoryDatabase && !backupPath) {
    const error: any = new Error('Legacy chat schema requires a verified backup');
    error.code = 'chat_schema_backup_required';
    throw error;
  }

  const before = captureCriticalSnapshot(db);
  const startedAt = new Date().toISOString();
  ensureMigrationLedger(db);
  db.prepare(`
    INSERT INTO chat_schema_migrations (
      migration_id, status, backup_path, pre_counts_json, audit_json,
      error_message, started_at, completed_at
    ) VALUES (?, 'pending', ?, ?, NULL, NULL, ?, NULL)
    ON CONFLICT(migration_id) DO UPDATE SET
      status = 'pending',
      backup_path = excluded.backup_path,
      pre_counts_json = excluded.pre_counts_json,
      audit_json = NULL,
      error_message = NULL,
      started_at = excluded.started_at,
      completed_at = NULL
  `).run(MODEL_FAMILY_ROLE_MIGRATION_ID, backupPath || null, JSON.stringify(before.counts), startedAt);

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN EXCLUSIVE');
    db.exec(`
DROP TRIGGER IF EXISTS chat_messages_search_ai;
DROP TRIGGER IF EXISTS chat_messages_search_ad;
DROP TRIGGER IF EXISTS chat_messages_search_au;
DROP TABLE IF EXISTS chat_message_search;

CREATE TABLE chat_role_identities (
  role_id TEXT PRIMARY KEY,
  display_name_snapshot TEXT NOT NULL,
  avatar_data_url_snapshot TEXT,
  accent_color_snapshot TEXT,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('model_family', 'custom', 'legacy_system')),
  model_family_snapshot TEXT,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'retired')),
  retired_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_agents_migrated (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sandbox_name TEXT,
  description TEXT,
  avatar_data_url TEXT,
  persona_prompt TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  thinking TEXT,
  accent_color TEXT,
  skills_json TEXT,
  model_profiles_json TEXT,
  role_kind TEXT NOT NULL CHECK (role_kind IN ('model_family', 'custom')),
  model_family TEXT,
  is_default_chat_role INTEGER NOT NULL DEFAULT 0 CHECK (is_default_chat_role IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (role_kind = 'model_family' AND model_family IS NOT NULL AND persona_prompt = '')
    OR (role_kind = 'custom' AND model_family IS NULL)
  ),
  FOREIGN KEY (id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);

CREATE TABLE chat_conversation_agent_history (
  conversation_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  display_name_snapshot TEXT NOT NULL,
  role_kind_snapshot TEXT NOT NULL,
  model_family_snapshot TEXT,
  model_profile_id_snapshot TEXT,
  conversation_skills_json TEXT,
  sort_order INTEGER NOT NULL,
  joined_at TEXT,
  retired_at TEXT NOT NULL,
  retired_reason TEXT NOT NULL,
  PRIMARY KEY (conversation_id, role_id, retired_at),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);

CREATE TABLE chat_conversation_agents_migrated (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  model_profile_id TEXT,
  conversation_skills_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE CASCADE
);

CREATE TABLE chat_messages_migrated (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_id TEXT,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  task_id TEXT,
  run_id INTEGER,
  error_message TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);

CREATE TABLE chat_private_messages_migrated (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  sender_agent_id TEXT,
  sender_name TEXT NOT NULL,
  recipient_agent_ids_json TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_agent_id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);

CREATE TABLE chat_memory_cards_migrated (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'conversation-agent',
  owner_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent-tool',
  status TEXT NOT NULL DEFAULT 'active',
  ttl_days INTEGER,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, owner_key, agent_id, title),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT
);
    `);

    const legacyPlaceholders = LEGACY_SYSTEM_ROLE_IDS.map(() => '?').join(',');
    const agentColumns = tableColumns(db, 'chat_agents');
    const participantColumns = tableColumns(db, 'chat_conversation_agents');
    const memoryColumns = hasTable(db, 'chat_memory_cards')
      ? tableColumns(db, 'chat_memory_cards')
      : new Set<string>();
    db.prepare(`
      INSERT INTO chat_role_identities (
        role_id, display_name_snapshot, avatar_data_url_snapshot, accent_color_snapshot,
        origin_kind, model_family_snapshot, lifecycle_state, retired_reason, created_at, updated_at
      )
      SELECT
        id,
        name,
        ${columnExpression(agentColumns, 'avatar_data_url')},
        ${columnExpression(agentColumns, 'accent_color')},
        CASE WHEN id IN (${legacyPlaceholders}) THEN 'legacy_system' ELSE 'custom' END,
        NULL,
        CASE WHEN id IN (${legacyPlaceholders}) THEN 'retired' ELSE 'active' END,
        CASE WHEN id IN (${legacyPlaceholders}) THEN 'legacy_system_replaced' ELSE NULL END,
        created_at,
        updated_at
      FROM chat_agents
    `).run(...LEGACY_SYSTEM_ROLE_IDS, ...LEGACY_SYSTEM_ROLE_IDS, ...LEGACY_SYSTEM_ROLE_IDS);

    db.prepare(`
      INSERT INTO chat_conversation_agent_history (
        conversation_id, role_id, display_name_snapshot, role_kind_snapshot,
        model_family_snapshot, model_profile_id_snapshot, conversation_skills_json,
        sort_order, joined_at, retired_at, retired_reason
      )
      SELECT
        ca.conversation_id,
        ca.agent_id,
        a.name,
        'legacy_system',
        NULL,
        ${participantColumns.has('model_profile_id') ? 'ca.model_profile_id' : 'NULL'},
        ${participantColumns.has('conversation_skills_json') ? 'ca.conversation_skills_json' : 'NULL'},
        ca.sort_order,
        ca.created_at,
        ?,
        'legacy_system_replaced'
      FROM chat_conversation_agents ca
      JOIN chat_agents a ON a.id = ca.agent_id
      WHERE ca.agent_id IN (${legacyPlaceholders})
    `).run(startedAt, ...LEGACY_SYSTEM_ROLE_IDS);

    db.prepare(`
      INSERT INTO chat_agents_migrated (
        id, name, sandbox_name, description, avatar_data_url, persona_prompt, provider,
        model, thinking, accent_color, skills_json, model_profiles_json, role_kind,
        model_family, is_default_chat_role, created_at, updated_at
      )
      SELECT
        ${legacyAgentConfigProjection(db)}, 'custom', NULL, 0,
        created_at, updated_at
      FROM chat_agents
      WHERE id NOT IN (${legacyPlaceholders})
    `).run(...LEGACY_SYSTEM_ROLE_IDS);

    db.prepare(`
      INSERT INTO chat_conversation_agents_migrated (
        conversation_id, agent_id, model_profile_id, conversation_skills_json, sort_order, created_at
      )
      SELECT
        conversation_id,
        agent_id,
        ${columnExpression(participantColumns, 'model_profile_id')},
        ${columnExpression(participantColumns, 'conversation_skills_json')},
        sort_order,
        created_at
      FROM chat_conversation_agents
      WHERE agent_id NOT IN (${legacyPlaceholders})
    `).run(...LEGACY_SYSTEM_ROLE_IDS);

    db.exec(`
INSERT INTO chat_messages_migrated
SELECT id, conversation_id, turn_id, role, agent_id, sender_name, content, status,
       task_id, run_id, error_message, metadata_json, created_at
FROM chat_messages;
DROP TABLE chat_messages;
DROP TABLE chat_conversation_agents;
DROP TABLE chat_agents;

ALTER TABLE chat_agents_migrated RENAME TO chat_agents;
ALTER TABLE chat_conversation_agents_migrated RENAME TO chat_conversation_agents;
ALTER TABLE chat_messages_migrated RENAME TO chat_messages;
    `);

    if (hasTable(db, 'chat_private_messages')) {
      db.exec(`
INSERT INTO chat_private_messages_migrated
SELECT id, conversation_id, turn_id, sender_agent_id, sender_name,
       recipient_agent_ids_json, content, metadata_json, created_at
FROM chat_private_messages;
DROP TABLE chat_private_messages;
      `);
    }
    db.exec('ALTER TABLE chat_private_messages_migrated RENAME TO chat_private_messages');

    if (hasTable(db, 'chat_memory_cards')) {
      const ownerKeyExpression = memoryColumns.has('owner_key')
        ? 'owner_key'
        : "CASE WHEN COALESCE(scope, 'conversation-agent') = 'local-user-agent' THEN 'local-user' ELSE conversation_id END";
      db.exec(`
INSERT INTO chat_memory_cards_migrated
SELECT
  id,
  conversation_id,
  agent_id,
  CASE WHEN COALESCE(scope, 'conversation-agent') = 'local-user-agent' THEN 'local-user-agent' ELSE 'conversation-agent' END,
  ${ownerKeyExpression},
  title,
  content,
  source,
  status,
  ttl_days,
  expires_at,
  metadata_json,
  created_at,
  updated_at
FROM chat_memory_cards;
DROP TABLE chat_memory_cards;
      `);
    }
    db.exec('ALTER TABLE chat_memory_cards_migrated RENAME TO chat_memory_cards');

    reconcileSystemModelFamilyRoles(db, startedAt);
    const audit = assertMigrationAudit(db, before);
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE chat_schema_migrations
      SET status = 'completed', audit_json = ?, error_message = NULL, completed_at = ?
      WHERE migration_id = ?
    `).run(JSON.stringify(audit), completedAt, MODEL_FAMILY_ROLE_MIGRATION_ID);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    try {
      db.prepare(`
        UPDATE chat_schema_migrations
        SET status = 'failed', error_message = ?, completed_at = NULL
        WHERE migration_id = ?
      `).run('migration_failed', MODEL_FAMILY_ROLE_MIGRATION_ID);
    } catch {}
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  return true;
}
