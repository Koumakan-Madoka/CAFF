const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { withTempDir } = require('../helpers/temp-dir');

const hostUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'lib', 'pi-model-catalog-host.mjs')
).href;
const hostPath = path.resolve(__dirname, '..', '..', 'lib', 'pi-model-catalog-host.mjs');

test('Pi catalog host projects exact pinned thinking capabilities without credentials or network', async (t) => {
  const agentDir = withTempDir('caff-pi-catalog-host-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const host = await import(`${hostUrl}?test=${Date.now()}`);
  const snapshot = await host.createPinnedModelCatalogSnapshot({ agentDir });

  assert.deepEqual(snapshot.source, {
    codingAgent: { name: '@earendil-works/pi-coding-agent', version: '0.84.3' },
    piAi: { name: '@earendil-works/pi-ai', version: '0.84.3' },
  });

  const byKey = new Map(snapshot.models.map((model) => [`${model.provider}\u001f${model.id}`, model]));
  const expected = new Map([
    ['openai\u001fgpt-5.4', ['off', 'low', 'medium', 'high', 'xhigh']],
    ['anthropic\u001fclaude-opus-4-7', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['google\u001fgemini-3.1-pro-preview', ['low', 'high']],
    ['deepseek\u001fdeepseek-v4-pro', ['off', 'high', 'max']],
    ['groq\u001fqwen/qwen3.6-27b', ['off', 'high']],
    ['zai\u001fglm-5.2', ['off', 'high', 'max']],
    ['moonshotai\u001fkimi-k2.5', ['off', 'minimal', 'low', 'medium', 'high']],
    ['moonshotai\u001fkimi-k3', ['low', 'high', 'max']],
  ]);

  for (const [key, supportedThinkingLevels] of expected) {
    assert.deepEqual(byKey.get(key)?.supportedThinkingLevels, supportedThinkingLevels, key);
  }
  assert.equal(byKey.get('moonshotai\u001fkimi-k2.5').supportedThinkingLevels.includes('max'), false);
  assert.equal(byKey.get('moonshotai\u001fkimi-k3').supportedThinkingLevels.includes('max'), true);
});

test('Pi catalog host CLI owns stdin without imported validators competing for the command', (t) => {
  const agentDir = withTempDir('caff-pi-catalog-cli-');
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [hostPath, '--stdin'], {
    encoding: 'utf8',
    input: JSON.stringify({ agentDir }),
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.ok(response.models.length > 100);
});
