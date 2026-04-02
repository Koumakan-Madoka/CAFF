function listTableColumns(db: any, tableName: string) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((column: any) => String(column.name)));
}

function ensureColumn(db: any, tableName: string, columnName: string, definitionSql: string) {
  if (listTableColumns(db, tableName).has(columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
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

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  turn_id TEXT,
  message_id TEXT,
  stage_task_id TEXT,
  agent_id TEXT,
  agent_name TEXT,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  prompt_version TEXT,
  model_profile_id TEXT,
  expectations_json TEXT,
  prompt_a TEXT NOT NULL,
  output_a TEXT NOT NULL,
  prompt_b TEXT,
  output_b TEXT,
  b_run_id INTEGER,
  b_task_id TEXT,
  b_status TEXT,
  b_error_message TEXT,
  b_result_json TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_case_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  variant TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  prompt TEXT NOT NULL,
  run_id INTEGER,
  task_id TEXT,
  status TEXT,
  error_message TEXT,
  output_text TEXT,
  result_json TEXT,
  session_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES eval_cases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at ON chat_conversations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_message_at ON chat_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_conversation_agents_agent_id ON chat_conversation_agents (agent_id, sort_order ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages (conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_turn_id ON chat_messages (turn_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_private_messages_conversation_id ON chat_private_messages (conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_chat_private_messages_sender_agent_id ON chat_private_messages (sender_agent_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_eval_cases_created_at ON eval_cases (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_cases_message_id ON eval_cases (message_id);
CREATE INDEX IF NOT EXISTS idx_eval_case_runs_case_id ON eval_case_runs (case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_case_runs_task_id ON eval_case_runs (task_id);
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

export function migrateSkillTestSchema(db: any) {
  db.exec(`
CREATE TABLE IF NOT EXISTS skill_test_cases (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  eval_case_id TEXT,
  test_type TEXT NOT NULL DEFAULT 'trigger',
  loading_mode TEXT NOT NULL DEFAULT 'dynamic',
  trigger_prompt TEXT NOT NULL,
  expected_tools_json TEXT NOT NULL DEFAULT '[]',
  expected_behavior TEXT NOT NULL DEFAULT '',
  validity_status TEXT NOT NULL DEFAULT 'pending',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_test_runs (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  eval_case_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  actual_tools_json TEXT NOT NULL DEFAULT '[]',
  tool_accuracy REAL,
  trigger_passed INTEGER,
  execution_passed INTEGER,
  error_message TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES skill_test_cases(id)
);

CREATE INDEX IF NOT EXISTS idx_skill_test_cases_skill_id ON skill_test_cases (skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_test_cases_validity ON skill_test_cases (validity_status);
CREATE INDEX IF NOT EXISTS idx_skill_test_runs_case_id ON skill_test_runs (test_case_id, created_at DESC);
  `);
}
