import {
  migrateLegacyModelFamilyRoles,
  reconcileSystemModelFamilyRoles,
} from './model-family-role-migration';

function listTableInfo(db: any, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function isTruthyEnvFlag(value: any) {
  if (value === true || value === 1) {
    return true;
  }

  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function emitSqliteMigrationDebug(message: string, error: any) {
  if (!isTruthyEnvFlag(process.env.CAFF_DEBUG_SQLITE_MIGRATIONS)) {
    return;
  }

  const detail = error && error.message ? String(error.message) : String(error || 'unknown error');
  console.warn(`[sqlite-migration] ${message}: ${detail}`);
}

function listTableColumns(db: any, tableName: string) {
  return new Set(listTableInfo(db, tableName).map((column: any) => String(column.name)));
}

function ensureColumn(db: any, tableName: string, columnName: string, definitionSql: string) {
  if (listTableColumns(db, tableName).has(columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
}

function ensureChatMessageSearchSchema(db: any) {
  try {
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS chat_message_search USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  turn_id UNINDEXED,
  role UNINDEXED,
  agent_id UNINDEXED,
  sender_name,
  content,
  status UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS chat_messages_search_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_message_search (
    rowid,
    message_id,
    conversation_id,
    turn_id,
    role,
    agent_id,
    sender_name,
    content,
    status,
    created_at
  ) VALUES (
    new.rowid,
    new.id,
    new.conversation_id,
    new.turn_id,
    new.role,
    new.agent_id,
    new.sender_name,
    new.content,
    new.status,
    new.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_search_ad AFTER DELETE ON chat_messages BEGIN
  DELETE FROM chat_message_search WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_search_au AFTER UPDATE ON chat_messages BEGIN
  DELETE FROM chat_message_search WHERE rowid = old.rowid;
  INSERT INTO chat_message_search (
    rowid,
    message_id,
    conversation_id,
    turn_id,
    role,
    agent_id,
    sender_name,
    content,
    status,
    created_at
  ) VALUES (
    new.rowid,
    new.id,
    new.conversation_id,
    new.turn_id,
    new.role,
    new.agent_id,
    new.sender_name,
    new.content,
    new.status,
    new.created_at
  );
END;
    `);

    db.exec(`
INSERT INTO chat_message_search (
  rowid,
  message_id,
  conversation_id,
  turn_id,
  role,
  agent_id,
  sender_name,
  content,
  status,
  created_at
)
SELECT
  m.rowid,
  m.id,
  m.conversation_id,
  m.turn_id,
  m.role,
  m.agent_id,
  m.sender_name,
  m.content,
  m.status,
  m.created_at
FROM chat_messages m
WHERE NOT EXISTS (
  SELECT 1
  FROM chat_message_search s
  WHERE s.rowid = m.rowid
);
    `);
  } catch (error) {
    emitSqliteMigrationDebug('chat_message_search schema setup skipped', error);
  }
}

function ensureChatMemoryCardSchema(db: any) {
  const columns = listTableInfo(db, 'chat_memory_cards');

  if (!Array.isArray(columns) || columns.length === 0) {
    return;
  }

  const hasOwnerKey = columns.some((column: any) => String(column && column.name || '') === 'owner_key');
  const conversationColumn = columns.find((column: any) => String(column && column.name || '') === 'conversation_id');
  const conversationAllowsNull = !conversationColumn || Number(conversationColumn.notnull || 0) === 0;

  if (hasOwnerKey && conversationAllowsNull) {
    db.exec(`
CREATE INDEX IF NOT EXISTS idx_chat_memory_cards_scope
  ON chat_memory_cards(scope, owner_key, agent_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_memory_cards_expires_at
  ON chat_memory_cards(expires_at);
`);
    return;
  }

  db.exec(`
DROP INDEX IF EXISTS idx_chat_memory_cards_scope;
DROP INDEX IF EXISTS idx_chat_memory_cards_expires_at;
`);

  db.exec(`
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

INSERT INTO chat_memory_cards_migrated (
  id,
  conversation_id,
  agent_id,
  scope,
  owner_key,
  title,
  content,
  source,
  status,
  ttl_days,
  expires_at,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  id,
  conversation_id,
  agent_id,
  CASE
    WHEN COALESCE(scope, 'conversation-agent') = 'local-user-agent' THEN 'local-user-agent'
    ELSE 'conversation-agent'
  END,
  CASE
    WHEN COALESCE(scope, 'conversation-agent') = 'local-user-agent' THEN 'local-user'
    ELSE conversation_id
  END,
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
ALTER TABLE chat_memory_cards_migrated RENAME TO chat_memory_cards;

CREATE INDEX IF NOT EXISTS idx_chat_memory_cards_scope
  ON chat_memory_cards(scope, owner_key, agent_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_memory_cards_expires_at
  ON chat_memory_cards(expires_at);
`);
}

const CHAT_CONVERSATION_LINEAGE_COLUMNS = [
  'project_scope_id',
  'parent_conversation_id',
  'origin_conversation_id',
  'origin_message_id',
  'tree_depth',
];

function createChatConversationTableSql(tableName: string) {
  return `
CREATE TABLE ${tableName} (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  metadata_json TEXT,
  project_scope_id TEXT,
  parent_conversation_id TEXT,
  origin_conversation_id TEXT,
  origin_message_id TEXT,
  tree_depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  CHECK (project_scope_id IS NULL OR length(trim(project_scope_id)) > 0),
  CHECK (parent_conversation_id IS NULL OR parent_conversation_id <> id),
  CHECK (origin_conversation_id IS NULL OR origin_conversation_id <> id),
  CHECK (tree_depth BETWEEN 0 AND 2),
  CHECK (
    (parent_conversation_id IS NULL AND tree_depth = 0)
    OR (parent_conversation_id IS NOT NULL AND tree_depth BETWEEN 1 AND 2)
  ),
  CHECK (parent_conversation_id IS NULL OR origin_conversation_id IS NOT NULL),
  FOREIGN KEY (parent_conversation_id) REFERENCES ${tableName}(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_conversation_id) REFERENCES ${tableName}(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
);`;
}

function ensureChatConversationLineageSchema(db: any) {
  const columns = listTableInfo(db, 'chat_conversations');
  if (!Array.isArray(columns) || columns.length === 0) {
    return;
  }

  const columnNames = new Set(columns.map((column: any) => String(column.name)));
  const foreignKeySources = new Set(
    db.prepare('PRAGMA foreign_key_list(chat_conversations)').all()
      .map((foreignKey: any) => String(foreignKey.from || ''))
  );
  const tableDefinition = String(
    db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'chat_conversations'
      LIMIT 1
    `).get()?.sql || ''
  );
  const hasCompleteLineageSchema =
    CHAT_CONVERSATION_LINEAGE_COLUMNS.every((columnName) => columnNames.has(columnName))
    && ['parent_conversation_id', 'origin_conversation_id', 'origin_message_id']
      .every((columnName) => foreignKeySources.has(columnName))
    && /tree_depth\s+BETWEEN\s+0\s+AND\s+2/i.test(tableDefinition)
    && /parent_conversation_id\s+IS\s+NULL\s+OR\s+parent_conversation_id\s*<>\s*id/i.test(tableDefinition);

  if (!hasCompleteLineageSchema) {
    const selectColumn = (columnName: string, fallbackSql: string) =>
      columnNames.has(columnName) ? columnName : fallbackSql;
    const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true }) || 0) === 1;

    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = OFF');
    }

    try {
      db.exec(`
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS chat_conversations_lineage_migrated;
${createChatConversationTableSql('chat_conversations_lineage_migrated')}

INSERT INTO chat_conversations_lineage_migrated (
  id,
  title,
  type,
  metadata_json,
  project_scope_id,
  parent_conversation_id,
  origin_conversation_id,
  origin_message_id,
  tree_depth,
  created_at,
  updated_at,
  last_message_at
)
SELECT
  id,
  title,
  ${selectColumn('type', "'standard'")},
  ${selectColumn('metadata_json', 'NULL')},
  ${selectColumn('project_scope_id', 'NULL')},
  ${selectColumn('parent_conversation_id', 'NULL')},
  ${selectColumn('origin_conversation_id', 'NULL')},
  ${selectColumn('origin_message_id', 'NULL')},
  ${selectColumn('tree_depth', '0')},
  created_at,
  updated_at,
  last_message_at
FROM chat_conversations;

DROP TABLE chat_conversations;
ALTER TABLE chat_conversations_lineage_migrated RENAME TO chat_conversations;
COMMIT;
      `);
    } catch (error) {
      if (db.inTransaction) {
        db.exec('ROLLBACK;');
      }
      throw error;
    } finally {
      if (foreignKeysEnabled) {
        db.pragma('foreign_keys = ON');
      }
    }
  }

  db.exec(`
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at
  ON chat_conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_message_at
  ON chat_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_tree_parent
  ON chat_conversations (parent_conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_project_scope
  ON chat_conversations (project_scope_id, created_at ASC, id ASC);
  `);

  const foreignKeyViolations = db.pragma('foreign_key_check');
  if (Array.isArray(foreignKeyViolations) && foreignKeyViolations.length > 0) {
    throw new Error('Conversation lineage migration left foreign key violations');
  }
}

function ensureCrossConversationDeliverySchema(db: any) {
  db.exec(`
CREATE TABLE IF NOT EXISTS chat_cross_conversation_deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('notify', 'request', 'bootstrap')),
  idempotency_scope TEXT NOT NULL CHECK (length(trim(idempotency_scope)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('agent', 'operator')),
  source_conversation_id TEXT NOT NULL,
  source_message_id TEXT,
  source_turn_id TEXT,
  source_invocation_id TEXT,
  source_agent_id TEXT,
  source_agent_name TEXT NOT NULL CHECK (length(trim(source_agent_name)) > 0),
  source_project_scope_id TEXT NOT NULL CHECK (length(trim(source_project_scope_id)) > 0),
  target_conversation_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  target_message_id TEXT,
  source_receipt_message_id TEXT,
  target_project_scope_id TEXT NOT NULL CHECK (length(trim(target_project_scope_id)) > 0),
  trace_id TEXT NOT NULL CHECK (length(trim(trace_id)) > 0),
  root_delivery_id TEXT NOT NULL,
  parent_delivery_id TEXT,
  reply_to_delivery_id TEXT,
  hop_count INTEGER NOT NULL DEFAULT 0 CHECK (hop_count BETWEEN 0 AND 8),
  message_status TEXT NOT NULL CHECK (message_status IN ('pending', 'persisted', 'failed')),
  dispatch_status TEXT NOT NULL CHECK (
    dispatch_status IN (
      'not_requested', 'queued', 'running', 'completed',
      'failed', 'cancel_requested', 'cancelled'
    )
  ),
  response_status TEXT NOT NULL CHECK (
    response_status IN ('not_expected', 'waiting', 'received', 'timed_out', 'cancelled', 'late')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  deadline_at TEXT,
  cancel_requested_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  claim_owner TEXT,
  claim_expires_at TEXT,
  next_attempt_at TEXT,
  target_invocation_id TEXT,
  delivered_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  responded_at TEXT,
  terminal_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (idempotency_scope, idempotency_key),
  CHECK (source_conversation_id <> target_conversation_id),
  CHECK (source_project_scope_id = target_project_scope_id),
  CHECK (
    (claim_owner IS NULL AND claim_expires_at IS NULL)
    OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CHECK (started_at IS NULL OR target_invocation_id IS NOT NULL),
  CHECK (
    message_status <> 'persisted'
    OR (
      target_message_id IS NOT NULL
      AND (reply_to_delivery_id IS NOT NULL OR source_receipt_message_id IS NOT NULL)
    )
  ),
  CHECK (
    (kind = 'request' AND response_status <> 'not_expected')
    OR (kind IN ('notify', 'bootstrap') AND response_status = 'not_expected')
  ),
  FOREIGN KEY (source_conversation_id) REFERENCES chat_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_message_id) REFERENCES chat_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_agent_id) REFERENCES chat_role_identities(role_id) ON DELETE SET NULL,
  FOREIGN KEY (target_conversation_id) REFERENCES chat_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (target_agent_id) REFERENCES chat_role_identities(role_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_message_id) REFERENCES chat_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_receipt_message_id) REFERENCES chat_messages(id) ON DELETE RESTRICT,
  FOREIGN KEY (root_delivery_id) REFERENCES chat_cross_conversation_deliveries(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_delivery_id) REFERENCES chat_cross_conversation_deliveries(id) ON DELETE RESTRICT,
  FOREIGN KEY (reply_to_delivery_id) REFERENCES chat_cross_conversation_deliveries(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS chat_cross_conversation_delivery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  actor_kind TEXT,
  actor_id TEXT,
  event_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (delivery_id) REFERENCES chat_cross_conversation_deliveries(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_delivery_target_message
  ON chat_cross_conversation_deliveries (target_message_id)
  WHERE target_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_delivery_source_receipt_message
  ON chat_cross_conversation_deliveries (source_receipt_message_id)
  WHERE source_receipt_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_delivery_reply_to
  ON chat_cross_conversation_deliveries (reply_to_delivery_id)
  WHERE reply_to_delivery_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_delivery_trace_edge
  ON chat_cross_conversation_deliveries (
    trace_id,
    source_conversation_id,
    target_conversation_id
  );
CREATE INDEX IF NOT EXISTS idx_cross_delivery_source_conversation
  ON chat_cross_conversation_deliveries (source_conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cross_delivery_target_conversation
  ON chat_cross_conversation_deliveries (target_conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_cross_delivery_claimable
  ON chat_cross_conversation_deliveries (
    dispatch_status,
    next_attempt_at,
    claim_expires_at,
    created_at,
    id
  )
  WHERE dispatch_status = 'queued';
CREATE INDEX IF NOT EXISTS idx_cross_delivery_deadline
  ON chat_cross_conversation_deliveries (response_status, deadline_at, id)
  WHERE response_status = 'waiting' AND deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cross_delivery_events_delivery
  ON chat_cross_conversation_delivery_events (delivery_id, created_at ASC, id ASC);

CREATE TRIGGER IF NOT EXISTS chat_cross_delivery_events_append_only_update
BEFORE UPDATE ON chat_cross_conversation_delivery_events
BEGIN
  SELECT RAISE(ABORT, 'cross-conversation delivery events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS chat_cross_delivery_events_append_only_delete
BEFORE DELETE ON chat_cross_conversation_delivery_events
BEGIN
  SELECT RAISE(ABORT, 'cross-conversation delivery events are append-only');
END;
  `);
}

export function migrateChatSchema(db: any, options: any = {}) {
  migrateLegacyModelFamilyRoles(db, { backupPath: options.backupPath });
  db.exec(`
CREATE TABLE IF NOT EXISTS chat_role_identities (
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

CREATE TABLE IF NOT EXISTS chat_agents (
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

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  metadata_json TEXT,
  project_scope_id TEXT,
  parent_conversation_id TEXT,
  origin_conversation_id TEXT,
  origin_message_id TEXT,
  tree_depth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  CHECK (project_scope_id IS NULL OR length(trim(project_scope_id)) > 0),
  CHECK (parent_conversation_id IS NULL OR parent_conversation_id <> id),
  CHECK (origin_conversation_id IS NULL OR origin_conversation_id <> id),
  CHECK (tree_depth BETWEEN 0 AND 2),
  CHECK (
    (parent_conversation_id IS NULL AND tree_depth = 0)
    OR (parent_conversation_id IS NOT NULL AND tree_depth BETWEEN 1 AND 2)
  ),
  CHECK (parent_conversation_id IS NULL OR origin_conversation_id IS NOT NULL),
  FOREIGN KEY (parent_conversation_id) REFERENCES chat_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_conversation_id) REFERENCES chat_conversations(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_conversation_agents (
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

CREATE TABLE IF NOT EXISTS chat_conversation_agent_history (
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

CREATE TABLE IF NOT EXISTS chat_messages (
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

CREATE TABLE IF NOT EXISTS chat_private_messages (
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

CREATE TABLE IF NOT EXISTS chat_memory_cards (
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

CREATE TABLE IF NOT EXISTS chat_summary_segments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  source_digest_id TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'entry',
  conversation_title TEXT NOT NULL DEFAULT '',
  task_name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  open_questions_json TEXT NOT NULL DEFAULT '[]',
  next_actions_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  trigger_reason TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  from_message_id TEXT,
  to_message_id TEXT,
  created_by TEXT,
  segment_created_at TEXT NOT NULL,
  segment_updated_at TEXT NOT NULL,
  metadata_json TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_digest_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_channel_bindings (
  platform TEXT NOT NULL,
  external_chat_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, external_chat_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_external_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL,
  external_event_id TEXT,
  external_message_id TEXT,
  conversation_id TEXT,
  message_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);



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

CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at ON chat_conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_message_at ON chat_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversation_agents_agent_id ON chat_conversation_agents (agent_id, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages (conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_turn_id ON chat_messages (turn_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_private_messages_conversation_id ON chat_private_messages (conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_private_messages_sender_agent_id ON chat_private_messages (sender_agent_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_summary_segments_conversation_id ON chat_summary_segments (conversation_id, segment_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_summary_segments_updated_at ON chat_summary_segments (segment_updated_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channel_bindings_platform_conversation_id ON chat_channel_bindings (platform, conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_channel_bindings_conversation_id ON chat_channel_bindings (conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_external_events_conversation_id ON chat_external_events (conversation_id, created_at ASC, id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_external_events_platform_direction_event_id
  ON chat_external_events (platform, direction, external_event_id)
  WHERE external_event_id IS NOT NULL AND external_event_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_external_events_platform_direction_external_message_id
  ON chat_external_events (platform, direction, external_message_id)
  WHERE external_message_id IS NOT NULL AND external_message_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_external_events_platform_direction_message_id
  ON chat_external_events (platform, direction, message_id)
  WHERE message_id IS NOT NULL AND message_id <> '';

CREATE TABLE IF NOT EXISTS image_upload_batches (
  batch_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_token TEXT,
  lease_expires_at TEXT,
  rejected_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(conversation_id, client_request_id),
  CHECK (1 <= expected_count AND expected_count <= 5),
  CHECK (status IN ('pending', 'complete', 'rejected')),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR (rejected_reason IS NOT NULL AND rejected_reason <> ''))
);

CREATE TABLE IF NOT EXISTS image_uploads (
  image_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL,
  slot INTEGER NOT NULL,
  file_name TEXT,
  stored_path TEXT NOT NULL,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  attached_message_id TEXT,
  attached_at TEXT,
  integrity_status TEXT NOT NULL DEFAULT 'ok',
  integrity_error TEXT,
  created_at TEXT NOT NULL,
  ttl_expires_at TEXT,
  UNIQUE(batch_id, slot),
  CHECK (status IN ('staged', 'attached', 'recycled')),
  CHECK (integrity_status IN ('ok', 'missing_file')),
  CHECK (0 <= slot AND slot < 5),
  CHECK ((integrity_status = 'ok') = (integrity_error IS NULL)),
  CHECK (integrity_status <> 'missing_file' OR (integrity_error IS NOT NULL AND integrity_error <> '')),
  CHECK (status = 'attached' OR (attached_message_id IS NULL AND attached_at IS NULL)),
  CHECK (status <> 'attached' OR (attached_message_id IS NOT NULL AND attached_at IS NOT NULL)),
  CHECK (status <> 'recycled' OR (ttl_expires_at IS NOT NULL)),
  FOREIGN KEY (batch_id) REFERENCES image_upload_batches(batch_id),
  FOREIGN KEY (attached_message_id) REFERENCES chat_messages(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_image_upload_batches_conversation ON image_upload_batches (conversation_id);
CREATE INDEX IF NOT EXISTS idx_image_uploads_batch_id ON image_uploads (batch_id, slot ASC);
CREATE INDEX IF NOT EXISTS idx_image_uploads_attached_message ON image_uploads (attached_message_id);
CREATE INDEX IF NOT EXISTS idx_image_uploads_ttl ON image_uploads (ttl_expires_at);
CREATE INDEX IF NOT EXISTS idx_image_uploads_status ON image_uploads (status);
  `);

  ensureColumn(db, 'chat_agents', 'model_profiles_json', 'model_profiles_json TEXT');
  ensureColumn(db, 'chat_agents', 'avatar_data_url', 'avatar_data_url TEXT');
  ensureColumn(db, 'chat_agents', 'sandbox_name', 'sandbox_name TEXT');
  ensureColumn(db, 'chat_agents', 'skills_json', 'skills_json TEXT');
  ensureColumn(db, 'chat_conversations', 'type', "type TEXT NOT NULL DEFAULT 'standard'");
  ensureColumn(db, 'chat_conversations', 'metadata_json', 'metadata_json TEXT');
  ensureColumn(db, 'chat_conversation_agents', 'model_profile_id', 'model_profile_id TEXT');
  ensureColumn(
    db,
    'chat_conversation_agents',
    'conversation_skills_json',
    'conversation_skills_json TEXT'
  );

  ensureChatConversationLineageSchema(db);
  ensureCrossConversationDeliverySchema(db);

  ensureChatMessageSearchSchema(db);
  ensureChatMemoryCardSchema(db);
  reconcileSystemModelFamilyRoles(db);

  db.exec(`
CREATE TABLE IF NOT EXISTS modes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,
  skill_ids_json TEXT NOT NULL DEFAULT '[]',
  loading_strategy TEXT NOT NULL DEFAULT 'dynamic',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
  `);
}

export function migrateRunSchema(db: any) {
  db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_dir TEXT NOT NULL,
  session_path TEXT NOT NULL UNIQUE,
  session_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_id INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  session_path TEXT,
  requested_session TEXT,
  requested_resume INTEGER NOT NULL DEFAULT 0,
  agent_dir TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  prompt TEXT NOT NULL,
  prompt_length INTEGER NOT NULL,
  timeout_ms INTEGER,
  idle_timeout_ms INTEGER,
  heartbeat_interval_ms INTEGER,
  heartbeat_timeout_ms INTEGER,
  terminate_grace_ms INTEGER,
  parent_run_id INTEGER,
  task_id TEXT,
  task_kind TEXT,
  task_role TEXT,
  run_metadata_json TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  termination_type TEXT,
  termination_signal TEXT,
  error_message TEXT,
  reply TEXT,
  reply_length INTEGER,
  stderr_tail TEXT,
  parse_errors INTEGER NOT NULL DEFAULT 0,
  assistant_errors_json TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (parent_run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT,
  parent_run_id INTEGER,
  run_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  assigned_agent TEXT,
  assigned_role TEXT,
  provider TEXT,
  model TEXT,
  requested_session TEXT,
  session_path TEXT,
  input_text TEXT,
  output_text TEXT,
  error_message TEXT,
  metadata_json TEXT,
  artifact_summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  FOREIGN KEY (parent_task_id) REFERENCES a2a_tasks(id),
  FOREIGN KEY (parent_run_id) REFERENCES runs(id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS a2a_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id)
);

CREATE TABLE IF NOT EXISTS a2a_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  mime_type TEXT,
  content_text TEXT,
  uri TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES a2a_tasks(id)
);
  `);

  ensureColumn(db, 'runs', 'heartbeat_interval_ms', 'heartbeat_interval_ms INTEGER');
  ensureColumn(db, 'runs', 'heartbeat_timeout_ms', 'heartbeat_timeout_ms INTEGER');
  ensureColumn(db, 'runs', 'parent_run_id', 'parent_run_id INTEGER');
  ensureColumn(db, 'runs', 'task_id', 'task_id TEXT');
  ensureColumn(db, 'runs', 'task_kind', 'task_kind TEXT');
  ensureColumn(db, 'runs', 'task_role', 'task_role TEXT');
  ensureColumn(db, 'runs', 'run_metadata_json', 'run_metadata_json TEXT');

  db.exec(`
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id ON runs (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs (task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_parent_task_id ON a2a_tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_parent_run_id ON a2a_tasks (parent_run_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_run_id ON a2a_tasks (run_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status ON a2a_tasks (status);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_updated_at ON a2a_tasks (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_task_events_task_id ON a2a_task_events (task_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task_id ON a2a_artifacts (task_id, created_at ASC);
  `);
}
