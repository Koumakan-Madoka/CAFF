const assert = require('node:assert/strict'), test = require('node:test');
const { createPlannerCliGate } = require('../helpers/planner-cli-gate');
const { runPlannerCli, encodePlannerJson } = require('../../build/lib/planner-cli');

test('repository CLI reads/rules/messages through actual P1 authentication and retains planner attribution; finish receiver is explicitly synthetic', async t => {
  const f = await createPlannerCliGate(); t.after(() => f.close());
  const run = args => runPlannerCli(args, f.env);
  assert.equal((await run(['state'])).conversationId, f.room.id);
  assert.equal((await run(['goal','read'])).goal.goalId, f.goal.goalId);
  assert.ok((await run(['attention','read'])).items.some(i => i.sequence === f.sequence && i.conversationId === f.room.id));
  const ruling = await run(['goal','action','--json',encodePlannerJson({ action: 'dismiss-proposal', goalId: f.goal.goalId, goalRevision: f.goal.revision, proposalId: f.proposal.id, reason: 'Synthetic gate only' })]);
  assert.equal(ruling.ruling.ruledBy.kind, 'planner'); assert.equal(ruling.ruling.ruledBy.plannerId, 'local-planner');
  const g = (await run(['goal','read'])).goal;
  const message = await run(['owner','message','--json',encodePlannerJson({ goalId: g.goalId, goalRevision: g.revision, ownerAgentId: g.owner.agentId, content: 'Synthetic instruction only', clientRequestId: 'synthetic-cli-message' })]);
  assert.equal(message.acceptedMessage.metadata.principal.kind, 'planner');
  assert.deepEqual(f.app.store.getMessage(message.acceptedMessage.id).metadata.routing.agentIds, ['synthetic-owner']);
  const reason = "User's approval; $(not-a-command) | & 中文 😀";
  const receipt = [{ sequence: f.sequence, disposition: 'needs_user', reason }];
  const finish = await run(['wakeup','finish','--attempt',f.attemptId,'--json',encodePlannerJson(receipt)]);
  assert.equal(finish.synthetic, true); assert.equal(finish.durable, false); assert.deepEqual(f.receipt, { items: receipt });
  assert.equal(finish.items[0].reason, reason);
});
