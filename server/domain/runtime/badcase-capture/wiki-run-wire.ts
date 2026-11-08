// Offline proof for the pinned 0.85.1 Codex serializer. No auth, transport,
// session, model discovery or tool execution. Compare the ENTIRE JSON body;
// object key order is immaterial, message/tool/array order is not.
import fs from 'node:fs';
import path from 'node:path';
import { wikiValueHash } from './wiki-rubric';
import { redactTraceKnownValues } from './wiki-trace';
const fail = () => Object.assign(Error('wiki_run_wire_request_invalid'), { code: 'wiki_run_wire_request_invalid' });
const sdkRoot = (require.resolve.paths('@earendil-works/pi-coding-agent') || [])
  .map((p: string) => path.join(p, '@earendil-works/pi-coding-agent'))
  .find((p: string) => fs.existsSync(path.join(p, 'package.json')));
if (!sdkRoot) throw fail();
const aiRoot = path.join(sdkRoot, 'node_modules/@earendil-works/pi-ai');
const sdkVersion = require(path.join(sdkRoot, 'package.json')).version;
const aiVersion = require(path.join(aiRoot, 'package.json')).version;
// Node >=22.19 supports synchronous require(ESM); these conversion functions
// are the same ones called by api/openai-codex-responses.js, not a reimplementation.
const { convertResponsesMessages, convertResponsesTools } = require(path.join(aiRoot, 'dist/api/openai-responses-shared.js'));
export const WIKI_RUN_WIRE_MODEL = Object.freeze({ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', provider: 'openai-codex', api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 128000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStrictMode: false, supportsOpenAIGrammarTools: false } });
const json = (v: any) => JSON.parse(JSON.stringify(v));
export function buildWikiRunWireRequest(request: any) {
  if (sdkVersion !== '0.85.1' || aiVersion !== '0.85.1' || request?.model !== 'openai-codex/gpt-6.1-sol'
    || request.thinking !== 'xhigh' || !request.context || !Array.isArray(request.context.messages)
    || !Array.isArray(request.context.tools)) throw fail();
  const context = structuredClone(request.context), model = WIKI_RUN_WIRE_MODEL;
  return json({ model: model.id, store: false, stream: true,
    instructions: context.systemPrompt || 'You are a helpful assistant.',
    input: convertResponsesMessages(model, context, new Set(['openai', 'openai-codex', 'opencode']), { includeSystemPrompt: false }),
    text: { verbosity: 'low' }, include: ['reasoning.encrypted_content'], tool_choice: 'auto', parallel_tool_calls: true,
    ...(context.tools.length ? { tools: convertResponsesTools(context.tools, { strict: null, ...model.compat }) } : {}),
    reasoning: { effort: 'xhigh', summary: 'auto' } });
}
export function verifyWikiRunWireRequest(request: any, wireRequest: any, knownValues: readonly string[] = []): boolean {
  try {
    if (!wireRequest || typeof wireRequest !== 'object' || Array.isArray(wireRequest)) return false;
    const normalize = (v: any) => redactTraceKnownValues(json(v), knownValues).value;
    return wikiValueHash(normalize(buildWikiRunWireRequest(request))) === wikiValueHash(normalize(wireRequest));
  } catch { return false; }
}
