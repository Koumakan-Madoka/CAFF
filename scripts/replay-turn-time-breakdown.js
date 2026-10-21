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
//   --emit-strata <path>      (with --scan-sessions) write per-stratum
//                             population counts {stratum: {count, durationMs}}
//                             for the golden sample's weighted guardrail.
//
// Caliber notes (important — see contract §13):
//  - Turn windows come from chat_messages.created_at..updated_at; steps are
//    assigned by startedAtMs. thinking = window minus tool-call union.
//
// Reference reproductions (main DB, build at W6 re-review acceptance):
//  - 三期房间 10-20 batch (58 GPT turns, 20.41h), command:
//      --conversation b7e50f1c --agent role-family-gpt --from 2026-10-20 --to 2026-10-21
//      rules-only: test 0.0% (unclassified 63.2%)
//      +--overlay: test 59.5%
//      +--overlay --test-adjacent: test+adjacent 69.9%
//    The 10-20 retrospective "~76%" is not mid-band reproducible under any
//    documented caliber; see contract §13.2 for the full table.
//  - GLM first-write (三期房间 10-14..17, --agent role-family-glm
//    --first-write): repo-scope session-level mean 9.4 min / median 6.8
//    (n=113) — inside the retrospective 9.8±1 band. Before the §5 write
//    scope fix (sandbox probe scripts counted as writes) the mean was 8.5.
//  - Corpus null share (contract §13.1): --scan-sessions gives 27.0% for
//    10-14..10-21 (587 sessions / 30,348 steps) and 22.5% for the full
//    window (977 sessions / 53,022 steps).
//  - GLM first-write (三期房间 10-14..17, --agent role-family-glm --first-write):
//    repo-scope session-level mean in the 9.8±1 band; see §13.2.
const path = require('path');
const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes('--' + name);

const DB_PATH = arg('db', '.pi-sandbox/pi-state.sqlite');
const SANDBOX = arg('sandbox', '.pi-sandbox');
const CONVERSATION = arg('conversation', null);
const FROM = arg('from', '1970-01-01');
const TO = arg('to', '2999-01-01');
const AGENT = arg('agent', null);
const OVERLAY = has('overlay');
const TEST_ADJACENT = has('test-adjacent');
const FIRST_WRITE = has('first-write');
const SCAN_SESSIONS = has('scan-sessions');
const EMIT_STRATA = arg('emit-strata', null);

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
