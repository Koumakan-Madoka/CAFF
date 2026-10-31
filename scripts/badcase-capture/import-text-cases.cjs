// Operator-only import of an explicitly confirmed selection. Production is
// contacted only through GET APIs; no SQLite access, marking, or checkpoint
// manufacture. Fixed loopback origin, no auth discovery and no redirects.
const fs = require('node:fs'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { containsSecretSentinel } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const ORIGIN = 'http://127.0.0.1:3100';
const fail = code => Object.assign(Error(code), { code });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['conversationId', 'messageId', 'actual', 'expected'].includes(k))
    || !validId(value.conversationId) || !validId(value.messageId)) throw fail('wiki_selection_invalid');
  for (const k of ['actual', 'expected']) {
    if (typeof value[k] !== 'string' || !value[k].trim() || value[k].includes('\0') || Buffer.byteLength(value[k]) > 8192) throw fail('wiki_selection_invalid');
    if (containsSecretSentinel(value[k])) throw fail('wiki_contains_secret');
  }
  return { conversationId: value.conversationId, messageId: value.messageId, actual: value.actual, expected: value.expected };
}
function excerpt(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw fail('wiki_source_invalid');
  if (containsSecretSentinel(value)) throw fail('wiki_contains_secret');
  if (Buffer.byteLength(value) <= 32768) return { text: value, truncated: false };
  let result = '', size = 0;
  for (const char of value) { size += Buffer.byteLength(char); if (size > 32768) break; result += char; }
  return { text: result, truncated: true };
}
async function importTextCases({ selections, confirmed, store, fetchImpl = globalThis.fetch }) {
  if (confirmed !== true) throw fail('wiki_confirmation_required');
  if (!Array.isArray(selections) || !selections.length || selections.length > 20) throw fail('wiki_selection_invalid');
  const chosen = selections.map(selection); // Validate the whole list before any network traffic.
  if (new Set(chosen.map(s => s.conversationId + '/' + s.messageId)).size !== chosen.length) throw fail('wiki_selection_invalid');
  async function get(route, optional = false) {
    try {
      const response = await fetchImpl(ORIGIN + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (optional && response.status === 404) { await response.body?.cancel(); return null; }
      if (response.status !== 200) { await response.body?.cancel(); throw Error(); }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > 2 * 1024 * 1024) throw Error();
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw fail('wiki_source_unavailable'); }
  }
  const batch = [];
  for (const conversationId of new Set(chosen.map(s => s.conversationId))) {
    const base = '/api/conversations/' + conversationId;
    const { conversation } = await get(base);
    if (conversation?.id !== conversationId) throw fail('wiki_source_invalid');
    const group = chosen.filter(s => s.conversationId === conversationId), wanted = new Set(group.map(s => s.messageId)), messages = new Map();
    let cursor = null; const cursors = new Set();
    // Explicit supported bound, not an unbounded crawl of production history.
    for (let page = 0; page < 100; page++) {
      const data = await get(base + '/messages?limit=100' + (cursor === null ? '' : '&before=' + encodeURIComponent(cursor)));
      if (!Array.isArray(data?.items) || typeof data.hasMore !== 'boolean') throw fail('wiki_source_invalid');
      for (const message of data.items) if (wanted.has(message.id)) messages.set(message.id, message);
      if (messages.size === wanted.size || !data.hasMore) break;
      if (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 2048 || cursors.has(data.nextCursor)) throw fail('wiki_source_invalid');
      cursor = data.nextCursor; cursors.add(cursor);
    }
    for (const s of group) {
      const message = messages.get(s.messageId);
      if (!message || message.conversationId !== conversationId || message.agentId !== 'role-family-gpt' || message.role !== 'assistant'
        || !['completed', 'failed', 'cancelled', 'interrupted'].includes(message.status)) throw fail('wiki_message_unavailable_or_unsupported');
      const body = excerpt(message.content);
      const data = await get(base + '/messages/' + s.messageId + '/tool-trace', true);
      if (data !== null && (!data.trace || typeof data.trace !== 'object' || Array.isArray(data.trace))) throw fail('wiki_source_invalid');
      const trace = data === null ? { text: '', truncated: false } : excerpt(JSON.stringify(data.trace));
      batch.push({ source: { origin: ORIGIN, projectId: conversation.projectScopeId || conversation.projectId || null,
        conversationId, messageId: message.id, agentId: message.agentId }, role: 'GPT', actual: s.actual, expected: s.expected,
        message: body.text, traceExcerpt: trace.text, traceState: data === null ? 'missing' : 'available',
        messageTruncated: body.truncated, traceTruncated: trace.truncated });
    }
  }
  // One atomic local publication only after every requested source succeeds.
  return store.addTextCases(batch);
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed') throw fail('wiki_import_usage');
  let config;
  try {
    const bytes = fs.readFileSync(args[1]); if (bytes.length > 1024 * 1024) throw Error(); config = JSON.parse(bytes.toString('utf8'));
    if (!config || Object.keys(config).some(k => !['captureRoot', 'sourceWorktree', 'projectId', 'selections'].includes(k))) throw Error();
  } catch { throw fail('wiki_config_invalid'); }
  const store = createWikiStore(config);
  const result = await importTextCases({ selections: config.selections, confirmed: true, store });
  process.stdout.write(JSON.stringify({ created: result.created, revision: result.revision, caseIds: result.cases.map(c => c.id), kind: 'text-only', replayable: false }) + '\n');
}
if (require.main === module) main().catch(e => {
  // Never surface HTTP bodies, raw filesystem errors, or selected history.
  const code = /^wiki_[a-z_]+$/.test(e.code || '') || e.code === 'capture_writer_busy' ? e.code : 'wiki_import_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { importTextCases, main };
