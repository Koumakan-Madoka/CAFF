#!/usr/bin/env node
// Explicitly approved selections only. No ChatStore/config constructors, HTTP,
// filesystem search, Git, model calls, credential refresh or production writes.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { buildWikiTraceBundle, wikiTraceReference } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace');
const { wikiDisplayCases } = require('../../build/server/domain/runtime/badcase-capture/wiki-suite');
const fail = code => Object.assign(Error(code), { code });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX = 128 * 1024 * 1024;
const inside = (root, file) => { const r = path.relative(root, file); return !r || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)); };
const disjoint = (a, b) => !inside(a, b) && !inside(b, a);
const parse = value => { try { return JSON.parse(value || 'null'); } catch { throw fail('wiki_backfill_source_invalid'); } };
function ordinary(file, max = MAX) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max || fs.realpathSync(file) !== file) throw fail('wiki_backfill_source_invalid');
}
// The only writes are COPYFILE_EXCL into the private operation directory.
// Content is not parsed until the copy and source/copy hashes agree.
function copyReadOnlyFile(source, destination) {
  ordinary(source);
  const before = digest(fs.readFileSync(source));
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  ordinary(source);
  const bytes = fs.readFileSync(destination), copied = digest(bytes), after = digest(fs.readFileSync(source));
  if (before !== copied || before !== after) throw fail('wiki_backfill_source_changed');
  return { bytes, proof: { source, before, after, copied, bytes: bytes.length } };
}
// Retrospective recovery, never used at mark time. Ambiguous reply/branches
// stay unavailable; no "last assistant must be the reply" fallback.
function recoverBounds(text, reply) {
  if (!reply) return null;
  try {
    const entries = text.split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s));
    if (entries[0]?.type !== 'session' || entries[0]?.version !== 3) return null;
    const byId = new Map(), children = new Map(), assistants = [];
    for (const e of entries.slice(1)) {
      if (!e.id || byId.has(e.id) || (e.parentId !== null && !byId.has(e.parentId))) return null;
      byId.set(e.id, e); if (!children.has(e.parentId)) children.set(e.parentId, []); children.get(e.parentId).push(e);
      if (e.type === 'message' && e.message?.role === 'assistant') assistants.push(e);
    }
    const matching = assistants.filter(e => {
      const blocks = Array.isArray(e.message.content) ? e.message.content : [];
      return blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') === reply
        || blocks.some(b => b.type === 'toolCall' && /send[-_]public/.test(JSON.stringify(b.arguments))
          && typeof b.arguments?.command === 'string' && b.arguments.command.includes(reply));
    });
    if (matching.length !== 1) return null;
    const marked = matching[0], chain = [];
    for (let e = marked; e; e = e.parentId === null ? null : byId.get(e.parentId)) {
      if (e.type === 'message' && e.message?.role === 'user') break;
      if (e.type === 'message' && e.message?.role === 'assistant') chain.unshift(e);
      if (e.parentId === null) return null;
    }
    let leaf = marked, end = assistants.indexOf(marked) + 1;
    for (;;) {
      const next = (children.get(leaf.id) || []);
      if (next.length > 1) return null;
      if (!next.length || (next[0].type === 'message' && next[0].message?.role === 'user')) break;
      leaf = next[0]; if (leaf.type === 'message' && leaf.message?.role === 'assistant') end = assistants.indexOf(leaf) + 1;
    }
    return { sessionAssistantStartIndex: assistants.indexOf(chain[0]), sessionAssistantEndIndex: end };
  } catch { return null; }
}
function projectBackfillResults(results, cases) {
  const numbers = new Map(wikiDisplayCases(cases).map(c => [c.id, c.displayNumber]));
  return results.map(result => {
    if (!numbers.has(result.caseId)) throw fail('wiki_backfill_selection_invalid');
    return { ...result, caseNumber: numbers.get(result.caseId) };
  });
}
function backfillWikiTraces({ config, confirmed, knownKeyValues,
  openDatabase = (file, options) => new (require('better-sqlite3'))(file, options) }) {
  if (confirmed !== true) throw fail('wiki_confirmation_required');
  if (!config || Object.keys(config).some(k => !['globalRoot', 'sourceWorktree', 'sourceAgentDir', 'sourceDatabase', 'scratchDir', 'selections'].includes(k))
    || !Array.isArray(knownKeyValues) || !Array.isArray(config.selections) || !config.selections.length || config.selections.length > 20) throw fail('wiki_backfill_config_invalid');
  for (const key of ['globalRoot', 'sourceWorktree', 'sourceAgentDir', 'sourceDatabase', 'scratchDir']) {
    if (!path.isAbsolute(config[key] || '') || path.resolve(config[key]) !== config[key]) throw fail('wiki_backfill_config_invalid');
  }
  const writes = [config.globalRoot, config.scratchDir], sources = [config.sourceAgentDir, path.dirname(config.sourceDatabase), config.sourceWorktree];
  for (const s of config.selections) {
    if (!s || Object.keys(s).some(k => !['caseId', 'mode', 'captureRoot'].includes(k))
      || !/^[A-Za-z0-9_-]{1,128}$/.test(s.caseId || '') || !['live', 'sealed'].includes(s.mode)
      || (s.mode === 'sealed' ? !path.isAbsolute(s.captureRoot || '') : s.captureRoot !== undefined)) throw fail('wiki_backfill_config_invalid');
    if (s.mode === 'sealed') sources.push(path.resolve(s.captureRoot));
  }
  if (!disjoint(...writes) || writes.some(w => sources.some(s => !disjoint(w, s)))
    || new Set(config.selections.map(s => s.caseId)).size !== config.selections.length) throw fail('wiki_backfill_config_invalid');
  const store = createWikiStore({ globalRoot: config.globalRoot, sourceWorktree: config.sourceWorktree });
  const cases = store.read().cases;
  const selected = config.selections.map(s => {
    const item = cases.find(c => c.id === s.caseId);
    if (!item || (s.mode === 'live' && (item.kind !== 'text-only' || item.source.origin !== 'http://127.0.0.1:3100' || item.source.agentId !== 'role-family-gpt'))
      || (s.mode === 'sealed' && (!item.sealedCheckpointId || !item.source.projectId))) throw fail('wiki_backfill_selection_invalid');
    return { selection: s, item };
  });
  // A retry does not reopen source rows or mutable sessions for frozen cases.
  for (const { item } of selected) if (item.traceBundle) store.readCaseTrace(item.id);
  fs.mkdirSync(config.scratchDir, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(config.scratchDir).length || fs.realpathSync(config.scratchDir) !== config.scratchDir) throw fail('wiki_backfill_config_invalid');
  const audit = { readonly: true, queries: [], files: [] }, copied = new Map();
  function copy(source) {
    if (!copied.has(source)) {
      const result = copyReadOnlyFile(source, path.join(config.scratchDir, String(copied.size).padStart(3, '0') + '.source'));
      audit.files.push(result.proof); copied.set(source, result.bytes);
    }
    return copied.get(source);
  }
  function text(bytes) {
    const s = bytes.toString('utf8'); if (!Buffer.from(s).equals(bytes)) throw fail('wiki_backfill_source_invalid'); return s;
  }
  let db;
  function query(sql, ...args) {
    if (!db) {
      ordinary(config.sourceDatabase, Infinity); // Keyed reads only, never copy/read the whole database.
      db = openDatabase(config.sourceDatabase, { readonly: true, fileMustExist: true });
      if (db.readonly !== true) throw fail('wiki_backfill_readonly_required');
    }
    const copy = String(audit.queries.length).padStart(3, '0') + '.row';
    audit.queries.push({ sql, args, copy });
    const row = db.prepare(sql).get(...args) ?? null;
    const file = path.join(config.scratchDir, copy);
    fs.writeFileSync(file, JSON.stringify(row), { flag: 'wx', mode: 0o600 });
    return parse(fs.readFileSync(file, 'utf8')); // Process only the selected copied row.
  }
  const prepared = [], frozenAt = new Date().toISOString();
  try {
    for (const { selection: s, item } of selected) {
      if (item.traceBundle) { prepared.push({ item, existing: true }); continue; }
      const missing = [], source = item.source;
      let message = { content: item.message, metadata: {} }, snapshot = null, modelUsage = null, sessionText = null, checkpoint = null, retained = null;
      if (s.mode === 'live') {
        const row = query('SELECT id, conversation_id, agent_id, turn_id, task_id, role, content, metadata_json FROM chat_messages WHERE id = ? AND conversation_id = ? AND agent_id = ?', source.messageId, source.conversationId, source.agentId);
        if (!row || row.role !== 'assistant') missing.push('source_message_missing');
        else {
          const metadata = parse(row.metadata_json) || {};
          message = { content: row.content, metadata };
          const detail = query('SELECT snapshot_json FROM chat_message_context_snapshots WHERE message_id = ?', source.messageId);
          snapshot = detail ? parse(detail.snapshot_json) : metadata.agentContextSnapshot || null;
          const usage = query('SELECT model_call_count, calls_json FROM chat_message_model_usage_calls WHERE message_id = ?', source.messageId);
          modelUsage = usage ? { modelCallCount: usage.model_call_count, calls: parse(usage.calls_json) || [] } : metadata.modelUsage || null;
          if (row.task_id && (!metadata.sessionPath || metadata.sessionAssistantStartIndex == null)) {
            const task = query('SELECT session_path, metadata_json FROM a2a_tasks WHERE id = ?', row.task_id);
            if (task) {
              const tm = parse(task.metadata_json) || {};
              if (tm.conversationId !== source.conversationId || tm.agentId !== source.agentId || tm.turnId !== row.turn_id) throw fail('wiki_trace_association_mismatch');
              metadata.sessionPath ||= task.session_path;
              metadata.sessionAssistantStartIndex ??= tm.sessionAssistantStartIndex;
            }
          }
          if (metadata.sessionAssistantEndIndex == null && Number.isSafeInteger(metadata.sessionAssistantStartIndex)
            && Number.isSafeInteger(modelUsage?.modelCallCount) && modelUsage.modelCallCount > 0) {
            metadata.sessionAssistantEndIndex = metadata.sessionAssistantStartIndex + modelUsage.modelCallCount;
            missing.push('turn_end_inferred_from_usage');
          }
          const file = metadata.sessionPath;
          if (typeof file !== 'string' || !path.isAbsolute(file) || !inside(path.join(config.sourceAgentDir, 'named-sessions'), file) || path.extname(file) !== '.jsonl') missing.push('session_path_unavailable');
          else {
            try { sessionText = text(copy(file)); }
            catch (e) { if (e.code === 'ENOENT') missing.push('session_missing'); else throw e; }
            if (sessionText && (!Number.isSafeInteger(metadata.sessionAssistantStartIndex) || !Number.isSafeInteger(metadata.sessionAssistantEndIndex))) {
              const bounds = recoverBounds(sessionText, row.content);
              if (bounds && (metadata.sessionAssistantStartIndex == null || metadata.sessionAssistantStartIndex === bounds.sessionAssistantStartIndex)) {
                Object.assign(metadata, bounds); missing.push('turn_bounds_recovered_from_unique_reply');
              }
            }
          }
        }
      } else {
        const pr = path.join(s.captureRoot, 'projects', source.projectId);
        const cp = path.join(pr, 'checkpoints', item.sealedCheckpointId + '.json');
        try { checkpoint = parse(text(copy(cp))); }
        catch (e) { if (e.code === 'ENOENT') missing.push('checkpoint_missing'); else throw e; }
        if (checkpoint) {
          if (checkpoint.checkpointId !== item.sealedCheckpointId || ['projectId', 'conversationId', 'agentId'].some(k => checkpoint[k] !== source[k])) throw fail('wiki_trace_association_mismatch');
          const blob = h => {
            if (!/^[a-f0-9]{64}$/.test(h || '')) throw fail('wiki_backfill_source_invalid');
            const bytes = copy(path.join(pr, 'blobs', h.slice(0, 2), h));
            if (digest(bytes) !== h) throw fail('wiki_backfill_source_invalid'); return bytes;
          };
          const input = checkpoint.replayInput || {};
          let prompt = null, callback = null;
          if (input.promptBlobHash) prompt = text(blob(input.promptBlobHash));
          if (input.sessionBlobHash) sessionText = text(blob(input.sessionBlobHash));
          if (input.callbackInput?.blobHash) {
            callback = parse(text(blob(input.callbackInput.blobHash)));
            if (['projectId', 'conversationId', 'agentId'].some(k => callback.association?.[k] !== source[k])
              || callback.association?.assistantMessageId !== source.messageId || callback.association?.turnId !== checkpoint.turnId) throw fail('wiki_trace_association_mismatch');
          }
          // These are PRE-turn replay inputs, not a recording of its output.
          // Preserve their actual bytes without pretending the marked run exists.
          retained = { kind: 'sealed_pre_turn_inputs', prompt, callback, sessionPrefix: sessionText };
          sessionText = null;
          missing.push('sealed_marked_turn_not_recorded', 'sealed_prompt_may_have_controlled_replacements');
        }
        if (item.messageTruncated) missing.push('marked_message_truncated');
      }
      const bundle = buildWikiTraceBundle({ source, frozenAt, origin: 'backfill', message, snapshot, modelUsage, sessionText,
        checkpoint, actual: item.actual, expected: item.expected, knownKeyValues, missingReasons: missing, retained });
      prepared.push({ item, bundle });
    }
  } finally { db?.close(); }
  // Recheck after parsing all copies, before publishing any packet.
  for (const f of audit.files) {
    ordinary(f.source); f.after = digest(fs.readFileSync(f.source));
    if (f.after !== f.before) throw fail('wiki_backfill_source_changed');
  }
  const results = prepared.map(({ item, bundle, existing }) => {
    if (!existing) store.freezeCaseTrace(item.id, bundle);
    const packet = store.readCaseTrace(item.id), reference = wikiTraceReference(packet);
    return { caseId: item.id, status: existing ? 'already_frozen' : packet.complete ? 'complete' : packet.steps.length ? 'partial' : 'unavailable', ...reference };
  });
  return { schemaVersion: 1, frozenAt, results: projectBackfillResults(results, cases), audit };
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 3 || args[0] !== '--config' || !path.isAbsolute(args[1]) || args[2] !== '--confirmed') throw fail('wiki_backfill_usage');
  const config = parse(fs.readFileSync(args[1], 'utf8'));
  const { readKnownKeyValues } = require('./known-key-values.cjs');
  const inventory = readKnownKeyValues({ sandboxRoot: config.sourceAgentDir, jevSource: 'pi-state.sqlite:turn-time-breakdown-jev' });
  const report = backfillWikiTraces({ config, confirmed: true, knownKeyValues: inventory.values });
  fs.writeFileSync(path.join(config.scratchDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ results: report.results, sourcesUnchanged: report.audit.files.every(f => f.before === f.after), queryCount: report.audit.queries.length }) + '\n');
}
if (require.main === module) main().catch(e => {
  const code = /^(?:wiki_[a-z_]+|evaluation_known_keys_unavailable)$/.test(e.code || '') ? e.code : 'wiki_backfill_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
});
module.exports = { backfillWikiTraces, copyReadOnlyFile, projectBackfillResults, main };
