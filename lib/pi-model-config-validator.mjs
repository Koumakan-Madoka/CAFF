#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SDK_SPECIFIER = '@earendil-works/pi-coding-agent';
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const EXPECTED_CODING_AGENT = Object.freeze({
  name: '@earendil-works/pi-coding-agent',
  version: '0.84.3',
});
const EXPECTED_PI_AI = Object.freeze({
  name: '@earendil-works/pi-ai',
  version: '0.84.3',
});

export function assertPinnedPiModelConfigSource(source) {
  const matches = source?.codingAgent?.name === EXPECTED_CODING_AGENT.name &&
    source?.codingAgent?.version === EXPECTED_CODING_AGENT.version &&
    source?.piAi?.name === EXPECTED_PI_AI.name &&
    source?.piAi?.version === EXPECTED_PI_AI.version;

  if (!matches) {
    throw new Error('pinned Pi model config source mismatch');
  }
}

export function resolvePinnedPiModelConfigSource() {
  const codingAgentEntry = fileURLToPath(import.meta.resolve(SDK_SPECIFIER));
  const codingAgentRoot = path.resolve(path.dirname(codingAgentEntry), '..');
  const codingAgentPackage = JSON.parse(
    fs.readFileSync(path.join(codingAgentRoot, 'package.json'), 'utf8')
  );
  const piAiRoot = path.join(codingAgentRoot, 'node_modules', '@earendil-works', 'pi-ai');
  const piAiPackage = JSON.parse(fs.readFileSync(path.join(piAiRoot, 'package.json'), 'utf8'));

  return {
    codingAgent: {
      name: codingAgentPackage.name,
      version: codingAgentPackage.version,
    },
    modelConfigPath: path.join(codingAgentRoot, 'dist', 'core', 'model-config.js'),
    modelRuntimePath: path.join(codingAgentRoot, 'dist', 'core', 'model-runtime.js'),
    modelsStorePath: path.join(codingAgentRoot, 'dist', 'core', 'models-store.js'),
    piAi: {
      name: piAiPackage.name,
      version: piAiPackage.version,
    },
    piAiCredentialStorePath: path.join(piAiRoot, 'dist', 'auth', 'credential-store.js'),
    piAiModelsPath: path.join(piAiRoot, 'dist', 'models.js'),
  };
}

async function importPath(filePath) {
  return import(pathToFileURL(filePath).href);
}

export async function createPinnedCredentialBlindModelRuntime(modelsPath, source = resolvePinnedPiModelConfigSource()) {
  assertPinnedPiModelConfigSource(source);
  const [runtimeModule, modelsStoreModule, credentialStoreModule] = await Promise.all([
    importPath(source.modelRuntimePath),
    importPath(source.modelsStorePath),
    importPath(source.piAiCredentialStorePath),
  ]);
  return runtimeModule.ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new credentialStoreModule.InMemoryCredentialStore(),
    modelsPath,
    modelsStore: new modelsStoreModule.InMemoryCodingAgentModelsStore(),
  });
}

export async function validatePinnedPiModelConfigFile(filePath) {
  const source = resolvePinnedPiModelConfigSource();
  const runtime = await createPinnedCredentialBlindModelRuntime(filePath, source);
  const diagnostic = runtime.getError();
  return {
    ok: !diagnostic,
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
    if (byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error('document too large');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function runStdinValidation() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-pi-model-config-'));
  const filePath = path.join(tempDir, 'models.json');

  try {
    fs.chmodSync(tempDir, 0o700);
    fs.writeFileSync(filePath, await readStdin(), { encoding: 'utf8', mode: 0o600 });
    const result = await validatePinnedPiModelConfigFile(filePath);
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 2;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function isMainModule() {
  const entryPath = process.argv[1];
  return Boolean(entryPath) && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule() && process.argv[2] === '--stdin') {
  runStdinValidation().catch(() => {
    process.stdout.write(JSON.stringify({ ok: false }));
    process.exitCode = 1;
  });
}
