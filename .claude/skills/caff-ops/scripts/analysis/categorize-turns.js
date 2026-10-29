// Classify each agent turn by what it was doing and aggregate time per category.
// usage: node categorize-turns.js <dir-with-messages.json-and-turns.json>
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
const turns = JSON.parse(fs.readFileSync(path.join(dir, 'turns.json'), 'utf8'));
const content = Object.fromEntries(messages.map((m) => [m.id, String(m.content || '')]));
const hours = (ms) => (ms / 3600000).toFixed(1);
const REVIEWERS = new Set(['DeepSeek', 'GLM', 'Kimi']);

function category(t) {
  const text = content[t.id] || '';
  const wall = t.turn ? t.turn.wall : 0;
  const edits = t.turn ? t.turn.edits : 0;
  if (t.status === 'failed') return 'failed';
  if (/提案|裁决|治理/.test(text.slice(0, 200)) && wall < 5 * 60000 && edits === 0) return 'governance (proposal/ruling)';
  if (REVIEWERS.has(t.agent) && /PASS|FAIL|审查|复审|复核|核验/.test(text.slice(0, 300)) && edits <= 1) return 'independent review';
  if (t.agent === 'GPT' && edits > 0) return 'GPT implementation (edits repo)';
  if (t.agent === 'Kimi' && edits > 0) return 'Kimi implementation (edits repo)';
  if (wall < 3 * 60000) return 'short reply / status / bookkeeping (<3m, no edits)';
  return 'other no-edit work (runs, diagnosis, planning)';
}

const cats = {};
const verdicts = {};
for (const t of turns) {
  const c = category(t);
  const row = (cats[c] = cats[c] || { n: 0, wall: 0, tests: 0 });
  row.n += 1;
  row.wall += t.turn ? t.turn.wall : 0;
  row.tests += t.turn ? t.turn.testMs : 0;
  if (c === 'independent review') {
    const text = content[t.id] || '';
    const head = text.slice(0, 400);
    const v = /FAIL/.test(head) ? 'FAIL' : /PASS|通过|一致|接受/.test(head) ? 'PASS' : 'other';
    const key = `${t.agent}:${v}`;
    verdicts[key] = (verdicts[key] || 0) + 1;
  }
}
const total = Object.values(cats).reduce((s, r) => s + r.wall, 0);
console.log('category                                             turns  wallH  share  testH');
for (const [c, r] of Object.entries(cats).sort((a, b) => b[1].wall - a[1].wall)) {
  console.log(`${c.padEnd(52)} ${String(r.n).padStart(5)} ${hours(r.wall).padStart(6)} ${String(Math.round((100 * r.wall) / total)).padStart(5)}% ${hours(r.tests).padStart(6)}`);
}
console.log('review verdicts', verdicts);

// review latency: for each GPT turn that @-mentions a reviewer, time until the reviewer's turn completed
const commits = turns.filter((t) => t.agent === 'GPT' && /已提交\s*`[0-9a-f]{7,}/.test(content[t.id] || '')).length;
const reviewRequests = turns.filter((t) => t.agent === 'GPT' && /@(DeepSeek|GLM|Kimi)\s*请/.test(content[t.id] || '')).length;
console.log(`GPT turns reporting a commit: ${commits} | GPT turns requesting a review: ${reviewRequests}`);

// distribution of GPT turn sizes for implementation turns
const impl = turns.filter((t) => t.agent === 'GPT' && t.turn && t.turn.edits > 0);
const testShare = impl.reduce((s, t) => s + t.turn.testMs, 0) / impl.reduce((s, t) => s + t.turn.wall, 0);
console.log(`GPT implementation turns: ${impl.length}, avg wall ${(impl.reduce((s, t) => s + t.turn.wall, 0) / impl.length / 60000).toFixed(1)}m, test share ${Math.round(100 * testShare)}%`);
const rev = turns.filter((t) => category(t) === 'independent review' && t.turn);
const revTestShare = rev.reduce((s, t) => s + t.turn.testMs, 0) / rev.reduce((s, t) => s + t.turn.wall, 0);
console.log(`review turns: ${rev.length}, avg wall ${(rev.reduce((s, t) => s + t.turn.wall, 0) / rev.length / 60000).toFixed(1)}m, test share ${Math.round(100 * revTestShare)}%`);

// prompt size of cold starts over time
const byDay = {};
for (const t of turns) {
  if (!t.turn || t.reused) continue;
  const d = new Date(t.createdAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 10);
  (byDay[d] = byDay[d] || []).push(t.turn.promptChars);
}
console.log('avg cold-start prompt chars by day:', Object.entries(byDay).map(([d, l]) => `${d}:${Math.round(l.reduce((s, v) => s + v, 0) / l.length / 1000)}k`).join(' '));
