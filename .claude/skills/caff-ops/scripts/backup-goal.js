// Back up a room's Goal metadata before a revise/replace (read-only GET).
// Usage: node backup-goal.js <conversation UUID>
// Writes ~/.caff-ops/goal-backups/<first 8>-goal-rev<N>.json and refuses to overwrite.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE = process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100';
const [id] = process.argv.slice(2);
if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
  console.error('usage: node backup-goal.js <conversation UUID>');
  process.exit(1);
}

(async () => {
  const res = await fetch(`${BASE}/api/conversations/${id}`);
  if (!res.ok) throw new Error(`GET /api/conversations/${id} failed: HTTP ${res.status}`);
  const body = await res.json();
  const c = body.conversation || body;
  const m = c.metadata || {};
  const goal = m.sessionGoal;
  if (!goal) throw new Error('room has no Goal');
  const out = {
    backedUpAt: new Date().toISOString(),
    conversationId: c.id,
    title: c.title,
    // The workspace binding lives on the conversation row, not in metadata.
    branch: c.branch ?? null,
    worktreePath: c.worktreePath ?? null,
    workspaceBaseSha: c.workspaceBaseSha ?? null,
    sessionGoal: goal,
    sessionGoalProposal: m.sessionGoalProposal ?? null,
    sessionGoalRuling: m.sessionGoalRuling ?? null,
    sessionGoalRunner: m.sessionGoalRunner ?? null,
  };
  const dir = path.join(process.env.CAFF_OPS_STATE_DIR || path.join(os.homedir(), '.caff-ops'), 'goal-backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id.slice(0, 8)}-goal-rev${goal.revision}.json`);
  if (fs.existsSync(file)) throw new Error(`backup already exists: ${file}`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`${file} | rev ${goal.revision} | proposal ${out.sessionGoalProposal ? out.sessionGoalProposal.id : 'none'}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
