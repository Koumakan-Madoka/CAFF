#!/usr/bin/env node
// Replays the turn time breakdown classifier over historical chat messages and
// prints category shares + GLM-style first-write latency, for retrospective
// acceptance (contract docs/engineering/backend/turn-time-breakdown.md §13).
//
//   node scripts/replay-turn-time-breakdown.js \
//     --db .pi-sandbox/pi-state.sqlite --sandbox .pi-sandbox \
//     --conversation b7e50f1c --from 2026-10-20 --to 2026-10-21
//
// Options:
//   --agent role-family-glm   filter turns by agent
//   --overlay                 apply the golden-sample-derived wrapper overlay;
//                             stands in for JEV classifications (credentials
//                             absent in this environment). Batch-specific:
//                             valid as replay evidence for THIS corpus only.
//   --test-adjacent           (requires --overlay) additionally count
//                             build-check steps and read/write steps touching
//                             test paths (tests/ dirs, *.test.* / *.spec.*)
//                             toward the test share.
//   --first-write             session-level first-write latency stats; only
//                             repo-scope writes count (§5 write scope:
//                             sandbox/temp scratch never moves 首次改仓库文件).
//   --scan-sessions           corpus mode: classify every step of every
//                             <conversation>-prefixed session file and print
//                             time-weighted category shares (the corpus-level
//                             rules-null share, contract §13.1).
//   --store <scratchDb>       DB-path (落库) replay: copies --db to the
//                             scratch path, migrates the chat schema, then
//                             drives the real service
//                             (getTurnTimeBreakdownForMessage) for every
//                             assistant message in the window so steps and
//                             summaries land in the chat_turn_time_* tables.
//                             With --overlay, rows the rules left
//                             unclassified are reclassified via the overlay
//                             as pseudo-JEV (classified_by='jev') and the
//                             summaries recomputed — mirroring production
//                             async JEV resolution. Aggregates are read back
//                             FROM THE DB, not from memory.
//   --emit-strata <path>      (with --scan-sessions) write per-stratum
//                             population counts {stratum: {count, durationMs}}
//                             for the golden sample's weighted guardrail.
//
// Caliber notes (important — see contract §13):
//  - Turn windows come from chat_messages.created_at..updated_at; steps are
//    assigned by startedAtMs. thinking = window minus tool-call union.
//
// Reference reproductions (main DB, build at W7):
//  - 三期房间 10-20 batch (58 GPT turns), command:
//      --conversation b7e50f1c --agent role-family-gpt --from 2026-10-20 --to 2026-10-21
//    Window caliber (created_at..updated_at, 20.41h):
//      rules-only: test 0.0% (unclassified 63.2%)
//      +--overlay: test 59.5%
//      +--overlay --test-adjacent: test+adjacent 69.9%
//    DB-path caliber (--store <scratchDb>, §3 spans, 18.93h):
//      rules-only: test 0.0% (unclassified 68.0%)
//      +--overlay: test 64.5%
//      +--overlay --test-adjacent: test+adjacent 75.4% — inside 76%±5
//    See contract §13.2 for the full table and caliber definitions.
//  - GLM first-write (三期房间 10-14..17, --agent role-family-glm
//    --first-write): repo-scope session-level mean 9.4 min / median 6.8
//    (n=113) — inside the retrospective 9.8±1 band, identical in the
//    window and DB-path calibers. Before the §5 write scope fix (sandbox
//    probe scripts counted as writes) the mean was 8.5.
//  - Corpus null share (contract §13.1): --scan-sessions gives 27.0% for
//    10-14..10-21 (587 sessions / 30,348 steps) and 22.5% for the full
//    window (977 sessions / 53,022 steps).
const path = require('path');
const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name);

// Paths default to the repo-root sandbox, resolved against the repo
// root (not the caller's cwd) so the documented commands re-run from
// anywhere; explicit --db/--sandbox values are honored as given.
const REPO_ROOT = path.join(__dirname, '..');
function resolveRepoRelative(p) {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}
const DB_PATH = resolveRepoRelative(arg('db', '.pi-sandbox/pi-state.sqlite'));
const SANDBOX = resolveRepoRelative(arg('sandbox', '.pi-sandbox'));
const CONVERSATION = arg('conversation', null);
const FROM = arg('from', '1970-01-01');
const TO = arg('to', '2999-01-01');
const AGENT = arg('agent', null);
const OVERLAY = has('overlay');
const TEST_ADJACENT = has('test-adjacent');
if (TEST_ADJACENT && !OVERLAY) {
  console.error('--test-adjacent requires --overlay (see header caliber notes); alone it produces a number that belongs to no documented caliber.');
  process.exit(1);
}
const FIRST_WRITE = has('first-write');
const SCAN_SESSIONS = has('scan-sessions');
const EMIT_STRATA = arg('emit-strata', null);
const STORE = arg('store', null);

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const mod = require(path.join(__dirname, '..', 'build', 'server', 'domain', 'runtime', 'turn-time-breakdown.js'));

// Overlay derived from the W6 golden sample labels (tests/fixtures/
// turn-time-breakdown-golden.json); production equivalent is JEV + cache.
// Valid as replay evidence for this corpus batch only.
const OVERLAY_RULES = [
  [/workflow-wiring-\d+\/s\d+-[\w-]*-run\.py/, 'test'],
  [/workflow-wiring-\d+\/s\d+-[\w-]*-observe\.py.*(?:selector|entry|suite|workflow)/, 'test'],
  [/w4-[\w-]*\/check\.mjs/, 'test'],
  [/s8-delivery-debug\.mjs/, 'test'],
  [/w4-group5-verify\/supervise\.mjs/, 'test'],
  [/node\s+["']?[^\n]*?scripts\/test-isolated\.mjs\s+\S/, 'test'],
];
function overlayCategory(command, output) {
  for (const [re, cat] of OVERLAY_RULES) if (re.test(command)) return cat;
  if (/"accepted"\s*:/.test(output) && /guard_rejections|failureType/.test(output)) return 'test';
  return null;
}

// --test-adjacent: a read/write step touching a test path (tests/ dir,
// __tests__/, *.test.* / *.spec.* file) is counted toward the test share.
const TEST_DIR_RE = /(^|[\\/])(tests?|__tests__)([\\/]|$)/i;
const TEST_FILE_RE = /\.(test|spec)\.[a-z0-9]+/i;
function touchesTestPath(step) {
  const args = step.args && typeof step.args === 'object' ? step.args : {};
  const command = String(args.command || '');
  const target = String(args.path || args.file_path || args.filePath || '');
  return TEST_DIR_RE.test(command) || TEST_FILE_RE.test(command)
    || TEST_DIR_RE.test(target) || TEST_FILE_RE.test(target);
}

function unionMs(intervals) {
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, [cs, ce] = intervals[0];
  for (const [s, e] of intervals) { if (s > ce) { total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e; }
  return total + (ce - cs);
}

function bucketOf(durationMs) {
  return durationMs < 5000 ? 'short' : durationMs < 60000 ? 'mid' : 'long';
}

// --scan-sessions: corpus-level rules outcome shares over every step of every
// session file whose name starts with the conversation prefix. This is the
// honest corpus null share (contract §13.1), as opposed to the stratified
// sample's internal share.
if (SCAN_SESSIONS) {
  if (!CONVERSATION) {
    console.error('--scan-sessions requires --conversation <prefix>');
    process.exit(1);
  }
  const sessionsDir = path.join(SANDBOX, 'named-sessions');
  const files = fs.readdirSync(sessionsDir)
    .filter((f) => f.startsWith(`chat-${CONVERSATION}-`) && f.endsWith('.jsonl'));
  // Session filenames carry no date; --from/--to filter steps by timestamp.
  const fromMs = Date.parse(FROM);
  const toMs = Date.parse(TO);
  const inWindow = (ms) => (!Number.isFinite(fromMs) || ms >= fromMs)
    && (!Number.isFinite(toMs) || ms < toMs);
  const totals = {};
  const strata = {};
  let steps = 0;
  let usedFiles = 0;
  for (const f of files) {
    let parsed;
    try { parsed = mod.parseSessionTurnSteps(path.join(sessionsDir, f), SANDBOX, {}); } catch { continue; }
    if (!parsed) continue;
    const classifier = mod.createTurnRuleClassifier();
    let fileSteps = 0;
    for (const s of parsed.steps) {
      if (!Number.isFinite(s.durationMs) || s.durationMs <= 0) continue;
      if (Number.isFinite(s.startedAtMs) && !inWindow(s.startedAtMs)) continue;
      steps += 1;
      fileSteps += 1;
      const r = classifier.classify(s);
      const cat = (r && r.category) || 'NULL';
      totals[cat] = (totals[cat] || 0) + s.durationMs;
      const key = `${s.toolName}|${cat}|${bucketOf(s.durationMs)}`;
      const entry = strata[key] || (strata[key] = { count: 0, durationMs: 0 });
      entry.count += 1;
      entry.durationMs += Math.round(s.durationMs);
    }
    if (fileSteps > 0) usedFiles += 1;
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  console.log(`corpus scan: sessions ${usedFiles}/${files.length} steps ${steps} total ${(grand / 3600000).toFixed(2)}h`);
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${(v / 3600000).toFixed(2)}h ${((v / grand) * 100).toFixed(1)}%`);
  }
  if (EMIT_STRATA) {
    fs.writeFileSync(EMIT_STRATA, JSON.stringify(strata, null, 1));
    console.log(`strata population written: ${EMIT_STRATA} (${Object.keys(strata).length} strata)`);
  }
  process.exit(0);
}

// --store <scratchDb>: DB-path (落库) replay. Every classification and
// summary goes through the real service + repository into the
// chat_turn_time_* tables of a SCRATCH copy of the DB; aggregates are read
// back from those tables, so the numbers evidence the product path, not an
// in-memory approximation (the W6 re-review lesson: a replay that bypasses
// the store proves nothing about the store).
if (STORE) {
  if (path.resolve(STORE) === path.resolve(DB_PATH)) {
    console.error('--store must point at a scratch copy path, never the live DB.');
    process.exit(1);
  }
  fs.copyFileSync(DB_PATH, STORE);
  for (const ext of ['-wal', '-shm']) {
    try { fs.copyFileSync(DB_PATH + ext, STORE + ext); } catch { /* no wal */ }
  }
  const dbw = new Database(STORE);
  const migrations = require(path.join(__dirname, '..', 'build', 'storage', 'sqlite', 'migrations.js'));
  migrations.migrateChatSchema(dbw);
  const repository = require(path.join(__dirname, '..', 'build', 'storage', 'chat', 'turn-time-breakdown.repository.js'))
    .createTurnTimeBreakdownRepository(dbw);
  const service = require(path.join(__dirname, '..', 'build', 'server', 'domain', 'runtime', 'turn-time-breakdown-service.js'));

  let msql = `SELECT id, conversation_id, task_id, status, metadata_json, created_at, updated_at
    FROM chat_messages WHERE role='assistant' AND created_at >= ? AND created_at < ?`;
  const mparams = [FROM, TO];
  if (CONVERSATION) { msql += ` AND conversation_id LIKE ?`; mparams.push(CONVERSATION + '%'); }
  if (AGENT) { msql += ` AND agent_id = ?`; mparams.push(AGENT); }
  msql += ' ORDER BY created_at';
  const msgRows = dbw.prepare(msql).all(...mparams);

  const callService = (m) => {
    const metadata = JSON.parse(m.metadata_json || '{}');
    return service.getTurnTimeBreakdownForMessage({
      db: dbw,
      agentDir: SANDBOX,
      repository,
      resolvedSessionPath: String(metadata.sessionPath || ''),
      message: {
        id: m.id,
        conversationId: m.conversation_id,
        taskId: m.task_id,
        status: m.status,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        metadata,
      },
    });
  };

  let stored = 0;
  for (const m of msgRows) {
    try { if (callService(m)) stored += 1; } catch (e) { console.error(`store skip ${m.id}: ${e.message}`); }
  }

  if (OVERLAY) {
    // Pseudo-JEV: reclassify the rows rules left unclassified, exactly as
    // production async JEV resolution would (classified_by='jev', cache
    // semantics aside). The summary rows are then dropped so the next
    // service pass recomputes them from the preserved jev rows.
    const pending = dbw.prepare(`SELECT * FROM chat_turn_time_steps WHERE category='unclassified'`).all();
    let resolved = 0;
    for (const row of pending) {
      const payload = JSON.parse(row.payload_json || 'null');
      if (!payload) continue;
      const cat = overlayCategory(
        String((payload.args && payload.args.command) || ''),
        typeof payload.output === 'string' ? payload.output : '');
      if (!cat) continue;
      repository.upsertStep({
        taskId: row.task_id,
        messageId: row.message_id,
        stepKey: row.step_key,
        toolName: row.tool_name,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        category: cat,
        subcategory: null,
        classifiedBy: 'jev',
        jevStatus: 'ok',
        confidence: null,
        runKind: null,
        runFailed: cat === 'test' ? mod.detectTestFailure(payload.output, false) : null,
        testRunCounts: null,
        writeScope: null,
        payloadJson: row.payload_json,
      });
      resolved += 1;
    }
    dbw.prepare('DELETE FROM chat_turn_time_summaries').run();
    for (const m of msgRows) {
      try { callService(m); } catch { /* recompute best-effort */ }
    }
    console.log(`store: overlay resolved ${resolved}/${pending.length} unclassified rows as pseudo-JEV`);
  }

  // Aggregate FROM THE DB: per-turn summaries' category_ms_json.
  const msgIds = new Set(msgRows.map((m) => m.id));
  const msgById = new Map(msgRows.map((m) => [m.id, m]));
  const sessionOf = new Map();
  for (const m of msgRows) {
    const md = JSON.parse(m.metadata_json || '{}');
    if (md.sessionPath) sessionOf.set(m.id, md.sessionPath);
  }
  const sums = dbw.prepare(`SELECT message_id, category_ms_json FROM chat_turn_time_summaries`).all()
    .filter((s) => msgIds.has(s.message_id));
  const totals = {};
  for (const s of sums) {
    const cms = JSON.parse(s.category_ms_json || '{}');
    for (const [k, v] of Object.entries(cms)) {
      if (Number.isFinite(v)) totals[k] = (totals[k] || 0) + v;
    }
  }
  if (TEST_ADJACENT) {
    // DB categories + session args lookup: read/write/build-check steps are
    // remapped to test when the parsed step's command/path touches a test
    // path. Args are not stored for rules-classified rows, so the sessions
    // are re-parsed once for the lookup (hybrid caliber — labelled as such).
    const parsedCache = new Map();
    const stepsRows = dbw.prepare(
      `SELECT message_id, tool_name, category, started_at, duration_ms FROM chat_turn_time_steps
       WHERE category IN ('read', 'write', 'build-check')`).all();
    let remapped = 0;
    for (const row of stepsRows) {
      if (!msgIds.has(row.message_id)) continue;
      const sp = sessionOf.get(row.message_id);
      if (!sp) continue;
      if (!parsedCache.has(sp)) {
        try { parsedCache.set(sp, mod.parseSessionTurnSteps(sp, SANDBOX, {})); } catch { parsedCache.set(sp, null); }
      }
      const parsed = parsedCache.get(sp);
      if (!parsed) continue;
      const startMs = Date.parse(row.started_at);
      const match = parsed.steps.find((s) => s.toolName === row.tool_name && s.startedAtMs === startMs);
      if (!match) continue;
      if (row.category === 'build-check' || touchesTestPath(match)) {
        // Move this step's stored duration from its DB category to test.
        const dur = Number.isFinite(row.duration_ms) ? row.duration_ms : 0;
        totals[row.category] -= dur;
        totals.test = (totals.test || 0) + dur;
        remapped += 1;
      }
    }
    console.log(`store: test-adjacent remapped ${remapped} steps (DB categories + session args lookup)`);
  }
  const grand = Object.values(totals).reduce((a, b) => a + b, 0);
  console.log(`store: messages ${msgRows.length} summaries ${sums.length} total ${(grand / 3600000).toFixed(2)}h (DB caliber)`);
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${(v / 3600000).toFixed(2)}h ${((v / grand) * 100).toFixed(1)}%`);
  }

  if (FIRST_WRITE) {
    // Session-level first repo write, read back from the stored steps:
    // min(started_at over write steps with repo/unknown scope) minus the
    // session's earliest in-window message created_at.
    const writes = dbw.prepare(
      `SELECT message_id, started_at FROM chat_turn_time_steps
       WHERE category='write' AND (write_scope IS NULL OR write_scope IN ('repo','unknown'))`).all()
      .filter((w) => msgIds.has(w.message_id));
    const sessionFirst = new Map();
    for (const m of msgRows) {
      const md = JSON.parse(m.metadata_json || '{}');
      if (!md.sessionPath) continue;
      const cur = sessionFirst.get(md.sessionPath) || { start: Infinity, write: null };
      cur.start = Math.min(cur.start, Date.parse(m.created_at));
      sessionFirst.set(md.sessionPath, cur);
    }
    for (const w of writes) {
      const mRow = msgById.get(w.message_id);
      if (!mRow) continue;
      const md = JSON.parse(mRow.metadata_json || '{}');
      if (!md.sessionPath || !sessionFirst.has(md.sessionPath)) continue;
      const cur = sessionFirst.get(md.sessionPath);
      const ws = Date.parse(w.started_at);
      if (Number.isFinite(ws) && (cur.write === null || ws < cur.write)) cur.write = ws;
    }
    const lat = [];
    for (const cur of sessionFirst.values()) {
      if (cur.write !== null && cur.write >= cur.start) lat.push((cur.write - cur.start) / 60000);
    }
    lat.sort((a, b) => a - b);
    if (lat.length) {
      console.log(`session first-write latency (DB caliber): n=${lat.length} median ${lat[Math.floor(lat.length / 2)].toFixed(1)}min mean ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1)}min`);
    } else {
      console.log('session first-write latency (DB caliber): no repo-scope writes found');
    }
  }
  dbw.close();
  process.exit(0);
}

const db = new Database(DB_PATH, { readonly: true });
let sql = `SELECT metadata_json, created_at, updated_at FROM chat_messages
  WHERE role='assistant' AND created_at >= ? AND created_at < ?`;
const params = [FROM, TO];
if (CONVERSATION) { sql += ` AND conversation_id LIKE ?`; params.push(CONVERSATION + '%'); }
if (AGENT) { sql += ` AND agent_id = ?`; params.push(AGENT); }
sql += ' ORDER BY created_at';
const rows = db.prepare(sql).all(...params);

const bySession = new Map();
for (const r of rows) {
  const m = JSON.parse(r.metadata_json || '{}');
  if (!m.sessionPath) continue;
  if (!bySession.has(m.sessionPath)) bySession.set(m.sessionPath, []);
  bySession.get(m.sessionPath).push({ createdMs: Date.parse(r.created_at), updatedMs: Date.parse(r.updated_at) });
}

const totals = {};
const add = (k, v) => { totals[k] = (totals[k] || 0) + v; };
const sessionFirstWrite = [];

for (const [sessionPath, turns] of bySession) {
  const parsed = mod.parseSessionTurnSteps(sessionPath, SANDBOX, {});
  if (!parsed) {
    // Missing/unreadable session file (e.g. --sandbox pointing at the
    // wrong directory): skip honestly instead of crashing on .steps.
    console.error(`skip: session not parseable: ${sessionPath}`);
    continue;
  }
  if (FIRST_WRITE && turns.length) {
    const classifier = mod.createTurnRuleClassifier();
    let firstWrite = null;
    for (const s of parsed.steps) {
      if (!Number.isFinite(s.startedAtMs)) continue;
      const c = classifier.classify(s);
      // Only a repo-scope write moves 首次改仓库文件 (§5 write scope);
      // sandbox/temp probe-script writes are still `write` but do not count.
      if (c && c.category === 'write' && mod.writeScopeCountsAsRepo(c.writeScope)) {
        firstWrite = s.startedAtMs;
        break;
      }
    }
    if (firstWrite != null && firstWrite >= turns[0].createdMs) {
      sessionFirstWrite.push((firstWrite - turns[0].createdMs) / 60000);
    }
  }
  for (const t of turns) {
    const start = t.createdMs, end = Math.max(t.updatedMs, start);
    const intervals = [];
    for (const s of parsed.steps) {
      if (!Number.isFinite(s.startedAtMs) || s.startedAtMs < start || s.startedAtMs >= end + 5000) continue;
      const r = mod.createTurnRuleClassifier().classify(s);
      let cat = r && r.category;
      if (!cat && OVERLAY) {
        cat = overlayCategory((s.args && s.args.command) || '', typeof s.output === 'string' ? s.output : '');
      }
      if (TEST_ADJACENT) {
        // test + build-check + test-path-adjacent IO → the test share.
        if (cat === 'build-check' || ((cat === 'read' || cat === 'write') && touchesTestPath(s))) {
          cat = 'test';
        }
      }
      add(cat || 'unclassified', Number.isFinite(s.durationMs) ? s.durationMs : 0);
      if (Number.isFinite(s.endedAtMs)) intervals.push([s.startedAtMs, s.endedAtMs]);
    }
    add('thinking', Math.max(0, (end - start) - unionMs(intervals)));
  }
}

const grand = Object.values(totals).reduce((a, b) => a + b, 0);
console.log(`turns: ${rows.length} sessions: ${bySession.size} total: ${(grand / 3600000).toFixed(2)}h`);
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${(v / 3600000).toFixed(2)}h ${((v / grand) * 100).toFixed(1)}%`);
}
if (FIRST_WRITE && sessionFirstWrite.length) {
  sessionFirstWrite.sort((a, b) => a - b);
  console.log(`session first-write latency: n=${sessionFirstWrite.length} median ${sessionFirstWrite[Math.floor(sessionFirstWrite.length / 2)].toFixed(1)}min mean ${(sessionFirstWrite.reduce((a, b) => a + b, 0) / sessionFirstWrite.length).toFixed(1)}min`);
}
