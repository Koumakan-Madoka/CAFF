const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadSandboxEnvModule() {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', '..', 'build', 'lib', 'pi-skill-test-sandbox-env.mjs')).href;
  return import(moduleUrl);
}

test('skill-test sandbox extension only forwards allowlisted bash env keys', async () => {
  const { collectDefaultBashEnv } = await loadSandboxEnvModule();
  const env = collectDefaultBashEnv({
    CAFF_CHAT_API_URL: 'https://bridge.example.test',
    CAFF_CHAT_INVOCATION_ID: 'inv-1',
    CAFF_CHAT_CALLBACK_TOKEN: 'callback-1',
    CAFF_CHAT_TOOLS_PATH: '/case/runtime/agent-chat-tools.js',
    CAFF_CHAT_TOOLS_RELATIVE_PATH: '../runtime/agent-chat-tools.js',
    CAFF_CHAT_TOOL_ECHO_CONTENT: '1',
    CAFF_TRELLIS_PROJECT_DIR: '/case/project',
    CAFF_SKILL_TEST_RUN_ID: 'run-1',
    CAFF_SKILL_TEST_CASE_ID: 'case-1',
    CAFF_SKILL_TEST_SKILL_PATH: '/case/agent/skills/demo/SKILL.md',
    CAFF_SKILL_TEST_VISIBLE_ROOT: '/case',
    CAFF_SKILL_TEST_VISIBLE_AGENT_DIR: '/case/agent',
    CAFF_SKILL_TEST_VISIBLE_PROJECT_DIR: '/case/project',
    CAFF_SKILL_TEST_VISIBLE_OUTPUT_DIR: '/case/output',
    CAFF_SKILL_TEST_VISIBLE_SANDBOX_DIR: '/case/agent/agent-sandboxes/agent',
    CAFF_SKILL_TEST_VISIBLE_PRIVATE_DIR: '/case/agent/agent-sandboxes/agent/private',
    CAFF_SKILL_TEST_VISIBLE_SQLITE_PATH: '/case/output/chat.sqlite',
    CAFF_SKILL_TEST_VISIBLE_SKILL_PATH: '/case/agent/skills/demo/SKILL.md',
    PI_AGENT_ID: 'skill-test-agent',
    PI_CODING_AGENT_DIR: '/case/agent',
    PI_AGENT_SANDBOX_DIR: '/case/agent/agent-sandboxes/agent',
    PI_AGENT_PRIVATE_DIR: '/case/agent/agent-sandboxes/agent/private',
    PI_SQLITE_PATH: '/case/output/chat.sqlite',
    CAFF_OPENSANDBOX_SANDBOX_ID: 'should-not-pass',
    CUSTOM_TOKEN: 'should-not-pass',
    KIMI_API_KEY: 'should-not-pass',
    PI_ENV: 'should-not-pass',
    PI_MODEL: 'should-not-pass',
    PI_PROVIDER: 'should-not-pass',
    ZAI_API_KEY: 'should-not-pass',
  });

  assert.deepEqual(env, {
    CAFF_CHAT_API_URL: 'https://bridge.example.test',
    CAFF_CHAT_INVOCATION_ID: 'inv-1',
    CAFF_CHAT_CALLBACK_TOKEN: 'callback-1',
    CAFF_CHAT_TOOLS_PATH: '/case/runtime/agent-chat-tools.js',
    CAFF_CHAT_TOOLS_RELATIVE_PATH: '../runtime/agent-chat-tools.js',
    CAFF_CHAT_TOOL_ECHO_CONTENT: '1',
    CAFF_TRELLIS_PROJECT_DIR: '/case/project',
    CAFF_SKILL_TEST_RUN_ID: 'run-1',
    CAFF_SKILL_TEST_CASE_ID: 'case-1',
    CAFF_SKILL_TEST_SKILL_PATH: '/case/agent/skills/demo/SKILL.md',
    CAFF_SKILL_TEST_VISIBLE_ROOT: '/case',
    CAFF_SKILL_TEST_VISIBLE_AGENT_DIR: '/case/agent',
    CAFF_SKILL_TEST_VISIBLE_PROJECT_DIR: '/case/project',
    CAFF_SKILL_TEST_VISIBLE_OUTPUT_DIR: '/case/output',
    CAFF_SKILL_TEST_VISIBLE_SANDBOX_DIR: '/case/agent/agent-sandboxes/agent',
    CAFF_SKILL_TEST_VISIBLE_PRIVATE_DIR: '/case/agent/agent-sandboxes/agent/private',
    CAFF_SKILL_TEST_VISIBLE_SQLITE_PATH: '/case/output/chat.sqlite',
    CAFF_SKILL_TEST_VISIBLE_SKILL_PATH: '/case/agent/skills/demo/SKILL.md',
    PI_AGENT_ID: 'skill-test-agent',
    PI_CODING_AGENT_DIR: '/case/agent',
    PI_AGENT_SANDBOX_DIR: '/case/agent/agent-sandboxes/agent',
    PI_AGENT_PRIVATE_DIR: '/case/agent/agent-sandboxes/agent/private',
    PI_SQLITE_PATH: '/case/output/chat.sqlite',
  });
});
