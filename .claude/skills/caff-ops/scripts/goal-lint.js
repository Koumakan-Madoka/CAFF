// Lint a draft Goal JSON against CAFF set-time limits before sending it (session-goal.ts / goal-contract.ts).
// Usage: node goal-lint.js goal.json  -> prints per-field lengths, exits 1 on problems.
const fs = require('fs');

const file = process.argv[2];
const goal = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = [];
const norm = (v) => String(v || '').trim().replace(/\s+/gu, ' ');
const check = (label, value, max) => {
  const length = norm(value).length;
  if (!length) problems.push(`${label}: empty`);
  if (length > max) problems.push(`${label}: ${length} > ${max}`);
  return length;
};

console.log('objective', check('objective', goal.objective, 2000));
for (const field of ['committed', 'provisional', 'openQuestions', 'nonGoals', 'rejectedOptions']) {
  for (const item of (goal.decisions || {})[field] || []) {
    const primary = field === 'openQuestions' ? item.question : field === 'rejectedOptions' ? item.option : item.statement;
    console.log(field, item.id, check(`${field}.${item.id}`, primary, 500));
    for (const extra of ['rationale', 'reason', 'changeConditions', 'boundaries']) {
      if (item[extra] !== undefined) check(`${field}.${item.id}.${extra}`, item[extra], 1000);
    }
  }
}
const ids = new Set();
for (const criterion of goal.acceptanceCriteria || []) {
  if (ids.has(criterion.id)) problems.push(`duplicate criterion ${criterion.id}`);
  ids.add(criterion.id);
  // goal-contract.ts only knows 'normal' and 'high'; anything else is silently stored as 'normal'.
  if (criterion.risk !== undefined && !['normal', 'high'].includes(criterion.risk)) problems.push(`AC ${criterion.id}.risk "${criterion.risk}" is stored as "normal" (allowed: normal, high)`);
  console.log('criterion', criterion.id, check(`AC ${criterion.id}`, criterion.statement, 500), check(`AC ${criterion.id}.verifyBy`, criterion.verifyBy, 1000));
}
const workIds = new Set();
for (const item of goal.workItems || []) {
  if (workIds.has(item.id)) problems.push(`duplicate work item ${item.id}`);
  workIds.add(item.id);
  if (item.status !== 'todo') problems.push(`work item ${item.id} status ${item.status}`);
  console.log('work', item.id, check(`work ${item.id}`, item.text, 300));
}
// goal-contract.ts normalizeGoalEvidence cuts summary and reference to 1000
// characters, drops a record without a summary and stores an unknown kind as "artifact".
const EVIDENCE_KINDS = ['command', 'test', 'manual', 'review', 'artifact'];
const evidenceIds = new Set();
for (const item of goal.evidence || []) {
  if (evidenceIds.has(item.id)) problems.push(`duplicate evidence ${item.id}`);
  evidenceIds.add(item.id);
  console.log('evidence', item.id, check(`evidence ${item.id}.summary`, item.summary, 1000));
  const reference = norm(item.reference).length;
  if (reference > 1000) problems.push(`evidence ${item.id}.reference: ${reference} > 1000`);
  if (item.kind !== undefined && !EVIDENCE_KINDS.includes(norm(item.kind).toLowerCase())) {
    problems.push(`evidence ${item.id}.kind "${item.kind}" is stored as "artifact" (allowed: ${EVIDENCE_KINDS.join(', ')})`);
  }
}
if (!(goal.acceptanceCriteria || []).length) problems.push('no acceptance criteria');
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'OK');
process.exitCode = problems.length ? 1 : 0;
