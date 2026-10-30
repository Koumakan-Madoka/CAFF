// Trusted standalone callback kernel for a SINGLE evaluation invocation. Not an
// app-server mode or replay launcher. Never accepts a DB handle/path, live Room,
// scheduler, model/provider client, project resolver or arbitrary route handler.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createChatAppStore } from '../../../../lib/chat-app-store';
import { createAgentToolBridge } from '../agent-tool-bridge';
import { containsSecretSentinel } from './secrets';
import { prepareEvaluationCallbackTrace } from './evaluation-trace';
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const text = (v: any, max: number) => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= max && !v.includes('\0');
const fail = (code: string, statusCode = 400) => Object.assign(Error(code), { code, statusCode });
const invalid = () => fail('evaluation_callback_invalid');
const prefix = '/api/agent-tools/';
const routes: Record<string, string> = { context: 'GET', participants: 'GET', 'post-message': 'POST' };
function validate(input: any) {
  const fromTrace = object(input) && Object.hasOwn(input, 'trace');
  if (!exact(input, fromTrace ? ['directory', 'trace', 'expectedTraceHash', 'association', 'lifetimeMs'] : ['directory', 'seed', 'lifetimeMs'])
    || typeof input.directory !== 'string' || !path.isAbsolute(input.directory)
    || !Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < 1 || input.lifetimeMs > 300000) throw invalid();
  if (fromTrace) {
    const prepared = prepareEvaluationCallbackTrace(input.trace, input.expectedTraceHash, input.association);
    return { directory: path.resolve(input.directory), seed: prepared.seed, trace: prepared.trace,
      traceReceipt: prepared.receipt, lifetimeMs: input.lifetimeMs };
  }
  const s = input.seed;
  if (!exact(s, ['conversationId', 'turnId', 'agent', 'userMessage', 'assistantMessageId'])
    || !exact(s.agent, ['id', 'name']) || !exact(s.userMessage, ['id', 'content'])
    || ![s.conversationId, s.turnId, s.agent.id, s.userMessage.id, s.assistantMessageId].every(id)
    || s.userMessage.id === s.assistantMessageId || s.agent.id.startsWith('role-family-')
    || !text(s.agent.name, 128) || !text(s.userMessage.content, 32768) || containsSecretSentinel(JSON.stringify(s))) throw invalid();
  // Copy BEFORE the first await; changes to caller input cannot alter a run.
  return { directory: path.resolve(input.directory), seed: structuredClone(s), lifetimeMs: input.lifetimeMs,
    trace: null, traceReceipt: null };
}
function reply(res: http.ServerResponse, status: number, value: any) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' }); res.end(body);
}
async function body(req: http.IncomingMessage) {
  if (req.headers['content-type'] !== 'application/json') throw fail('evaluation_callback_body_invalid');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += b.length;
    if (bytes > 65536) throw fail('evaluation_callback_body_too_large', 413);
    chunks.push(b);
  }
  const data = Buffer.concat(chunks), value = data.toString('utf8');
  if (!Buffer.from(value).equals(data)) throw fail('evaluation_callback_body_invalid');
  try { const parsed = JSON.parse(value); if (!object(parsed)) throw Error(); return parsed; }
  catch { throw fail('evaluation_callback_body_invalid'); }
}

/** Caller must own a dedicated parent directory. Each call owns one NEW child,
 * SQLite DB and loopback ephemeral listener; no reopen/recovery or ambient config.
 * This kernel intentionally supports only context/participants/PUBLIC post, and
 * either a legacy single text seed OR explicit versioned public-text input
 * state. Trace mode never falls back to a seed on failure. Private/delegation/
 * attachments/capabilities remain unsupported, NOT stripped or emulated.
 * This is a real mutable isolated DB, not a recording of past tool outputs.
 * Do not use as faithful replay proof; source capture/Docker wiring are separate.
 */
export async function startEvaluationCallback(input: any) {
  const { directory, seed, lifetimeMs, trace, traceReceipt } = validate(input);
  try {
    const parent = path.dirname(directory), st = fs.lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw Error();
    fs.mkdirSync(directory, { mode: 0o700 }); // exclusive, no recursive/exists fallback
  } catch { throw fail('evaluation_callback_directory_unavailable'); }
  const databasePath = path.join(directory, 'callback.sqlite');
  let store: ReturnType<typeof createChatAppStore>;
  try {
    store = createChatAppStore({ agentDir: directory, sqlitePath: databasePath });
    if (process.platform === 'linux') fs.chmodSync(databasePath, 0o600);
    store.db.transaction(() => {
      const agents = trace ? trace.participants : [{ ...seed.agent, description: '' }];
      for (const a of agents) {
        if (a.id.startsWith('role-family-')) {
          // Preserve configured system identities, never overwrite/reclassify a
          // built-in family as custom merely to make an archive import succeed.
          const existing = store.getAgent(a.id);
          if (!existing || existing.roleKind !== 'model_family' || existing.name !== a.name || existing.description !== a.description) {
            throw fail('evaluation_callback_identity_mismatch');
          }
        } else store.saveCustomRoleConfig({ ...a, personaPrompt: 'Evaluation callback identity only; no agent is executed here.' });
      }
      store.createConversation({ id: seed.conversationId, title: trace ? trace.conversation.title : 'Isolated evaluation',
        type: trace ? trace.conversation.type : 'standard', metadata: trace ? trace.conversation.metadata : {}, participants: agents.map((a: any) => a.id) });
      if (trace) for (const m of trace.publicMessages) store.createMessage({
        id: m.id, conversationId: seed.conversationId, turnId: m.turnId, role: m.role, agentId: m.agentId,
        senderName: m.senderName, content: m.content, status: m.status, createdAt: m.createdAt,
        metadata: { mentions: m.mentions, toolBridge: { lastPublicPostedAt: m.publicPostedAt,
          publicPostCount: m.publicPostCount, lastPublicMode: m.publicPostMode } },
      });
      else store.createMessage({ id: seed.userMessage.id, conversationId: seed.conversationId, turnId: seed.turnId,
        role: 'user', senderName: 'Evaluation User', content: seed.userMessage.content, status: 'completed' });
      store.createMessage({ id: seed.assistantMessageId, conversationId: seed.conversationId, turnId: seed.turnId,
        role: 'assistant', agentId: seed.agent.id, senderName: seed.agent.name, content: 'Thinking...', status: 'streaming',
        ...(trace ? { createdAt: trace.assistantCreatedAt } : {}) });
      // UI ingress may derive a title from the first imported user message. This
      // is a NEW owned DB import, not a UI rename or live Room mutation. Restore
      // the exact archived title/metadata after insertion, within this transaction.
      if (trace) store.db.prepare('UPDATE chat_conversations SET title=?, metadata_json=? WHERE id=?')
        .run(trace.conversation.title, JSON.stringify(trace.conversation.metadata), seed.conversationId);
    })();
  } catch { try { store!.close(); } catch {} throw fail('evaluation_callback_storage_failed', 500); }
  const stage = { status: 'running' };
  let bridge: ReturnType<typeof createAgentToolBridge>, context: any, credentials: Readonly<{ invocationId: string; callbackToken: string }>;
  try {
    bridge = createAgentToolBridge({ store, agentDir: directory });
    credentials = Object.freeze({ invocationId: crypto.randomUUID(), callbackToken: crypto.randomBytes(32).toString('hex') });
    const conversation = store.getConversation(seed.conversationId);
    if (!conversation) throw Error();
    context = bridge.registerInvocation(bridge.createInvocationContext({ ...credentials,
      conversationId: seed.conversationId, turnId: seed.turnId, agentId: seed.agent.id, agentName: seed.agent.name,
      userMessageId: seed.userMessage.id, assistantMessageId: seed.assistantMessageId,
      conversationAgents: conversation.agents, stage, allowHandoffs: false,
      autoCompleteOnPublicPost: true, onPublicPostCompleted: () => { stage.status = 'completed'; } }));
  } catch { store.close(); throw fail('evaluation_callback_start_failed', 500); }
  const deadline = performance.now() + lifetimeMs;
  let stopped = false, requests = 0, authority = '', stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = new Set<Promise<void>>();
  function live() { if (stopped || performance.now() >= deadline) throw fail('evaluation_callback_expired', 410); }
  function authenticate(auth: any) {
    if (typeof auth.invocationId !== 'string' || auth.invocationId !== credentials.invocationId
      || typeof auth.callbackToken !== 'string' || !/^[a-f0-9]{64}$/.test(auth.callbackToken)
      || !crypto.timingSafeEqual(Buffer.from(auth.callbackToken), Buffer.from(credentials.callbackToken))) throw fail('evaluation_callback_auth_failed', 401);
  }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      live();
      if (req.headers.origin !== undefined || req.headers.host !== authority || !req.url?.startsWith('/') || req.url.includes('#')) throw fail('evaluation_callback_request_forbidden', 403);
      if (++requests > 128) throw fail('evaluation_callback_request_limit', 429);
      if (active.size >= 8) throw fail('evaluation_callback_busy', 429);
      const url = new URL(req.url, 'http://' + authority), route = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(prefix) || !Object.hasOwn(routes, route) || routes[route] !== req.method) throw fail('evaluation_callback_route_unavailable', 404);
      if (req.method === 'GET') {
        const allowed = ['invocationId', 'callbackToken', ...(route === 'context' ? ['publicLimit', 'privateLimit'] : [])];
        if ([...url.searchParams.keys()].some(k => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1)) throw fail('evaluation_callback_query_invalid');
        for (const name of ['publicLimit', 'privateLimit']) if (url.searchParams.has(name) && !/^(?:[1-9]|1[0-9]|2[0-4])$/.test(url.searchParams.get(name)!)) throw fail('evaluation_callback_query_invalid');
        authenticate(Object.fromEntries(url.searchParams));
        reply(res, 200, route === 'context' ? bridge.handleReadContext(url) : bridge.handleListParticipants(url));
      } else {
        if (url.search) throw fail('evaluation_callback_query_invalid');
        const b = await body(req); live(); // never use SQLite after expiry/stop across await
        authenticate(b);
        const allowed = ['invocationId', 'callbackToken', 'visibility', 'content', 'mode', 'noFinalize'];
        if (Object.keys(b).some(k => !allowed.includes(k)) || b.visibility !== 'public' || !text(b.content, 32768)
          || b.content.includes(credentials.callbackToken) || b.content.includes(credentials.invocationId) || containsSecretSentinel(b.content)
          || (b.mode !== undefined && !['replace', 'append'].includes(b.mode)) || (b.noFinalize !== undefined && typeof b.noFinalize !== 'boolean')) throw fail('evaluation_callback_body_invalid');
        // Bounded cumulative output too, not just individual HTTP requests.
        const message = store.getMessage(seed.assistantMessageId);
        if (!message) throw fail('evaluation_callback_storage_failed', 500);
        const prior = message.content;
        const combined = b.mode === 'append' && prior !== 'Thinking...' ? prior + b.content.trim() : b.content.trim();
        if (Buffer.byteLength(combined) > 32768 || combined.includes(credentials.callbackToken)
          || combined.includes(credentials.invocationId) || containsSecretSentinel(combined)) throw fail('evaluation_callback_body_invalid');
        reply(res, 200, bridge.handlePostMessage(b));
      }
    } catch (e: any) {
      // Never return arbitrary storage errors, content, paths or auth material.
      const known = typeof e?.code === 'string' && /^evaluation_callback_[a-z_]+$/.test(e.code);
      const status = known ? e.statusCode : [401, 409].includes(e?.statusCode) ? e.statusCode : 500;
      if (!res.destroyed && !res.headersSent) reply(res, status, { error: known ? e.code : status === 409 ? 'evaluation_callback_inactive' : status === 401 ? 'evaluation_callback_auth_failed' : 'evaluation_callback_failed' });
    }
  }
  const server = http.createServer((req, res) => {
    const task = handle(req, res); active.add(task); void task.finally(() => active.delete(task));
  });
  server.requestTimeout = 5000; server.headersTimeout = 2000; server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 32; server.maxConnections = 16;
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true; if (timer) clearTimeout(timer); bridge.unregisterInvocation(context.invocationId);
    stopping = (async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(e => e && (e as any).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve()));
      server.closeAllConnections(); // own server sockets only, never kill-by-port
      await Promise.allSettled([...active]);
      try { await closed; } finally { store.close(); }
    })(); return stopping;
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error();
    authority = '127.0.0.1:' + address.port;
    live(); timer = setTimeout(() => { void stop().catch(() => {}); }, Math.max(1, deadline - performance.now())); timer.unref();
    return Object.freeze({ apiUrl: 'http://' + authority, databasePath, credentials, stop,
      // Trusted worker observation, not an additional HTTP capability. Read
      // before stop closes this callback's own disposable SQLite connection.
      readPublicReply: () => {
        live(); const m = store.getMessage(seed.assistantMessageId);
        return m && m.metadata?.toolBridge?.publicPostCount > 0 ? String(m.content || '') : '';
      },
      ...(traceReceipt ? { traceReceipt: structuredClone(traceReceipt) } : {}) });
  } catch { await stop(); throw fail('evaluation_callback_start_failed', 500); }
}
