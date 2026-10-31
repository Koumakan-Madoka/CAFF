#!/usr/bin/env node
// Read-only 3100 room-title backfill. No message import, production write,
// credential discovery or model request; only missing local display titles change.
const fs = require('node:fs'), path = require('node:path');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const ORIGIN = 'http://127.0.0.1:3100';
const fail = code => Object.assign(Error(code), { code });
async function backfillRoomTitles({ store, fetchImpl = globalThis.fetch, confirmed }) {
  if (confirmed !== true) throw fail('wiki_confirmation_required');
  const missing = [...new Set(store.read().cases.filter(c => !c.source.conversationTitle).map(c => c.source.conversationId))].sort();
  const updates = [];
  for (const conversationId of missing) {
    let response;
    try { response = await fetchImpl(`${ORIGIN}/api/conversations/${conversationId}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw fail('wiki_source_unavailable'); }
    if (response.status !== 200) { await response.body?.cancel(); throw fail('wiki_source_unavailable'); }
    try {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length; if (size > 2 * 1024 * 1024) throw Error(); chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (data.conversation?.id !== conversationId || typeof data.conversation.title !== 'string' || !data.conversation.title.trim()) throw Error();
      updates.push({ conversationId, conversationTitle: data.conversation.title });
    } catch { throw fail('wiki_source_invalid'); }
  }
  return updates.length ? store.backfillConversationTitles(updates) : { updated: 0, revision: store.read().revision };
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed') throw fail('wiki_import_usage');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (!config || Object.keys(config).some(k => !['globalRoot', 'sourceWorktree'].includes(k))) throw Error();
  } catch { throw fail('wiki_config_invalid'); }
  const result = await backfillRoomTitles({ store: createWikiStore(config), confirmed: true });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (require.main === module) main().catch(e => {
  const code = /^wiki_[a-z_]+$/.test(e.code || '') ? e.code : 'wiki_import_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { backfillRoomTitles, main };
