// Opt-in P1 + memory-only finish fixture for the planner's REAL CLI gate.
// Does not launch Claude. Never use this fixture as a production server.
if (require.main === module && process.argv.includes('--run')) {
  process.env.CAFF_DISABLE_ENV_LOCAL = '1';
  const { createPlannerCliGate } = require('../helpers/planner-cli-gate');
  createPlannerCliGate().then(f => {
    console.info(JSON.stringify({ synthetic: true, finishIsDurable: false, root: f.root, environment: f.env,
      goalId: f.goal.goalId, goalRevision: f.goal.revision, proposalId: f.proposal.id, ownerAgentId: f.goal.owner.agentId,
      attemptId: f.attemptId, attentionSequence: f.sequence, candidate: f.candidate,
      note: 'Candidate only. Use your isolated untrusted worktree and whitelisted real CLI environment. Create a genuine saved session before --resume; the candidate session UUID is a placeholder. Credential values are never printed. Ctrl+C closes and deletes this synthetic fixture.' }, null, 2));
    const close = () => { void f.close().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }).catch(() => { console.error('Synthetic gate fixture failed'); process.exitCode = 1; });
}
