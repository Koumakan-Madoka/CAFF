const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseEnvFile, loadDotEnvLocal } = require('../../build/lib/env-local-loader');
const { withTempDir } = require('../helpers/temp-dir');

test('env local loader parses simple dotenv content', () => {
  const parsed = parseEnvFile([
    '# comment',
    'FEISHU_APP_ID=cli_test_app',
    'export FEISHU_CONNECTION_MODE=long-connection',
    'FEISHU_APP_SECRET="quoted secret"',
    "EMPTY_VALUE=",
  ].join('\n'));

  assert.deepEqual(parsed, {
    FEISHU_APP_ID: 'cli_test_app',
    FEISHU_CONNECTION_MODE: 'long-connection',
    FEISHU_APP_SECRET: 'quoted secret',
    EMPTY_VALUE: '',
  });
});

test('env local loader applies missing keys without overriding existing env', (t) => {
  const tempDir = withTempDir('caff-env-local-loader-');
  const filePath = path.join(tempDir, '.env.local');
  fs.writeFileSync(
    filePath,
    [
      'FEISHU_APP_ID=cli_from_file',
      'FEISHU_CONNECTION_MODE=long-connection',
      'CHAT_APP_PORT=3200',
    ].join('\n'),
    'utf8'
  );

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const env = {
    FEISHU_APP_ID: 'cli_from_process',
  };
  const result = loadDotEnvLocal({
    filePath,
    env,
  });

  assert.equal(result.exists, true);
  assert.deepEqual(result.appliedKeys, ['FEISHU_CONNECTION_MODE', 'CHAT_APP_PORT']);
  assert.deepEqual(result.skippedKeys, ['FEISHU_APP_ID']);
  assert.equal(env.FEISHU_APP_ID, 'cli_from_process');
  assert.equal(env.FEISHU_CONNECTION_MODE, 'long-connection');
  assert.equal(env.CHAT_APP_PORT, '3200');
});

test('env local loader can be disabled explicitly', (t) => {
  const tempDir = withTempDir('caff-env-local-loader-disabled-');
  const filePath = path.join(tempDir, '.env.local');
  fs.writeFileSync(filePath, 'FEISHU_APP_ID=cli_from_file\n', 'utf8');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const env = {
    CAFF_DISABLE_ENV_LOCAL: '1',
  };
  const result = loadDotEnvLocal({
    filePath,
    env,
  });

  assert.equal(result.disabled, true);
  assert.equal(env.FEISHU_APP_ID, undefined);
});
