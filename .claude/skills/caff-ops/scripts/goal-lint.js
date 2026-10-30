// Lint a draft Goal JSON before sending it. Mirrors the normalization in
// server/domain/conversation/goal-contract.ts and reports anything the server
// would silently change: cut text, dropped items, replaced values, capped lists,
// and generated IDs that collide.
// Usage: node goal-lint.js goal.json  -> prints per-field lengths, exits 1 on problems.
const fs = require('fs');

const file = process.argv[2];
const goal = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = [];
const norm = (v) => String(v || '').trim().replace(/\s+/gu, ' ');
// Required text: the server drops an item whose main text is empty.
const check = (label, value, max) => {
  const length = norm(value).length;
  if (!length) problems.push(`${label}: empty`);
  if (length > max) problems.push(`${label}: ${length} > ${max}`);
  return length;
};
// Optional text: only a cut value is a problem.
const checkOptional = (label, value, max) => {
  const length = norm(value).length;
  if (length > max) problems.push(`${label}: ${length} > ${max}`);
};
// The server keeps the first `max` items of a list and drops the rest.
const capped = (label, value, max) => {
  const items = Array.isArray(value) ? value : [];
  if (items.length > max) problems.push(`${label}: ${items.length} items > ${max}; the server drops the rest`);
  return items.slice(0, max);
};
// A plain string item stands for the item's main field, if the list accepts strings.
const record = (item, stringField) => {
  if (typeof item === 'string' && stringField) return { [stringField]: item };
  return item && typeof item === 'object' && !Array.isArray(item) ? item : {};
};
// A missing ID becomes `<prefix>-<position>`; an ID is cut to 80 characters.
const idOf = (kind, source, prefix, index, seen) => {
  const raw = norm(source.id);
  if (raw.length > 80) problems.push(`${kind} ${raw.slice(0, 40)}...: id ${raw.length} > 80`);
  const id = raw.slice(0, 80) || `${prefix}-${index + 1}`;
  if (seen.has(id)) problems.push(`duplicate ${kind} ${id}`);
  seen.add(id);
  return id;
};
// An unknown value is stored as the fallback; an empty one is the fallback anyway.
const known = (label, value, allowed, fallback) => {
  const normalized = norm(value).toLowerCase();
  if (normalized && !allowed.includes(normalized)) {
    problems.push(`${label} "${value}" is stored as "${fallback}" (allowed: ${allowed.join(', ')})`);
  }
};

console.log('objective', check('objective', goal.objective, 2000));

for (const field of ['committed', 'provisional', 'openQuestions', 'nonGoals', 'rejectedOptions']) {
  const seen = new Set();
  capped(`decisions.${field}`, (goal.decisions || {})[field], 40).forEach((item, index) => {
    const source = record(item, 'statement');
    const id = idOf(field, source, field, index, seen);
    const primary = field === 'openQuestions' ? source.question || source.statement
      : field === 'rejectedOptions' ? source.option || source.statement : source.statement;
    console.log(field, id, check(`${field}.${id}`, primary, 500));
    for (const extra of ['rationale', 'reason', 'changeConditions', 'boundaries']) checkOptional(`${field}.${id}.${extra}`, source[extra], 1000);
    checkOptional(`${field}.${id}.adrPath`, source.adrPath, 240);
  });
}

const criterionIds = new Set();
const criteria = capped('acceptanceCriteria', goal.acceptanceCriteria, 40);
criteria.forEach((item, index) => {
  const source = record(item, 'statement');
  const id = idOf('criterion', source, 'criterion', index, criterionIds);
  known(`AC ${id}.risk`, source.risk, ['normal', 'high'], 'normal');
  known(`AC ${id}.status`, source.status, ['pending', 'passed', 'failed', 'waived'], 'pending');
  capped(`AC ${id}.evidenceRefs`, source.evidenceRefs, 40).forEach((ref) => checkOptional(`AC ${id}.evidenceRef`, ref, 80));
  checkOptional(`AC ${id}.waiver.reason`, record(source.waiver).reason || source.waiverReason, 1000);
  console.log('criterion', id, check(`AC ${id}`, source.statement || source.text, 500), check(`AC ${id}.verifyBy`, source.verifyBy || source.verify_by, 1000));
});

const workIds = new Set();
capped('workItems', goal.workItems, 60).forEach((item, index) => {
  const source = record(item, 'text');
  const id = idOf('work item', source, 'work', index, workIds);
  // The server lowercases the status and turns "-" into "_"; a missing or unknown
  // status is todo and "doing" means in_progress. A Goal draft starts with every item todo.
  const status = norm(source.status).toLowerCase().replace(/-/gu, '_');
  if (status && !['todo', 'in_progress', 'done', 'doing'].includes(status)) {
    problems.push(`work item ${id}.status "${source.status}" is stored as "todo" (allowed: todo, in_progress, done)`);
  } else if (status && status !== 'todo') {
    problems.push(`work item ${id} status ${status === 'doing' ? 'in_progress' : status}`);
  }
  console.log('work', id, check(`work ${id}`, source.text || source.statement || source.title, 300));
});

const EVIDENCE_KINDS = ['command', 'test', 'manual', 'review', 'artifact'];
const evidenceIds = new Set();
capped('evidence', goal.evidence, 100).forEach((item, index) => {
  const source = record(item);
  const id = idOf('evidence', source, 'evidence', index, evidenceIds);
  console.log('evidence', id, check(`evidence ${id}.summary`, source.summary, 1000));
  checkOptional(`evidence ${id}.reference`, source.reference, 1000);
  checkOptional(`evidence ${id}.recordedBy`, source.recordedBy, 160);
  known(`evidence ${id}.kind`, source.kind, EVIDENCE_KINDS, 'artifact');
  capped(`evidence ${id}.criterionIds`, source.criterionIds || source.criterion_ids, 40).forEach((ref) => checkOptional(`evidence ${id}.criterionId`, ref, 80));
});

if (!criteria.length) problems.push('no acceptance criteria');
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'OK');
process.exitCode = problems.length ? 1 : 0;
