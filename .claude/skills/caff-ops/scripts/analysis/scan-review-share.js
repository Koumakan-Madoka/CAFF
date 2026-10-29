// Cross-room scan: how much agent time goes to independent review in each Goal room. Read-only.
// usage: node scan-review-share.js [minMessages]
const BASE = process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100';
const minMessages = Number(process.argv[2] || 40);

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path} ${await res.text()}`);
  return res.json();
}

async function listRooms() {
  const rooms = [];
  let before = '';
  for (let page = 0; page < 20; page += 1) {
    const body = await get(`/api/conversations?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    rooms.push(...(body.conversations || []));
    if (!body.hasMore || !body.nextCursor) break;
    before = body.nextCursor;
  }
  return rooms;
}

async function listMessages(roomId) {
  const all = [];
  let before = '';
  for (let page = 0; page < 50; page += 1) {
    const body = await get(`/api/conversations/${encodeURIComponent(roomId)}/messages?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    all.unshift(...(body.items || []));
    if (!body.hasMore || !body.nextCursor) break;
    before = body.nextCursor;
  }
  return all;
}

const REVIEW_RE = /独立审查|独立复审|独立复核|复审|复核|审查结论|审查报告|审查对象|\bPASS\b|\bFAIL\b|code review|Review verdict|Verdict/i;
const GOVERNANCE_RE = /提案|裁决|治理|proposal/i;
const FAIL_RE = /结论[^\n]{0,12}(FAIL|不通过)|\*\*FAIL\b|^\s*#*[^\n]{0,60}\bFAIL\b/;
const COMMIT_RE = /(已提交|提交了|新提交|committed|Committed|commit)\s*[：:]?\s*`?[0-9a-f]{7,40}\b/;

async function main() {
  const rooms = (await listRooms()).filter((room) => {
    const goal = (room.metadata || {}).sessionGoal;
    return goal && typeof goal.revision === 'number';
  });
  const rows = [];
  for (const room of rooms) {
    const messages = await listMessages(room.id);
    if (messages.length < minMessages) continue;
    const goal = room.metadata.sessionGoal;
    const ownerId = goal.owner ? goal.owner.agentId : null;
    let agentMs = 0;
    let reviewMs = 0;
    let reviews = 0;
    let fails = 0;
    let commits = 0;
    let turns = 0;
    for (const m of messages) {
      if (m.role !== 'assistant' || m.status === 'streaming') continue;
      const ms = Math.min(3 * 3600000, Math.max(0, new Date(m.updatedAt) - new Date(m.createdAt)));
      const text = String(m.content || '');
      const head = text.slice(0, 300);
      turns += 1;
      agentMs += ms;
      if (m.agentId !== ownerId && REVIEW_RE.test(head) && !GOVERNANCE_RE.test(text.slice(0, 120))) {
        reviews += 1;
        reviewMs += ms;
        if (FAIL_RE.test(text.slice(0, 400))) fails += 1;
      }
      if (m.agentId === ownerId && COMMIT_RE.test(text.slice(0, 600))) commits += 1;
    }
    const criteria = goal.acceptanceCriteria || [];
    rows.push({
      id: room.id.slice(0, 8), title: String(room.title || '').slice(0, 16), status: goal.status, rev: goal.revision,
      msgs: messages.length, turns, agentH: agentMs / 3600000, reviews, reviewShare: agentMs ? reviewMs / agentMs : 0, fails, commits,
      passed: `${criteria.filter((c) => c.status === 'passed' || c.status === 'waived').length}/${criteria.length}`,
      last: messages.length ? messages[messages.length - 1].createdAt.slice(5, 10) : '-',
    });
  }
  rows.sort((a, b) => b.agentH - a.agentH);
  console.log('room     title             status   rev  msgs turns agentH reviews reviewShare FAIL ownerCommits reviews/commit criteria last');
  for (const r of rows) {
    console.log(`${r.id} ${r.title.padEnd(16)} ${r.status.padEnd(8)} ${String(r.rev).padStart(4)} ${String(r.msgs).padStart(4)} ${String(r.turns).padStart(5)} ${r.agentH.toFixed(1).padStart(6)} ${String(r.reviews).padStart(7)} ${`${Math.round(100 * r.reviewShare)}%`.padStart(11)} ${String(r.fails).padStart(4)} ${String(r.commits).padStart(12)} ${(r.commits ? (r.reviews / r.commits).toFixed(2) : '-').padStart(14)} ${r.passed.padStart(8)} ${r.last}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
