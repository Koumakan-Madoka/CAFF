const DEFAULT_BASH_ENV_KEYS = Object.freeze([
  'CAFF_CHAT_API_URL',
  'CAFF_CHAT_INVOCATION_ID',
  'CAFF_CHAT_CALLBACK_TOKEN',
  'CAFF_CHAT_TOOLS_PATH',
  'CAFF_CHAT_TOOLS_RELATIVE_PATH',
  'CAFF_CHAT_TOOL_ECHO_CONTENT',
  'CAFF_TRELLIS_PROJECT_DIR',
  'CAFF_SKILL_TEST_RUN_ID',
  'CAFF_SKILL_TEST_CASE_ID',
  'CAFF_SKILL_TEST_SKILL_PATH',
  'CAFF_SKILL_TEST_VISIBLE_ROOT',
  'CAFF_SKILL_TEST_VISIBLE_AGENT_DIR',
  'CAFF_SKILL_TEST_VISIBLE_PROJECT_DIR',
  'CAFF_SKILL_TEST_VISIBLE_OUTPUT_DIR',
  'CAFF_SKILL_TEST_VISIBLE_SANDBOX_DIR',
  'CAFF_SKILL_TEST_VISIBLE_PRIVATE_DIR',
  'CAFF_SKILL_TEST_VISIBLE_SQLITE_PATH',
  'CAFF_SKILL_TEST_VISIBLE_SKILL_PATH',
  'PI_AGENT_ID',
  'PI_CODING_AGENT_DIR',
  'PI_AGENT_SANDBOX_DIR',
  'PI_AGENT_PRIVATE_DIR',
  'PI_SQLITE_PATH',
]);
const DEFAULT_BASH_ENV_KEY_SET = new Set(DEFAULT_BASH_ENV_KEYS);

export function collectDefaultBashEnv(sourceEnv = process.env) {
  /** @type {Record<string, string>} */
  const env = {};

  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (!DEFAULT_BASH_ENV_KEY_SET.has(key)) {
      continue;
    }
    env[key] = String(value);
  }

  return env;
}

export { DEFAULT_BASH_ENV_KEYS };
