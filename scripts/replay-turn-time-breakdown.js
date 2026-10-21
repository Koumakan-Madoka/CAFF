#!/usr/bin/env node
// Replays the turn time breakdown classifier over historical chat messages and
// prints category shares + GLM-style first-write latency, for retrospective
// acceptance (contract docs/engineering/backend/turn-time-breakdown.md §13).
//
//   node scripts/replay-turn-time-breakdown.js \
//     --db .pi-sandbox/pi-state.sqlite --sandbox .pi-sandbox \
//     --conversation b7e50f1c --from 2026-10-20 --to 2026-10-21
//
// Options: --agent role-family-glm (filter), --overlay (apply the golden-
// sample-derived wrapper overlay; stands in for JEV classifications which need
// credentials), --first-write (session-level first-write latency stats).
//
// Caliber notes (important — see contract §13):
//  - Turn windows come from chat_messages.created_at..updated_at; steps are
//    assigned by startedAtMs. thinking = window minus tool-call union.
//  - --overlay maps rule-null wrapper steps (e.g. workflow-wiring s8 harness)
//    to categories per the reviewed golden sample; it is the replay-time
//    substitute for the production JEV+cache path.
//
// Reference reproductions (main DB, build at W6 acceptance):
//  - 三期房间 10-20 batch (58 GPT turns, 20.41h): strict per-step test share
//    59.5%; with overlay the same; test + build-check + test-file IO 71.2%.
//    The 10-20 retrospective "~76%" could not be reproduced within ±5pp under
//    any documented caliber; closest documented caliber lands at the lower
//    tolerance edge. See contract §13 for the full caliber table.
//  - GLM first-write (三期房间 10-14..17): turn-level median 5.2 / mean 6.5
//    min; session-level median 6.6 / mean 8.5 min vs retrospective ~9.8±1.
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
const FIRST_WRITE = has('first-write');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const mod = require(path.join(__dirname, '..', 'build', 'server', 'domain', 'runtime', 'turn-time-breakdown.js'));

// Overlay derived from the W6 golden sample labels (tests/fixtures/
// turn-time-breakdown-golden.json); production equivalent is JEV + cache.
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

function unionMs(intervals) {
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, [cs, ce] = intervals[0];
  for (const [s, e] of intervals) { if (s > ce) { total += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e; }
  return total + (ce - cs);
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
      if (c && c.category === 'write') { firstWrite = s.startedAtMs; break; }
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
