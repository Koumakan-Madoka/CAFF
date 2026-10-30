import { encodePlannerJson } from '../../../lib/planner-cli';

// This is instruction text, not a broader tool policy. All examples use the
// adapter's existing canonical encoder; IDs/revisions must come from P1 reads.
export function plannerWakeupCommandCard(prefix: string, attemptId: string) {
  const command = (suffix: string) => `${prefix} ${suffix}`;
  const jsonCommand = (suffix: string, value: any) => command(`${suffix} --json '${encodePlannerJson(value)}'`);
  const common = { goalId: 'GOAL_ID', goalRevision: 1, reason: 'Inspected current state and evidence' };
  const examples = [
    { action: 'pause', ...common },
    { action: 'resume', ...common },
    { action: 'complete', ...common },
    { action: 'set-owner', ...common, ownerAgentId: 'OWNER_AGENT_ID' },
    { action: 'accept-proposal', ...common, proposalId: 'PROPOSAL_ID' },
    { action: 'dismiss-proposal', ...common, proposalId: 'PROPOSAL_ID' },
    { action: 'update-delivery', ...common, workItems: [{ id: 'WORK_ID', status: 'done' }] },
    { action: 'revise', ...common, decisions: { provisional: [{ id: 'DECISION_ID', statement: 'Delegated tentative decision', changeConditions: 'New evidence' }] } },
  ];
  return [
    'CAFF COMMAND CARD (the actual trusted prefix is written out on every command).',
    'Only these six commands exist: no --help or other parameters beyond those documented here. Each Bash call must be exactly one command, nothing before or after: no chaining, pipes, redirects, substitutions, multiline commands or auxiliary programs. Never substitute a PATH alias for the prefix.',
    'Suggested order: state -> goal read -> delegated action -> finish. Read attention as needed. A denied --help is not evidence that state or goal read is denied; use the commands below, do not probe other spellings.',
    command('state'),
    command('goal read'),
    command('attention read --after <n> --limit <n>'),
    command("goal action --json '<object>'"),
    command("owner message --json '<object>'"),
    command(`wakeup finish --attempt ${attemptId} --json '<array>'`),
    'Angle-bracket tokens are documentation placeholders, never shell redirections. Replace them with data. attention: after is a nonnegative integer (start at 0); limit is 1..500 (use 100). No room, URL or credential options.',
    'goal action object: required action, goalId, goalRevision, reason. Copy the exact current goalId and positive integer revision from goal read; null/0 applies only to an absent Goal and does not authorize creating one. reason is nonblank single-line text, at most 1000 UTF-16 code units. Allowed actions: pause, resume, complete, set-owner, accept-proposal, dismiss-proposal, update-delivery, revise. set-owner also requires ownerAgentId; accept-proposal and dismiss-proposal require the current proposalId. A direct action superseding a pending proposal additionally requires supersedeProposal:true and that proposalId; do not silently discard a proposal.',
    'update-delivery may patch workItems:{id,status}, acceptanceCriteria:{id,status,evidenceRefs}, evidence:{id,criterionIds,kind,summary,reference}. revise additionally permits work-item text, decisions:{provisional:[{id,statement,changeConditions}],openQuestions:[{id,question}]}, impact and normal criterion waiver:{reason}. These are P1 collection patches: preserve retained members by id from the complete Goal; omission is not permission to remove them. No objective, committed decisions, non-goals or criterion-definition changes. complete requires verified acceptance evidence; resume after failure requires diagnosis. User-only gates remain user-only. On conflict reread and inspect, never replay a write blindly.',
    'Action examples only: replace ALL example IDs, revisions and patch members with current inspected values; never execute the examples literally. One example for each allowed action:',
    ...examples.map(value => jsonCommand('goal action', value)),
    'owner message object: exactly goalId, goalRevision, ownerAgentId, content, clientRequestId. Use the current owner from goal read; content is nonblank single-line text <=4000 UTF-16 code units, without @; clientRequestId is a stable unique message ID, never an authentication value. The adapter checks the owner snapshot and adds the mention; no arbitrary recipient.',
    jsonCommand('owner message', { goalId: 'GOAL_ID', goalRevision: 1, ownerAgentId: 'OWNER_AGENT_ID', content: 'Inspect the fixed candidate evidence', clientRequestId: 'MESSAGE_ID' }),
    `finish: use attempt ${attemptId} and an array with exactly one {sequence,disposition,reason} for EVERY included item. sequence is the included positive integer; disposition is handled, needs_user or no_action; reason is nonblank single-line text <=500 code points. Only report handled after verifying durable resolution. User-reserved items require needs_user and NO Goal write. Plain final prose is NOT a receipt. Submit once before exit, then stop. Do not blindly repeat a successful receipt.`,
    'JSON TRANSPORT: one single-quoted compact ASCII JSON argument on one physical line, at most 16 KiB (the finish HTTP wrapper must also fit); whole invocation <=24576 UTF-16 code units. Inside JSON strings the following characters MUST use these exact lowercase Unicode escapes (structural JSON quotes remain literal):',
    ...['"', '\\', "'", '$', '`', ';', '&', '|', '<', '>', '(', ')'].map(c => `${c} -> \\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`),
    'All characters outside printable ASCII 0x20-0x7E MUST use \\uXXXX with lowercase hex; above U+FFFF use UTF-16 surrogate pairs (e.g. emoji \\ud83d\\ude42). No short quote/backslash/control escapes, raw Unicode, extra whitespace or duplicate keys. Decoded controls/NUL/invalid Unicode are still invalid. No stdin, files or alternate quoting for adapter calls. Never include credentials in arguments or reasons.',
    'Complete finish encoding example: decoded reason is Owner\'s request (reviewed). Replace sequence 42 with included sequences; include every item, not just this example:',
    jsonCommand(`wakeup finish --attempt ${attemptId}`, [{ sequence: 42, disposition: 'needs_user', reason: "Owner's request (reviewed)" }]),
    'Local caff_payload_noncanonical means NO HTTP was sent: escape gives only the first required spelling, e.g. {"ok":false,"code":"caff_payload_noncanonical","escape":"\\\\u0028"}. Correct ALL string characters per this card, not only the first hint, then submit the corrected call. If no escape hint is present, check compact canonical JSON/no duplicate keys. This local validation correction is not permission to retry HTTP conflicts or repeat writes.',
  ].join('\n');
}
