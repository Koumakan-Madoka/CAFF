// Compact per-turn listing joined with message content snippets.
// usage: node list-turns.js <dir-with-messages.json-and-turns.json> <fromISO> <toISO> [snippetChars]
const fs = require('fs');
const path = require('path');

const [dir, from, to, snippetArg] = process.argv.slice(2);
const snippet = Number(snippetArg || 140);
const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
const turns = JSON.parse(fs.readFileSync(path.join(dir, 'turns.json'), 'utf8'));
const byId = Object.fromEntries(turns.map((t) => [t.id, t]));
const fmt = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16);
const mins = (ms) => (ms / 60000).toFixed(1);
for (const m of messages) {
  if (m.createdAt < from || m.createdAt > to) continue;
  const text = String(m.content || '').replace(/\s+/g, ' ').trim();
  if (m.role !== 'assistant') {
    console.log(`[${fmt(m.createdAt)}] >> ${m.senderName}: ${text.slice(0, m.senderName === 'Goal Runner' ? 50 : snippet)}`);
    continue;
  }
  const t = byId[m.id] || {};
  const tt = t.turn || {};
  const long = (tt.longRuns || []).map((r) => mins(r.ms)).join('+');
  console.log(`[${fmt(m.createdAt)}] ${m.senderName.padEnd(8)} ${t.cls.padEnd(11)} ${String(t.reused ? 'warm' : t.reason).padEnd(22)} rev${t.rev} wall ${mins(tt.wall || 0).padStart(5)}m edits ${String(tt.edits ?? '-').padStart(2)} goal ${tt.goalCalls ?? '-'}${tt.goal409 ? `(409x${tt.goal409})` : ''} tests ${mins(tt.testMs || 0)}m${long ? ` long[${long}]` : ''} ${m.status === 'failed' ? 'FAILED ' : ''}| ${text.slice(0, snippet)}`);
}
