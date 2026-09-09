import assert from 'node:assert/strict';

// E2E-GOAL-01 (P0): save and reload must preserve the structured delivery contract.
// E2E-GOAL-02 (P1): a stale revision must fail without changing persisted data.
export async function verifyGoalContract({ browser, baseUrl, conversationId, ok }) {
  const endpoint = `${baseUrl}api/conversations/${encodeURIComponent(conversationId)}/goal`;
  async function post(command) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    return { status: response.status, body: await response.json() };
  }
  const seeded = await post({
    action: 'set', objective: 'E2E structured Goal original',
    decisions: { committed: [{ id: 'decision-durable', statement: 'Keep durable decisions', rationale: 'Preserve context', adrPath: 'docs/decisions/test.md' }] },
    acceptanceCriteria: [{ id: 'criterion-durable', statement: 'Evidence survives editing', verifyBy: 'Browser and API assertions', status: 'passed', risk: 'high', evidenceRefs: ['proof-durable'] }],
    workItems: [{ id: 'work-durable', text: 'Verify contract', status: 'done', acceptanceCriteriaRefs: ['criterion-durable'] }],
    evidence: [{ id: 'proof-durable', summary: 'Seeded verification fixture', reference: 'fixture://goal-contract', criterionIds: ['criterion-durable'] }],
  });
  assert.equal(seeded.status, 200, `Goal seed failed (${seeded.status})`);
  const original = seeded.body.conversation.metadata.sessionGoal;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.locator(`button.conversation-item[data-id="${conversationId}"]`).click();
    await page.locator('#drawerToggle').click();
    await page.locator('#tab-goal').click();
    await page.waitForFunction(() => document.getElementById('session-goal-objective').value === 'E2E structured Goal original');
    await page.locator('#session-goal-objective').fill('E2E structured Goal revised');
    const responsePromise = page.waitForResponse((response) => response.url() === endpoint && response.request().method() === 'POST');
    await page.locator('#session-goal-save-button').click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const revised = (await response.json()).conversation.metadata.sessionGoal;
    assert.equal(revised.goalId, original.goalId);
    assert.equal(revised.revision, original.revision + 1);
    for (const key of ['decisions', 'acceptanceCriteria', 'workItems', 'evidence']) {
      assert.deepEqual(revised[key], original[key], `${key} must survive form submission`);
    }
    await page.reload({ waitUntil: 'load' });
    await page.locator('#drawerToggle').click();
    await page.locator('#tab-goal').click();
    await page.waitForFunction(() => document.getElementById('session-goal-objective').value === 'E2E structured Goal revised');
    const fetched = await fetch(`${baseUrl}api/conversations/${encodeURIComponent(conversationId)}`);
    assert.equal(fetched.status, 200);
    const persisted = (await fetched.json()).conversation.metadata.sessionGoal;
    assert.deepEqual(persisted, revised);
    ok('E2E-GOAL-01 browser save and reload preserves Goal identity and evidence', true);

    const rejected = await post({ ...original, action: 'revise', goalRevision: original.revision, objective: 'Stale overwrite' });
    assert.equal(rejected.status, 409);
    const afterRejection = await fetch(`${baseUrl}api/conversations/${encodeURIComponent(conversationId)}`);
    assert.deepEqual((await afterRejection.json()).conversation.metadata.sessionGoal, revised);
    ok('E2E-GOAL-02 stale revision is rejected without changing stored Goal', true);

    // E2E-GOAL-03 (P1): replacing a verified criterion keeps the artifact, not its proof link.
    await page.locator('#session-goal-acceptance').fill('Changed behavior | Run new verification');
    const changedResponsePromise = page.waitForResponse((result) => result.url() === endpoint && result.request().method() === 'POST');
    await page.locator('#session-goal-save-button').click();
    const changedResponse = await changedResponsePromise;
    assert.equal(changedResponse.status(), 200);
    const changed = (await changedResponse.json()).conversation.metadata.sessionGoal;
    assert.equal(changed.goalId, original.goalId);
    assert.equal(changed.acceptanceCriteria[0].status, 'pending');
    assert.deepEqual(changed.acceptanceCriteria[0].evidenceRefs, []);
    assert.equal(changed.evidence[0].id, original.evidence[0].id);
    assert.equal(changed.evidence[0].reference, original.evidence[0].reference);
    assert.deepEqual(changed.evidence[0].criterionIds, []);
    ok('E2E-GOAL-03 changed criteria detach stale proof without deleting artifacts', true);
  } finally {
    await page.close();
  }
}
