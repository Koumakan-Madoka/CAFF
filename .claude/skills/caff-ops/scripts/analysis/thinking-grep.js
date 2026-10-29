// Grep GPT thinking blocks for self-imposed round/turn budget talk.
// usage: node thinking-grep.js <sessionsDir> <convIdPrefix> <agentId> <fromISO>
const fs = require('fs');
const path = require('path');
const [dir, conv, agent, fromISO] = process.argv.slice(2);
const from = Date.parse(fromISO);
const re = /[^.\n]*(budget|tokens? left|token limit|time spent|minutes? (so far|left|remaining)|wrap(ping)? up|this (turn|round)|next (turn|round)|stop here|keep (it|this) (small|narrow|focused)|limit(ed)? scope|one (small )?step|too (big|large|long))[^.\n]*/gi;
const files = fs.readdirSync(dir)
  .filter(f => f.startsWith(`chat-${conv}`) && f.includes(agent) && f.endsWith('.jsonl'))
  .map(f => path.join(dir, f)).filter(f => fs.statSync(f).mtimeMs >= from);
const counts = {};
let blocks = 0, hits = 0;
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"thinking"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'message' || Date.parse(e.timestamp) < from) continue;
    for (const c of (e.message.content || [])) {
      if (c.type !== 'thinking') continue;
      blocks++;
      let m; const seen = new Set();
      while ((m = re.exec(c.thinking))) {
        const k = m[1].toLowerCase(); counts[k] = (counts[k] || 0) + 1; hits++;
        const s = m[0].trim().slice(0, 220);
        if (!seen.has(s) && hits <= 400) { seen.add(s); console.log(new Date(Date.parse(e.timestamp) + 8 * 3600e3).toISOString().slice(11, 16), '|', s); }
      }
    }
  }
}
console.log('\nthinking blocks', blocks, '| hits', hits, JSON.stringify(counts));
