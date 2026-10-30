const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
function fixture(options = {}) {
  const window = { CaffShared: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/shared/session-goal.js'), 'utf8'), { window });
  const posts = [], prompts = [], reads = [], refreshed = [];
  const conversation = { id: 'room', metadata: { sessionGoal: { goalId: 'goal', revision: 7, objective: 'Goal' },
    ...(options.pending === false ? {} : { sessionGoalProposal: { id: 'proposal', action: 'pause', reason: 'Milestone review', proposedBy: { agentName: 'Author' } } }) } };
  const invoke = async (command = { action: 'pause' }) => window.CaffShared.sessionGoal.submitWithProposalConfirmation({ conversation, command,
    post: async body => { posts.push(body); return options.post ? options.post(body, posts.length) : { ok: true }; },
    read: async () => { reads.push('read'); return options.read ? options.read() : { conversation }; },
    refresh: data => refreshed.push(data),
    confirm: message => { prompts.push(message); return options.confirm !== false; },
  });
  return { invoke, posts, prompts, reads, refreshed, conversation };
}
function conflict(code) { return Object.assign(new Error(code), { status: 409, code }); }
for (const action of ['set', 'revise', 'pause', 'resume', 'complete']) {
  test(`${action} confirms pending proposal before the first write, cancellation has zero writes`, async () => {
    const cancelled = fixture({ confirm: false });
    assert.equal(await cancelled.invoke({ action }), null);
    assert.equal(cancelled.posts.length, 0);
    assert.match(cancelled.prompts[0], /Author/);
    assert.match(cancelled.prompts[0], /Milestone review/);
    const accepted = fixture();
    await accepted.invoke({ action });
    assert.equal(accepted.posts.length, 1);
    assert.equal(accepted.posts[0].supersedeProposal, true);
    assert.equal(accepted.posts[0].proposalId, 'proposal');
    assert.equal(accepted.posts[0].goalId, 'goal');
    assert.equal(accepted.posts[0].goalRevision, 7);
  });
}
test('a race returning 409 refreshes the proposal and confirms before exactly one retry', async () => {
  const pending = { id: 'new', action: 'pause', reason: 'Newly arrived proposal', proposedBy: { agentName: 'New author' } };
  const f = fixture({ pending: false, post: (_body, count) => { if (count === 1) throw conflict('goal_proposal_pending'); return { ok: true }; },
    read: () => ({ conversation: { metadata: { sessionGoal: { goalId: 'goal', revision: 7, objective: 'Goal' }, sessionGoalProposal: pending } } }) });
  await f.invoke();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[0].supersedeProposal, undefined);
  assert.equal(f.posts[1].proposalId, 'new');
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /Newly arrived proposal/);
  assert.equal(f.reads.length, 1);
  assert.equal(f.refreshed.length, 1);
});
test('cancelling a raced conflict never retries or discards the new proposal', async () => {
  const current = fixture().conversation;
  const f = fixture({ pending: false, confirm: false, post: () => { throw conflict('goal_proposal_pending'); }, read: () => ({ conversation: current }) });
  assert.equal(await f.invoke(), null);
  assert.equal(f.posts.length, 1);
  assert.equal(f.prompts.length, 1);
});
test('a proposal replaced after confirmation is refreshed and rejected, never silently superseded', async () => {
  const f = fixture({ post: () => { throw conflict('goal_proposal_conflict'); } });
  await assert.rejects(f.invoke(), { code: 'goal_proposal_conflict' });
  assert.equal(f.posts.length, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.refreshed.length, 1);
});
test('factual writes and explicit rulings never take the supersession shortcut', async () => {
  for (const action of ['set-owner', 'update-delivery', 'accept-proposal', 'dismiss-proposal', 'clear']) {
    const f = fixture();
    await f.invoke({ action });
    assert.equal(f.prompts.length, 0);
    assert.equal(f.posts[0].supersedeProposal, undefined);
  }
});
test('unrelated errors do not prompt/retry; a revision race cannot silently rebase the command', async () => {
  const f = fixture({ pending: false, post: () => { throw conflict('goal_revision_conflict'); } });
  await assert.rejects(f.invoke(), { code: 'goal_revision_conflict' });
  assert.equal(f.posts.length, 1);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.reads.length, 0);
  const newer = { metadata: { sessionGoal: { goalId: 'goal', revision: 8, objective: 'Changed Goal' }, sessionGoalProposal: { id: 'new', action: 'pause' } } };
  const stale = fixture({ pending: false, post: (_body, count) => { if (count === 1) throw conflict('goal_proposal_pending'); return { ok: true }; }, read: () => ({ conversation: newer }) });
  await assert.rejects(stale.invoke({ action: 'revise', goalRevision: 7 }), { code: 'goal_revision_conflict' });
  assert.equal(stale.posts.length, 1);
  assert.equal(stale.prompts.length, 0);
});
