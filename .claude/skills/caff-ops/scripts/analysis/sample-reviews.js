// Print review-like messages of one room with timestamps, to inspect review cadence. Read-only.
// usage: node sample-reviews.js <conversationId> [limit]
const BASE = process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100';
const [roomId, limitArg] = process.argv.slice(2);
const limit = Number(limitArg || 25);

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function main() {
  const { conversation } = await get(`/api/conversations/${encodeURIComponent(roomId)}`);
  const ownerId = ((conversation.metadata || {}).sessionGoal || {}).owner?.agentId;
  const all = [];
  let before = '';
  for (let page = 0; page < 50; page += 1) {
    const body = await get(`/api/conversations/${encodeURIComponent(roomId)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    all.unshift(...(body.items || []));
    if (!body.hasMore || !body.nextCursor) break;
    before = body.nextCursor;
  }
  const fmt = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16);
  const REVIEW_RE = /独立审查|独立复审|独立复核|复审|复核|审查结论|审查报告|审查对象|\bPASS\b|\bFAIL\b|code review|Verdict/i;
  const picked = all.filter((m) => m.role === 'assistant' && m.agentId !== ownerId && REVIEW_RE.test(String(m.content || '').slice(0, 300)) && !/提案|裁决|治理|proposal/i.test(String(m.content || '').slice(0, 120)));
  console.log(`owner ${ownerId} | review-like messages ${picked.length}; showing last ${limit}`);
  for (const m of picked.slice(-limit)) {
    const mins = ((new Date(m.updatedAt) - new Date(m.createdAt)) / 60000).toFixed(1);
    console.log(`[${fmt(m.createdAt)}] ${m.senderName} ${mins}m | ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 150)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
