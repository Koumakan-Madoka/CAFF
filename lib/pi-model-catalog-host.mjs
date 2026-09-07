#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertPinnedPiModelConfigSource,
  createPinnedCredentialBlindModelRuntime,
  resolvePinnedPiModelConfigSource,
} from './pi-model-config-validator.mjs';

const MAX_INPUT_BYTES = 64 * 1024;

function normalizeAgentDir(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error('agentDir is required');
  }
  return path.resolve(normalized);
}

export async function createPinnedModelCatalogSnapshot(options = {}, dependencies = {}) {
  const agentDir = normalizeAgentDir(options.agentDir);
  const source = dependencies.source || resolvePinnedPiModelConfigSource();
  assertPinnedPiModelConfigSource(source);

  const loadModule = dependencies.loadModule || ((filePath) => import(pathToFileURL(filePath).href));
  const piModelsModule = await loadModule(source.piAiModelsPath);
  const runtime = dependencies.createModelRuntime
    ? await dependencies.createModelRuntime(path.join(agentDir, 'models.json'), source)
    : await createPinnedCredentialBlindModelRuntime(path.join(agentDir, 'models.json'), source);
  if (runtime.getError()) {
    throw new Error('pinned Pi model catalog failed to load models.json');
  }

  const models = runtime.getModels().map((model) => ({
    provider: String(model.provider || '').trim(),
    id: String(model.id || '').trim(),
    name: String(model.name || '').trim(),
    supportedThinkingLevels: piModelsModule.getSupportedThinkingLevels(model),
    input: Array.isArray(model.input) ? model.input.slice() : ['text'],
    contextWindow:
      Number.isInteger(model.contextWindow) && model.contextWindow > 0
        ? model.contextWindow
        : null,
  })).filter((model) => model.provider && model.id);

  models.sort((left, right) => {
    const providerOrder = left.provider.localeCompare(right.provider, 'en');
    return providerOrder || left.id.localeCompare(right.id, 'en');
  });

  return {
    models,
    source: {
      codingAgent: source.codingAgent,
      piAi: source.piAi,
    },
  };
}

async function readStdin() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.length;
    if (byteLength > MAX_INPUT_BYTES) {
      throw new Error('catalog host input is too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runStdinCommand() {
  const command = JSON.parse(await readStdin());
  const snapshot = await createPinnedModelCatalogSnapshot(command);
  process.stdout.write(JSON.stringify({ ok: true, ...snapshot }));
}

if (process.argv[2] === '--stdin') {
  runStdinCommand().catch(() => {
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exitCode = 1;
  });
}
