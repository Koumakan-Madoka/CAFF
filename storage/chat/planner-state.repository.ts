import { createHttpError } from '../../server/http/http-errors';
import { getSessionGoal, getSessionGoalProposal, getSessionGoalRuling, getSessionGoalRunner } from '../../server/domain/conversation/session-goal';
import { getSessionGoalPlannerBinding } from '../../server/domain/conversation/planner-goal-binding';
import { readPlannerTerminalHeader } from '../run/planner-terminal-projection';

// Build bounded inputs for the existing normalizers. SQL discards delivery text,
// evidence, snapshots and arbitrary metadata BEFORE anything crosses into JS.
const DOC = "CASE WHEN json_valid(c.metadata_json) THEN c.metadata_json ELSE '{}' END";
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
// ECMAScript String.trim whitespace, not SQLite's space-only default.
const trimSql = (value: string) => `trim(${value}, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))`;
function scalar(path: string, limit = 513, doc = DOC) {
  const at = quote(path);
  return `CASE WHEN json_type(${doc}, ${at}) IN ('text','integer','real','true','false')
    THEN substr(CASE json_type(${doc}, ${at}) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
      ELSE ${trimSql(`CAST(json_extract(${doc}, ${at}) AS TEXT)`)} END, 1, ${limit}) ELSE NULL END`;
}
const jsonObject = (fields: Record<string, string>) => `json_object(${Object.entries(fields).map(([key, sql]) => `${quote(key)}, ${sql}`).join(', ')})`;
function object(path: string, fields: Record<string, string>) {
  return `CASE WHEN json_type(${DOC}, ${quote(path)}) = 'object' THEN ${jsonObject(fields)} ELSE NULL END`;
}
function fields(path: string, names: string[], limit = 513) {
  return Object.fromEntries(names.map(name => [name, scalar(`${path}.${name}`, limit)]));
}
const entry = "CASE WHEN e.type = 'object' THEN e.value ELSE '{}' END";
function present(names: string[], strings = true) {
  const candidates = names.map(name => `NULLIF(CAST(json_extract(${entry}, ${quote('$.' + name)}) AS TEXT), '')`);
  if (strings) candidates.unshift("CASE WHEN e.type='text' THEN NULLIF(e.value, '') END");
  return `CASE WHEN ${trimSql(`COALESCE(${candidates.join(', ')}, '')`)} <> '' THEN 'present' ELSE '' END`;
}
function markers(path: string, names: string[], limit: number, options: { status?: boolean; risk?: boolean; strings?: boolean } = {}) {
  const marker = present(names, options.strings !== false);
  const item = jsonObject({ statement: marker, text: marker, summary: marker,
    ...(options.status ? { status: scalar('$.status', 40, entry), state: scalar('$.state', 40, entry), checked: scalar('$.checked', 40, entry) } : {}),
    ...(options.risk ? { risk: scalar('$.risk', 40, entry) } : {}) });
  return `CASE WHEN json_type(${DOC}, ${quote(path)}) = 'array' THEN
    (SELECT json_group_array(json(item)) FROM (SELECT ${item} AS item FROM json_each(${DOC}, ${quote(path)}) e
      LIMIT ${limit})) ELSE NULL END`;
}
function legacyChecklist(path: string) {
  // Old persisted checklists can be arrays or markdown text. Split/parse in
  // SQLite and return only presence/status markers, never the checklist body.
  const marker = present(['text', 'title', 'objective', 'content']);
  const line = `ltrim(trim(e.value), '-* ' || char(9) || char(13))`;
  const status = `CASE WHEN e.type='text' AND substr(${line},1,1)='[' AND substr(${line},3,1)=']'
    AND trim(substr(${line},4))<>'' THEN CASE lower(substr(${line},2,1))
      WHEN 'x' THEN 'done' WHEN '~' THEN 'in_progress' WHEN '>' THEN 'in_progress' WHEN '-' THEN 'in_progress' ELSE 'todo' END
    ELSE ${scalar('$.status', 40, entry)} END`;
  const item = jsonObject({ text: marker, status, state: scalar('$.state', 40, entry), checked: scalar('$.checked', 40, entry) });
  return `(WITH RECURSIVE lines(value, rest) AS (
      SELECT '', CASE WHEN json_type(${DOC}, ${quote(path)})='text' THEN json_extract(${DOC}, ${quote(path)}) || char(10) ELSE '' END
      UNION ALL SELECT substr(rest,1,instr(rest,char(10))-1), substr(rest,instr(rest,char(10))+1)
        FROM lines WHERE rest<>'' AND instr(rest,char(10))>0
    ), entries AS (
      SELECT value, type FROM json_each(CASE WHEN json_type(${DOC}, ${quote(path)})='array'
        THEN json_extract(${DOC}, ${quote(path)}) ELSE '[]' END)
      UNION ALL SELECT value, 'text' FROM lines WHERE value<>''
    ) SELECT json_group_array(json(item)) FROM (SELECT ${item} AS item FROM entries e WHERE ${marker}<>'' LIMIT 20))`;
}
function principal(path: string) {
  return object(path, { kind: scalar(path + '.kind', 20), ...fields(path, ['agentId', 'plannerId']),
    ...fields(path, ['agentName', 'plannerName'], 160) });
}
function proposal(path: string) {
  return object(path, { ...fields(path, ['id']), ...fields(path, ['action'], 20), ...fields(path, ['reason'], 500),
    ...fields(path, ['objective'], 1), ...fields(path, ['baseRevision', 'base_revision'], 30),
    ...fields(path, ['createdAt', 'created_at', 'updatedAt', 'updated_at'], 80),
    proposedBy: object(path + '.proposedBy', { agentId: scalar(path + '.proposedBy.agentId'), agentName: scalar(path + '.proposedBy.agentName', 160) }) });
}
const goalPath = '$.sessionGoal';
const runnerPath = '$.sessionGoalRunner';
const bindingPath = '$.sessionGoalPlannerBinding';
const metadataSql = jsonObject({
  sessionGoal: object(goalPath, {
    ...fields(goalPath, ['goalId', 'goal_id']), ...fields(goalPath, ['revision', 'goalRevision', 'goal_revision'], 30),
    objective: scalar(goalPath + '.objective', 2001), status: scalar(goalPath + '.status', 40),
    ...fields(goalPath, ['createdAt', 'created_at', 'updatedAt', 'updated_at', 'completedAt', 'completed_at'], 80),
    owner: object(goalPath + '.owner', { agentId: scalar(goalPath + '.owner.agentId'), agentName: scalar(goalPath + '.owner.agentName', 160) }),
    decisions: jsonObject(Object.fromEntries(['committed', 'provisional', 'openQuestions', 'nonGoals', 'rejectedOptions'].map(group => [group,
      markers(goalPath + '.decisions.' + group, group === 'openQuestions' ? ['question', 'statement'] : group === 'rejectedOptions' ? ['option', 'statement'] : ['statement'], 40)]))),
    acceptanceCriteria: `COALESCE(${markers(goalPath + '.acceptanceCriteria', ['statement', 'text'], 40, { status: true, risk: true })},
      ${markers(goalPath + '.acceptance_criteria', ['statement', 'text'], 40, { status: true, risk: true })})`,
    // Keep the distinction between omitted workItems and an explicit empty list.
    workItems: `CASE WHEN json_type(${DOC}, '${goalPath}.workItems') IS NOT NULL
      THEN COALESCE(${markers(goalPath + '.workItems', ['text', 'statement', 'title'], 60, { status: true })}, json('[]'))
      ELSE NULL END`,
    checklist: legacyChecklist(goalPath + '.checklist'),
    evidence: markers(goalPath + '.evidence', ['summary'], 100, { strings: false }),
  }),
  sessionGoalProposal: proposal('$.sessionGoalProposal'),
  sessionGoalRuling: object('$.sessionGoalRuling', { ...fields('$.sessionGoalRuling', ['id', 'proposalId', 'proposal_id']),
    ...fields('$.sessionGoalRuling', ['action', 'outcome'], 20), reason: scalar('$.sessionGoalRuling.reason', 500),
    ...fields('$.sessionGoalRuling', ['ruledAt', 'ruled_at'], 80),
    ruledBy: `COALESCE(${principal('$.sessionGoalRuling.ruledBy')}, ${principal('$.sessionGoalRuling.ruled_by')})`,
    proposalSnapshot: `COALESCE(${proposal('$.sessionGoalRuling.proposalSnapshot')}, ${proposal('$.sessionGoalRuling.proposal_snapshot')})` }),
  sessionGoalRunner: object(runnerPath, { ...fields(runnerPath, ['status', 'lastFailureMode', 'last_failure_mode', 'lastFailureKind', 'last_failure_kind'], 40),
    ...fields(runnerPath, ['goalUpdatedAt', 'goal_updated_at', 'updatedAt', 'updated_at', 'lastContinuedAt', 'last_continued_at',
      'failureStreakStartedAt', 'failure_streak_started_at', 'lastFailureAt', 'last_failure_at', 'errorPausedAt', 'error_paused_at', 'lastFailureCode', 'last_failure_code'], 80),
    ...fields(runnerPath, ['iteration', 'maxIterations', 'max_iterations', 'consecutiveModelFailureCount', 'consecutive_model_failure_count',
      'consecutiveFailureCount', 'consecutive_failure_count', 'consecutiveSameModeFailureCount', 'consecutive_same_mode_failure_count',
      'failureThreshold', 'failure_threshold', 'totalFailureThreshold', 'total_failure_threshold'], 30),
    ...fields(runnerPath, ['lastFailureSummary', 'last_failure_summary', 'pauseReason', 'pause_reason'], 500) }),
  sessionGoalPlannerBinding: object(bindingPath, { ...fields(bindingPath, ['goalId', 'plannerId']), plannerName: scalar(bindingPath + '.plannerName', 160), boundAt: scalar(bindingPath + '.boundAt', 80),
    adoption: object(bindingPath + '.adoption', { boundBy: principal(bindingPath + '.adoption.boundBy'), reason: scalar(bindingPath + '.adoption.reason', 500) }) }),
});
const projection = `SELECT substr(c.id,1,513) AS id, substr(c.title,1,120) AS title,
  substr(c.project_scope_id,1,513) AS projectScopeId, ${metadataSql} AS monitoring_json FROM chat_conversations c`;

function unavailable(): never {
  throw createHttpError(501, 'Bounded planner projection unavailable', { code: 'planner_projection_unavailable' });
}
function checkIdentities(value: any, key = '') {
  if (typeof value === 'string' && (key === 'id' || /(?:Id|_id)$/.test(key)) && Array.from(value).length > 512) unavailable();
  if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) checkIdentities(item, name);
}
const clip = (value: string, limit: number) => Array.from(value).slice(0, limit).join('');
function summarize(row: any, db: any) {
  if (!row) return null;
  const metadata = JSON.parse(row.monitoring_json);
  checkIdentities({ id: row.id, projectScopeId: row.projectScopeId, metadata });
  const rawGoal = metadata.sessionGoal;
  // NULL workItems means omission here, not a user patch. The normalizer must
  // still see legacy checklist input. All persisted writes use canonical arrays.
  if (rawGoal && rawGoal.workItems === null) delete rawGoal.workItems;
  if (rawGoal && !rawGoal.goalId && !rawGoal.goal_id && Array.from(rawGoal.objective || '').length > 2000) unavailable();
  const conversation = { metadata };
  const goal = getSessionGoal(conversation), proposal = getSessionGoalProposal(conversation), ruling = getSessionGoalRuling(conversation);
  const terminal = readPlannerTerminalHeader(db, row.id);
  if (terminal) checkIdentities({ id: terminal.taskId, turnId: terminal.turnId });
  const binding = getSessionGoalPlannerBinding(conversation);
  if (binding?.adoption) binding.adoption = binding.adoption.boundBy?.kind === 'user'
    ? { boundBy: { kind: 'user' }, reason: binding.adoption.reason || '' } : undefined;
  const state = {
    goal: goal ? {
      goalId: goal.goalId, revision: goal.revision, status: goal.status, objective: clip(goal.objective, 2000),
      owner: goal.owner ? { agentId: goal.owner.agentId, agentName: clip(goal.owner.agentName, 160) } : null,
      createdAt: goal.createdAt, updatedAt: goal.updatedAt, ...(goal.completedAt ? { completedAt: goal.completedAt } : {}),
      plannerBinding: binding,
      decisionCounts: Object.fromEntries(Object.entries(goal.decisions).map(([key, items]: [string, any]) => [key, items.length])),
      acceptanceCounts: Object.fromEntries(['pending', 'passed', 'failed', 'waived', 'highRisk'].map(status => [status,
        goal.acceptanceCriteria.filter((c: any) => status === 'highRisk' ? c.risk === 'high' : c.status === status).length])),
      workItemCounts: Object.fromEntries(['todo', 'in_progress', 'done'].map(status => [status, goal.workItems.filter((w: any) => w.status === status).length])),
      evidenceCount: goal.evidence.length,
    } : null,
    proposal: proposal ? { id: proposal.id || null, action: proposal.action, ...(proposal.baseRevision !== undefined ? { baseRevision: proposal.baseRevision } : {}),
      proposedBy: proposal.proposedBy, reason: clip(proposal.reason || '', 500), createdAt: proposal.createdAt, updatedAt: proposal.updatedAt } : null,
    ruling: ruling ? { id: metadata.sessionGoalRuling.id || null, proposalId: ruling.proposalId, action: ruling.action, outcome: ruling.outcome, ruledBy: ruling.ruledBy,
      reason: clip(ruling.reason || '', 500), ruledAt: ruling.ruledAt } : null,
    runner: getSessionGoalRunner(conversation),
    lastTurn: terminal ? { id: terminal.turnId || terminal.taskId, status: terminal.status, startedAt: terminal.startedAt, finishedAt: terminal.finishedAt,
      summary: terminal.status === 'succeeded' ? 'Turn succeeded' : terminal.status === 'failed' ? 'Turn failed' : 'Turn cancelled' } : null,
  };
  return { conversationId: row.id, title: row.title, projectScopeId: row.projectScopeId || null, state };
}

export function createPlannerStateRepository(db: any) {
  const get = db.prepare(projection + ' WHERE c.id=?');
  const list = db.prepare(projection + ` WHERE json_type(${DOC}, '$.sessionGoal') = 'object'
    OR (json_type(${DOC}, '$.sessionGoalProposal') = 'object' AND lower(trim(json_extract(${DOC}, '$.sessionGoalProposal.action'))) = 'set') ORDER BY c.id`);
  return {
    queueCursor(conversationId: string) {
      const row = db.prepare(`SELECT ${scalar('$.conversationTurnQueue.lastConsumedUserMessageId')} AS cursor
        FROM chat_conversations c WHERE c.id=?`).get(conversationId);
      checkIdentities({ cursorId: row?.cursor });
      return row?.cursor === null || row?.cursor === undefined ? undefined : String(row.cursor).trim();
    },
    get(conversationId: string) { return summarize(get.get(conversationId), db); },
    list() { return list.all().map((row: any) => summarize(row, db)).filter((item: any) => item.state.goal || item.state.proposal?.action === 'set'); },
  };
}
