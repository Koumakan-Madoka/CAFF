// Per-day / per-agent efficiency analysis of a CAFF room.
// Joins fetched messages (messages.json) with pi session logs split into turns.
// usage: node analyze-room.js <messages.json> <sessionsDir> <conversationId>
const fs = require('fs');
const path = require('path');

const [messagesFile, sessionsDir, roomId] = process.argv.slice(2);
const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
const day = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 10);
const hours = (ms) => (ms / 3600000).toFixed(1);
const mins = (ms) => (ms / 60000).toFixed(1);
const GOAL_UPDATE_RE = /update-goal|update_goal|suggest-goal|session-goal|\/goal\b/;
const PRIVATE_PATH_RE = /agent-sandboxes|[\\/]private[\\/]|\.pi-sandbox/;
const TEST_RE = /npm (run )?test|node --test|vitest|jest|test:fast|test:smoke|run-tests|typecheck|tsc\b/;
const DOCKER_RE = /docker\b/;

// ---- session logs split into turns ----
function loadTurns(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const turns = [];
  let turn = null;
  let previous = null;
  const pending = {};
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const now = new Date(entry.timestamp).getTime();
    const message = entry.type === 'message' ? entry.message : null;
    if (message && message.role === 'user') {
      const content = message.content;
      const text = Array.isArray(content) ? content.map((part) => part.text || '').join('') : String(content);
      turn = { start: now, end: now, promptChars: text.length, index: turns.length, model: 0, tool: 0, calls: 0, edits: 0, reads: 0, firstEdit: null, longRuns: [], goalCalls: 0, goalOk: 0, goal409: 0, testMs: 0, testRuns: 0, dockerMs: 0, maxCtx: 0, output: 0, input: 0, cacheRead: 0 };
      turns.push(turn);
      previous = now;
      continue;
    }
    if (!turn) { previous = now; continue; }
    turn.end = now;
    if (message && message.role === 'assistant') {
      turn.calls += 1;
      const requestStart = typeof message.timestamp === 'number' ? message.timestamp : previous;
      turn.model += Math.max(0, now - requestStart);
      const usage = message.usage || {};
      turn.maxCtx = Math.max(turn.maxCtx, (usage.input || 0) + (usage.cacheRead || 0));
      turn.output += usage.output || 0;
      turn.input += usage.input || 0;
      turn.cacheRead += usage.cacheRead || 0;
      for (const block of message.content || []) {
        if (block.type !== 'toolCall') continue;
        pending[block.id] = block;
        const args = block.arguments || {};
        if (block.name === 'read') turn.reads += 1;
        if ((block.name === 'edit' || block.name === 'write') && !PRIVATE_PATH_RE.test(String(args.path || ''))) {
          turn.edits += 1;
          if (turn.firstEdit === null) turn.firstEdit = now - turn.start;
        }
      }
    }
    if (message && message.role === 'toolResult') {
      const elapsed = Math.max(0, now - previous);
      turn.tool += elapsed;
      const call = pending[message.toolCallId];
      const command = call && call.name === 'bash' ? String((call.arguments || {}).command || '') : '';
      if (command && elapsed >= 120000) turn.longRuns.push({ ms: elapsed, command: command.replace(/\s+/g, ' ').slice(0, 140) });
      if (command && TEST_RE.test(command)) { turn.testMs += elapsed; turn.testRuns += 1; }
      if (command && DOCKER_RE.test(command)) turn.dockerMs += elapsed;
      if (command && /update-goal|update_goal|updateGoal/.test(command)) {
        turn.goalCalls += 1;
        const output = (message.content || []).map((part) => part.text || '').join('');
        if (/goal_structural_review_required|goal_revision_conflict|\b409\b/.test(output)) turn.goal409 += 1;
        else if (/"ok":\s*true|"revision"/.test(output)) turn.goalOk += 1;
      }
    }
    previous = now;
  }
  return turns;
}

const sessionFiles = fs.readdirSync(sessionsDir).filter((name) => name.startsWith(`chat-${roomId}-`) && name.endsWith('.jsonl'));
const turnsByFile = {};
for (const name of sessionFiles) turnsByFile[name] = loadTurns(path.join(sessionsDir, name));

// ---- join assistant messages to session turns ----
const assistants = messages.filter((m) => m.role === 'assistant');
const byFile = {};
for (const m of assistants) {
  const sp = (m.metadata || {}).sessionPath;
  if (!sp) continue;
  const base = path.basename(String(sp).replace(/\\/g, '/'));
  (byFile[base] = byFile[base] || []).push(m);
}
let joined = 0;
let mismatched = 0;
for (const [base, list] of Object.entries(byFile)) {
  list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const turns = turnsByFile[base];
  if (!turns) continue;
  // match each message to the session turn whose start is closest to the message creation time
  for (const m of list) {
    const created = new Date(m.createdAt).getTime();
    let best = null;
    for (const t of turns) {
      if (t.claimed) continue;
      const delta = Math.abs(t.start - created);
      if (!best || delta < best.delta) best = { t, delta };
    }
    if (best && best.delta < 10 * 60000) {
      best.t.claimed = true;
      m._turn = best.t;
      joined += 1;
    } else mismatched += 1;
  }
}
console.log(`assistant messages ${assistants.length} | joined to session turns ${joined} | unmatched ${mismatched} | session files ${sessionFiles.length} | session turns ${Object.values(turnsByFile).reduce((s, t) => s + t.length, 0)}`);

// ---- classify each assistant turn ----
function classify(m) {
  const md = m.metadata || {};
  if (md.triggerType === 'user' && md.goalAutoContinue) return 'runner';
  if (md.triggerType === 'user') return 'user';
  return md.goalAutoContinue ? 'agent(auto)' : 'agent';
}

// ---- per-day table ----
const days = {};
for (const m of assistants) {
  const created = new Date(m.createdAt).getTime();
  const updated = new Date(m.updatedAt).getTime();
  const d = day(created);
  const md = m.metadata || {};
  const row = (days[d] = days[d] || { turns: 0, wall: 0, byAgent: {}, cls: {}, cold: 0, revCold: 0, failed: 0, goalCalls: 0, goalOk: 0, goal409: 0, longMs: 0, testMs: 0, testRuns: 0, dockerMs: 0, model: 0, firstEditSum: 0, firstEditN: 0, revMin: Infinity, revMax: -Infinity, output: 0 });
  row.turns += 1;
  const wall = m._turn ? m._turn.end - m._turn.start : Math.max(0, updated - created);
  row.wall += wall;
  row.byAgent[m.senderName] = (row.byAgent[m.senderName] || 0) + wall;
  const cls = classify(m);
  row.cls[cls] = (row.cls[cls] || 0) + 1;
  if (md.sessionReused === false) row.cold += 1;
  if (md.sessionReuseReason === 'goal_revision_mismatch') row.revCold += 1;
  if (m.status === 'failed') row.failed += 1;
  if (typeof md.goalRevision === 'number') { row.revMin = Math.min(row.revMin, md.goalRevision); row.revMax = Math.max(row.revMax, md.goalRevision); }
  if (m._turn) {
    const t = m._turn;
    row.goalCalls += t.goalCalls; row.goalOk += t.goalOk; row.goal409 += t.goal409;
    row.longMs += t.longRuns.reduce((s, r) => s + r.ms, 0);
    row.testMs += t.testMs; row.testRuns += t.testRuns; row.dockerMs += t.dockerMs;
    row.model += t.model; row.output += t.output;
    if (t.firstEdit !== null) { row.firstEditSum += t.firstEdit; row.firstEditN += 1; }
  }
}
console.log('\nday   turns wallH  byAgent(h)                                  class                                   cold(revMismatch) failed rev(min-max) goalCalls(ok/409) testH(runs) dockerH long>=2m(h) avgFirstEdit(min)');
const total = { turns: 0, wall: 0, testMs: 0, dockerMs: 0, longMs: 0, goalCalls: 0, cold: 0, revCold: 0 };
for (const [d, r] of Object.entries(days).sort()) {
  const byAgent = Object.entries(r.byAgent).map(([k, v]) => `${k}:${hours(v)}`).join(' ');
  const cls = Object.entries(r.cls).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`${d} ${String(r.turns).padStart(5)} ${hours(r.wall).padStart(5)}  ${byAgent.padEnd(42)}  ${cls.padEnd(38)}  ${r.cold}(${r.revCold})  ${r.failed}  ${r.revMin === Infinity ? '-' : `${r.revMin}-${r.revMax}`}  ${r.goalCalls}(${r.goalOk}/${r.goal409})  ${hours(r.testMs)}(${r.testRuns})  ${hours(r.dockerMs)}  ${hours(r.longMs)}  ${r.firstEditN ? mins(r.firstEditSum / r.firstEditN) : '-'}`);
  total.turns += r.turns; total.wall += r.wall; total.testMs += r.testMs; total.dockerMs += r.dockerMs; total.longMs += r.longMs; total.goalCalls += r.goalCalls; total.cold += r.cold; total.revCold += r.revCold;
}
console.log(`TOTAL turns ${total.turns} | wall ${hours(total.wall)}h | tests ${hours(total.testMs)}h | docker ${hours(total.dockerMs)}h | long runs ${hours(total.longMs)}h | update-goal calls ${total.goalCalls} | cold ${total.cold} (goal_revision_mismatch ${total.revCold})`);

// ---- per agent totals ----
const agents = {};
for (const m of assistants) {
  const a = (agents[m.senderName] = agents[m.senderName] || { turns: 0, wall: 0, cold: 0, revCold: 0, failed: 0, firstEditCold: [], firstEditWarm: [], promptCold: [], goalCalls: 0 });
  const md = m.metadata || {};
  a.turns += 1;
  a.wall += m._turn ? m._turn.end - m._turn.start : Math.max(0, new Date(m.updatedAt) - new Date(m.createdAt));
  if (md.sessionReused === false) a.cold += 1;
  if (md.sessionReuseReason === 'goal_revision_mismatch') a.revCold += 1;
  if (m.status === 'failed') a.failed += 1;
  if (m._turn) {
    a.goalCalls += m._turn.goalCalls;
    if (m._turn.firstEdit !== null) (md.sessionReused ? a.firstEditWarm : a.firstEditCold).push(m._turn.firstEdit);
    if (!md.sessionReused) a.promptCold.push(m._turn.promptChars);
  }
}
const avg = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0);
console.log('\nagent     turns wallH cold(revMismatch) failed updateGoalCalls avgFirstEdit cold/warm(min) avgColdPromptChars');
for (const [name, a] of Object.entries(agents)) {
  console.log(`${name.padEnd(9)} ${String(a.turns).padStart(5)} ${hours(a.wall).padStart(5)} ${a.cold}(${a.revCold}) ${a.failed} ${a.goalCalls} ${mins(avg(a.firstEditCold))}/${mins(avg(a.firstEditWarm))} ${Math.round(avg(a.promptCold))}`);
}

fs.writeFileSync(path.join(path.dirname(messagesFile), 'turns.json'), JSON.stringify(assistants.map((m) => ({
  id: m.id, agent: m.senderName, createdAt: m.createdAt, status: m.status, cls: classify(m),
  reused: (m.metadata || {}).sessionReused, reason: (m.metadata || {}).sessionReuseReason, rev: (m.metadata || {}).goalRevision,
  triggeredBy: (m.metadata || {}).triggeredByAgentName, contentChars: String(m.content || '').length,
  turn: m._turn ? { wall: m._turn.end - m._turn.start, model: m._turn.model, tool: m._turn.tool, calls: m._turn.calls, edits: m._turn.edits, reads: m._turn.reads, firstEdit: m._turn.firstEdit, goalCalls: m._turn.goalCalls, goalOk: m._turn.goalOk, goal409: m._turn.goal409, testMs: m._turn.testMs, testRuns: m._turn.testRuns, dockerMs: m._turn.dockerMs, longRuns: m._turn.longRuns, promptChars: m._turn.promptChars, maxCtx: m._turn.maxCtx, output: m._turn.output } : null,
}))));
