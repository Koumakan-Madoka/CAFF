// Compare a room's pending Goal proposal (or the accepted Goal) with the draft JSON, field by field.
// Usage: node compare-goal.js draft.json <conversationUUID> proposal|goal  -> exits 1 on any mismatch.
// Run it on the pending proposal before the user accepts, and on the Goal right after acceptance.
const fs = require('fs');

const BASE = (process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const [draftFile, conversationId, which = 'proposal'] = process.argv.slice(2);
const norm = (v) => String(v || '').trim().replace(/\s+/gu, ' ');

async function main() {
  const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  const response = await fetch(`${BASE}/api/conversations/${encodeURIComponent(conversationId)}`);
  if (!response.ok) throw new Error(`GET conversation ${response.status}`);
  const meta = (await response.json()).conversation.metadata || {};
  const stored = which === 'goal' ? meta.sessionGoal : meta.sessionGoalProposal;
  if (!stored) {
    console.log(`no ${which}`);
    process.exitCode = 2;
    return;
  }
  if (which === 'proposal' && !['set', 'revise'].includes(stored.action)) {
    // The agent has not replaced the pending proposal yet; comparing would report every field.
    console.log(`pending proposal ${stored.id} is "${stored.action}", not a set/revise proposal yet`);
    process.exitCode = 2;
    return;
  }
  const problems = [];
  const eq = (label, a, b) => {
    if (norm(a) !== norm(b)) problems.push(`${label}\n  draft : ${norm(a)}\n  stored: ${norm(b)}`);
  };
  console.log(which, stored.id || stored.goalId, 'status', stored.status, 'action', stored.action || '-',
    'revision', stored.revision ?? '-', 'owner/proposer', JSON.stringify(stored.owner || stored.proposedBy || null));
  eq('objective', draft.objective, stored.objective);
  for (const field of ['committed', 'provisional', 'openQuestions', 'nonGoals', 'rejectedOptions']) {
    const a = (draft.decisions || {})[field] || [];
    const b = (stored.decisions || {})[field] || [];
    if (a.length !== b.length) problems.push(`${field}: count ${a.length} vs ${b.length}`);
    a.forEach((item, i) => {
      const s = b[i] || {};
      eq(`${field}[${i}].id`, item.id, s.id);
      for (const k of ['statement', 'question', 'option', 'rationale', 'reason', 'changeConditions', 'boundaries']) {
        if (item[k] !== undefined || s[k] !== undefined) eq(`${field}.${item.id}.${k}`, item[k], s[k]);
      }
    });
  }
  const criteria = stored.acceptanceCriteria || [];
  if (criteria.length !== (draft.acceptanceCriteria || []).length) {
    problems.push(`criteria count ${(draft.acceptanceCriteria || []).length} vs ${criteria.length}`);
  }
  (draft.acceptanceCriteria || []).forEach((c, i) => {
    const s = criteria[i] || {};
    eq(`AC[${i}].id`, c.id, s.id);
    eq(`AC ${c.id}.statement`, c.statement, s.statement);
    eq(`AC ${c.id}.verifyBy`, c.verifyBy, s.verifyBy);
    eq(`AC ${c.id}.risk`, c.risk || 'normal', s.risk);
  });
  const work = stored.workItems || [];
  if (work.length !== (draft.workItems || []).length) {
    problems.push(`work item count ${(draft.workItems || []).length} vs ${work.length}`);
  }
  (draft.workItems || []).forEach((w, i) => {
    const s = work[i] || {};
    eq(`work[${i}].id`, w.id, s.id);
    eq(`work ${w.id}.text`, w.text, s.text);
  });
  console.log(problems.length ? `MISMATCHES (${problems.length}):\n${problems.join('\n')}` : 'ALL FIELDS MATCH');
  process.exitCode = problems.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
