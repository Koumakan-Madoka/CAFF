// Trusted host-only one-shot client. No Session/Agent, discovery, tool executor,
// OAuth refresh, auth writeback, global fetch replacement or automatic retries.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { pathToFileURL } = require('node:url');
const { createCodexTransport, PROFILE } = require('./codex-transport.cjs');
const { CODEX_INERT_KEY } = require('./direct-model.cjs');
const fail = code => Object.assign(Error(code), { code });
const sdkRoot = fs.realpathSync(path.resolve(__dirname, '../../node_modules/@earendil-works/pi-coding-agent'));
const sdkAi = path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai');
const load = file => import(pathToFileURL(file).href);
async function loadWikiRunTools({ sourceWorktree, capabilitiesSha }) {
  if (!/^[a-f0-9]{40}$/.test(capabilitiesSha || '') || !path.isAbsolute(sourceWorktree || '')) throw fail('wiki_run_tools_invalid');
  if (JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'))).version !== '0.85.1'
    || JSON.parse(fs.readFileSync(path.join(sdkAi, 'package.json'))).version !== '0.85.1') throw fail('wiki_run_sdk_version_invalid');
  const file = path.join(sourceWorktree, 'lib/pi-extensions/caff-capabilities.mjs'), bytes = fs.readFileSync(file);
  const expected = require('node:child_process').execFileSync('git', ['-C', sourceWorktree, 'show', capabilitiesSha + ':lib/pi-extensions/caff-capabilities.mjs'], { maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!bytes.equals(expected)) throw fail('wiki_run_tools_invalid');
  // Definition factories don't create execute functions. Extension registration
  // is intercepted, retaining ONLY name/description/schema; never call execute.
  const { createCodingToolDefinitions } = await load(path.join(sdkRoot, 'dist/core/tools/index.js'));
  const definitions = createCodingToolDefinitions(sourceWorktree);
  const extension = await load(file); extension.default({ registerTool: t => definitions.push(t) });
  return { codingAgentVersion: '0.85.1', capabilitiesSha, capabilitiesFileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    definitions: definitions.map(({ name, description, parameters }) => JSON.parse(JSON.stringify({ name, description, parameters }))) };
}
// Minimal native wire descriptor: no model catalog/network/auth discovery and
// no inferred prices. The caller's approved ID is sent verbatim (no fallback).
const { WIKI_RUN_WIRE_MODEL: MODEL } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-wire');
async function createWikiRunClient({ authFile, knownKeyValues = [], timeoutMs = 600000 }, dependencies = {}) {
  const transport = (dependencies.createTransport || createCodexTransport)({ authFile, confirmed: true, timeoutMs }, {
    containsKnownValue: bytes => knownKeyValues.some(v => v && (bytes.includes(v) || bytes.includes(JSON.stringify(v).slice(1, -1)))), ...dependencies.transport });
  const { stream } = dependencies.stream ? dependencies : await load(path.join(sdkAi, 'dist/api/openai-codex-responses.js'));
  let used = false;
  return {
    async complete(request) {
      if (used) throw fail('wiki_run_budget_exhausted'); used = true;
      if (request?.model !== PROFILE.model || request.thinking !== 'xhigh') throw fail('wiki_run_model_invalid');
      let networkRequests = 0, wireRequest;
      const fetch = async (...args) => { if (++networkRequests !== 1) throw fail('wiki_run_budget_exhausted'); return transport.fetch(...args); };
      const start = performance.now();
      const eventStream = stream(MODEL, request.context, { apiKey: CODEX_INERT_KEY, reasoningEffort: 'xhigh', transport: 'sse',
        maxRetries: 0, cacheRetention: 'none', timeoutMs, signal: AbortSignal.timeout(timeoutMs), fetch,
        onPayload(body) { wireRequest = structuredClone(body); } });
      const message = await eventStream.result();
      // Native errors can contain upstream diagnostics. Only successful complete
      // messages cross this boundary. Costs are NOT inferred from the descriptor.
      if (!['stop', 'toolUse'].includes(message?.stopReason) || networkRequests !== 1) throw fail('wiki_run_model_failed');
      delete message.usage?.cost;
      return { message, networkRequests, durationMs: performance.now() - start, wireRequest };
    },
    state: () => transport.state(), close: () => transport.close(),
  };
}
module.exports = { loadWikiRunTools, createWikiRunClient, MODEL };
