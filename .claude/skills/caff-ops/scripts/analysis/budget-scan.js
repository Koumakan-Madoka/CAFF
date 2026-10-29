// Scan all session logs: per (day, provider, model, thinkingLevel) count thinking blocks
// and how many talk about a per-turn token budget.
// usage: node budget-scan.js <sessionsDir> [agentFilter] [hitsOutFile]
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const [dir, agentFilter = "", hitsOut = ""] = process.argv.slice(2);
const budgetRe = /(tokens? (left|remaining)|token budget|budget (of|is|around|seems)|initially \d+k|\b\d{2}k tokens\b|\b\d{2},\d{3} tokens\b)/i;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && f.includes(agentFilter));

const agg = new Map();
const firstHits = [];
(async () => {
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f), 'utf8'), crlfDelay: Infinity });
    let provider = '?', model = '?', level = '?';
    for await (const line of rl) {
      if (line.startsWith('{"type":"model_change"')) {
        try { const e = JSON.parse(line); provider = e.provider; model = e.modelId; } catch {}
        continue;
      }
      if (line.startsWith('{"type":"thinking_level_change"')) {
        try { level = JSON.parse(line).thinkingLevel; } catch {}
        continue;
      }
      if (!line.includes('"type":"thinking"')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'message' || !e.message || e.message.role !== 'assistant') continue;
      const day = (e.timestamp || '').slice(0, 10);
      const m = e.message;
      const key = `${day}|${m.provider || provider}|${m.model || model}|${level}`;
      const a = agg.get(key) || { blocks: 0, hits: 0 };
      for (const c of m.content || []) {
        if (c.type !== 'thinking' || !c.thinking) continue;
        a.blocks++;
        const hit = c.thinking.match(budgetRe);
        if (hit) {
          a.hits++;
          if (firstHits.length < 400) firstHits.push(`${e.timestamp} ${m.model || model} | ${c.thinking.slice(Math.max(0, hit.index - 120), hit.index + 140).replace(/\s+/g, ' ')}`);
        }
      }
      agg.set(key, a);
    }
  }
  const rows = [...agg.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1);
  console.log('day        provider        model           level   blocks  budgetTalk  rate');
  for (const [k, a] of rows) {
    const [day, p, mo, lv] = k.split('|');
    console.log(`${day} ${p.padEnd(15).slice(0, 15)} ${mo.padEnd(15).slice(0, 15)} ${lv.padEnd(7)} ${String(a.blocks).padStart(6)} ${String(a.hits).padStart(10)}  ${(100 * a.hits / Math.max(1, a.blocks)).toFixed(1)}%`);
  }
  if (hitsOut) fs.writeFileSync(hitsOut, firstHits.sort().join('\n'));
})();
