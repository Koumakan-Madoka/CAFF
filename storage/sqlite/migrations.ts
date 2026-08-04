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
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE CASCADE
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

export function migrateChatSchema(db: any) {
  db.exec(`
CREATE TABLE IF NOT EXISTS chat_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sandbox_name TEXT,
  description TEXT,
  avatar_data_url TEXT,
  persona_prompt TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  accent_color TEXT,
  skills_json TEXT,
  model_profiles_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT
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
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE SET NULL
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
  FOREIGN KEY (sender_agent_id) REFERENCES chat_agents(id) ON DELETE SET NULL
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
  FOREIGN KEY (agent_id) REFERENCES chat_agents(id) ON DELETE CASCADE
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


  ensureChatMessageSearchSchema(db);
  ensureChatMemoryCardSchema(db);

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
