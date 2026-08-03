const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withTempDir } = require('../helpers/temp-dir');
const {
  atomicReplaceModelProviderDocument,
  readModelProviderDocument,
  updateModelProviderDocument,
} = require('../../build/server/domain/models/model-provider-persistence');

function registerTempDir(t, prefix) {
  const tempDir = withTempDir(prefix);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return tempDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('provider persistence writes only the resolved agentDir and returns the real directory sync result', async (t) => {
  const tempDir = registerTempDir(t, 'caff-provider-persistence-');
  const agentDir = path.join(tempDir, 'agent');
  const fallbackDir = path.join(tempDir, 'fallback');
  fs.mkdirSync(fallbackDir, { recursive: true });
  fs.writeFileSync(path.join(fallbackDir, 'models.json'), '{"sentinel":true}\n', 'utf8');

  const document = {
    providers: {
      deepseek: {
        apiKey: 'literal-secret',
        models: [{ id: 'deepseek-v3.2', family: 'deepseek' }],
      },
    },
  };
  const result = await atomicReplaceModelProviderDocument(agentDir, document);
  const configPath = path.join(agentDir, 'models.json');

  assert.equal(result.path, configPath);
  assert.equal(result.backupPath, null);
  assert.ok(['durable', 'directory_sync_unsupported'].includes(result.durability));
  if (process.platform !== 'win32') {
    assert.equal(result.durability, 'durable');
  }
  assert.deepEqual(readJson(configPath), document);
  assert.deepEqual(readJson(path.join(fallbackDir, 'models.json')), { sentinel: true });
});

test('provider persistence creates a restricted non-overwriting backup before replacement', async (t) => {
  const agentDir = registerTempDir(t, 'caff-provider-backup-');
  const configPath = path.join(agentDir, 'models.json');
  const original = {
    providers: {
      deepseek: {
        apiKey: 'backup-secret',
        models: [{ id: 'deepseek-v3.2', family: 'deepseek' }],
      },
    },
  };
  const replacement = {
    providers: {
      moonshot: {
        models: [{ id: 'kimi-k2.5', family: 'kimi' }],
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  const first = await atomicReplaceModelProviderDocument(agentDir, replacement, {
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });
  assert.ok(first.backupPath);
  assert.notEqual(first.backupPath, configPath);
  assert.deepEqual(readJson(first.backupPath), original);
  assert.deepEqual(readJson(configPath), replacement);

  const second = await atomicReplaceModelProviderDocument(agentDir, original, {
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });
  assert.ok(second.backupPath);
  assert.notEqual(second.backupPath, first.backupPath);
  assert.deepEqual(readJson(second.backupPath), replacement);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(first.backupPath).mode & 0o077, 0);
    assert.equal(fs.statSync(second.backupPath).mode & 0o077, 0);
  }
});

test('provider persistence leaves the original file intact when replacement fails', async (t) => {
  const agentDir = registerTempDir(t, 'caff-provider-fault-');
  const configPath = path.join(agentDir, 'models.json');
  const original = {
    providers: {
      openai: {
        models: [{ id: 'gpt-5.4', family: 'gpt' }],
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

  await assert.rejects(
    () => atomicReplaceModelProviderDocument(agentDir, {
      providers: {
        anthropic: {
          models: [{ id: 'claude-opus-4.1', family: 'claude' }],
        },
      },
    }, {
      beforeReplace() {
        throw new Error('synthetic replace failure');
      },
    }),
    /synthetic replace failure/u
  );

  assert.deepEqual(readJson(configPath), original);
  assert.equal(fs.readdirSync(agentDir).some((name) => name.includes('.tmp-')), false);
});

test('provider persistence serializes read-modify-write updates per models.json path', async (t) => {
  const agentDir = registerTempDir(t, 'caff-provider-serialized-');
  await atomicReplaceModelProviderDocument(agentDir, { providers: {} });

  await Promise.all([
    updateModelProviderDocument(agentDir, async (document) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ...document,
        providers: {
          ...document.providers,
          openai: { models: [{ id: 'gpt-5.4', family: 'gpt' }] },
        },
      };
    }),
    updateModelProviderDocument(agentDir, (document) => ({
      ...document,
      providers: {
        ...document.providers,
        moonshot: { models: [{ id: 'kimi-k2.5', family: 'kimi' }] },
      },
    })),
  ]);

  assert.deepEqual(Object.keys(readModelProviderDocument(agentDir).providers).sort(), ['moonshot', 'openai']);
});

test('provider persistence validates the complete document before creating files', async (t) => {
  const tempDir = registerTempDir(t, 'caff-provider-invalid-');
  const agentDir = path.join(tempDir, 'agent');

  await assert.rejects(
    () => atomicReplaceModelProviderDocument(agentDir, {
      providers: {
        moonshot: {
          models: [{ id: 'kimi-k2.5', family: 'moon' }],
        },
      },
    }),
    (error) => error && error.code === 'model_family_invalid'
  );

  assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false);
  assert.equal(fs.existsSync(agentDir), false);
});

test('provider persistence rejects Pi-invalid nested schema before creating files', async (t) => {
  const tempDir = registerTempDir(t, 'caff-provider-pi-schema-invalid-');
  const agentDir = path.join(tempDir, 'agent');

  await assert.rejects(
    () => atomicReplaceModelProviderDocument(agentDir, {
      providers: {
        custom: {
          api: 'openai-completions',
          headers: { Authorization: 42 },
          models: [{ id: 'custom-model' }],
        },
      },
    }),
    (error) => error && error.code === 'provider_document_schema_invalid'
  );

  assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false);
  assert.equal(fs.existsSync(agentDir), false);
});

test('provider persistence rejects duplicate provider ids in the raw models.json source', (t) => {
  const agentDir = registerTempDir(t, 'caff-provider-duplicate-id-');
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    '{"providers":{"custom":{"models":[]},"custom":{"models":[]}}}\n',
    'utf8'
  );

  assert.throws(
    () => readModelProviderDocument(agentDir),
    (error) => error && error.code === 'provider_duplicate' && error.path === 'providers.custom'
  );
});

test('provider persistence reads a missing models.json as an empty provider document', (t) => {
  const agentDir = registerTempDir(t, 'caff-provider-read-');
  assert.deepEqual(readModelProviderDocument(agentDir), { providers: {} });
});
