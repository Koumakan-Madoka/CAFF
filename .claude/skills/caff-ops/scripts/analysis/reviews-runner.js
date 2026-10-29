// Review verdict detail and Goal Runner iteration sequences.
// usage: node reviews-runner.js <dir-with-messages.json-and-turns.json>
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
const turns = JSON.parse(fs.readFileSync(path.join(dir, 'turns.json'), 'utf8'));
const turnById = Object.fromEntries(turns.map((t) => [t.id, t]));
const fmt = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16);
const REVIEWERS = new Set(['DeepSeek', 'GLM', 'Kimi']);

function verdict(text) {
  const head = text.slice(0, 600);
  const m = head.match(/(?:结论|Verdict|verdict|复审结论|复核结论|审查结论)[^A-Za-z]{0,12}(PASS|FAIL)/);
  if (m) return m[1];
  const bold = head.match(/\*\*(PASS|FAIL)\b/);
  if (bold) return bold[1];
  if (/^\s*#?[^\n]{0,80}\bFAIL\b/.test(head)) return 'FAIL';
  if (/^\s*#?[^\n]{0,80}\bPASS\b/.test(head)) return 'PASS';
  if (/证据一致|无阻断/.test(head)) return 'PASS';
  return '?';
}

const rows = [];
for (const m of messages) {
  if (m.role !== 'assistant' || !REVIEWERS.has(m.senderName) || m.status !== 'completed') continue;
  const text = String(m.content || '');
  if (!/审查|复审|复核|核验|review|Review|PASS|FAIL/.test(text.slice(0, 300))) continue;
  if (/提案|裁决|治理/.test(text.slice(0, 120))) continue;
  const v = verdict(text);
  const size = text.match(/(\d+)\s*文件[^+]{0,6}\+(\d+)\s*\/\s*[−-](\d+)/);
  const severities = (text.slice(0, 800).match(/P[0-3]\s*[×x]\s*\d+|\d+\s*[×x]\s*P[0-3]/g) || []).join(',');
  const t = turnById[m.id] || {};
  rows.push({ at: fmt(m.createdAt), agent: m.senderName, v, files: size ? Number(size[1]) : null, add: size ? Number(size[2]) : null, wall: t.turn ? t.turn.wall : 0, severities, head: text.replace(/\s+/g, ' ').slice(0, 90) });
}
const tally = {};
for (const r of rows) tally[`${r.agent}:${r.v}`] = (tally[`${r.agent}:${r.v}`] || 0) + 1;
console.log('review turns', rows.length, tally);
console.log('FAIL / unknown verdicts:');
for (const r of rows.filter((x) => x.v !== 'PASS')) console.log(`  ${r.at} ${r.agent} ${r.v} files ${r.files ?? '-'} +${r.add ?? '-'} ${r.severities} | ${r.head}`);
const sized = rows.filter((r) => r.add !== null);
const big = sized.filter((r) => r.add >= 500);
const small = sized.filter((r) => r.add < 500);
const failRate = (list) => `${list.filter((r) => r.v === 'FAIL').length}/${list.length}`;
console.log(`reviews with size info: ${sized.length} | >=500 added lines FAIL ${failRate(big)} | <500 FAIL ${failRate(small)}`);
console.log(`median review size (added lines): ${sized.map((r) => r.add).sort((a, b) => a - b)[Math.floor(sized.length / 2)] ?? '-'}`);

// Goal Runner sequences
let seq = [];
const sequences = [];
for (const m of messages) {
  if (m.senderName !== 'Goal Runner') continue;
  const mm = String(m.content || '').match(/continuation \((\d+)\/(\d+)\)/);
  if (!mm) continue;
  const n = Number(mm[1]);
  if (n === 1 && seq.length) { sequences.push(seq); seq = []; }
  seq.push({ n, at: m.createdAt });
}
if (seq.length) sequences.push(seq);
console.log(`\nrunner sequences: ${sequences.length}`);
for (const s of sequences) console.log(`  ${fmt(s[0].at)} → ${fmt(s[s.length - 1].at)} reached ${s[s.length - 1].n}/20 (${s.length} continuations)`);
