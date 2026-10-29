// Token usage per agent and per day from message metadata.
// usage: node tokens.js <messages.json>
const fs = require('fs');

const messages = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const day = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 10);
const M = (n) => `${(n / 1e6).toFixed(1)}M`;
const agents = {};
const days = {};
for (const m of messages) {
  if (m.role !== 'assistant') continue;
  const u = (m.metadata || {}).tokenUsage;
  if (!u) continue;
  const a = (agents[m.senderName] = agents[m.senderName] || { n: 0, input: 0, uncached: 0, cacheRead: 0, output: 0 });
  const d = (days[day(m.createdAt)] = days[day(m.createdAt)] || { n: 0, input: 0, uncached: 0, cacheRead: 0, output: 0 });
  for (const row of [a, d]) {
    row.n += 1;
    row.input += u.inputTokens || 0;
    row.uncached += u.uncachedInputTokens || 0;
    row.cacheRead += u.cacheReadTokens || 0;
    row.output += u.outputTokens || 0;
  }
}
console.log('agent     turns  input(total)  uncached  cacheRead  output');
for (const [k, r] of Object.entries(agents)) console.log(`${k.padEnd(9)} ${String(r.n).padStart(5)}  ${M(r.input).padStart(10)}  ${M(r.uncached).padStart(8)}  ${M(r.cacheRead).padStart(9)}  ${M(r.output).padStart(6)}`);
console.log('day    turns  input(total)  uncached  output');
for (const [k, r] of Object.entries(days).sort()) console.log(`${k}  ${String(r.n).padStart(5)}  ${M(r.input).padStart(10)}  ${M(r.uncached).padStart(8)}  ${M(r.output).padStart(6)}`);
