const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '../..');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture({ binding, dag, pending = false, noGoal = false, confirm = true } = {}) {
  const window = new JSDOM('<div id="drawer"><div id="details"></div><button id="bind">交给规划者</button></div>', { url: 'http://localhost/', runScripts: 'outside-only' }).window;
  for (const file of ['public/shared/session-goal.js', 'public/chat/session-goal-panel.js']) window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  const commands = [], prompts = [];
  const conversation = { id: 'room', metadata: { ...(noGoal ? {} : { sessionGoal: { goalId: 'goal', revision: 7, objective: 'Goal', status: 'paused' } }),
    ...(binding === undefined ? {} : { sessionGoalPlannerBinding: binding }), ...(dag ? { dagNodeGoalBinding: dag } : {}),
    ...(pending ? { sessionGoalProposal: { id: 'proposal', action: 'pause' } } : {}) } };
  window.confirm = text => { prompts.push(text); return confirm; };
  const button = window.document.getElementById('bind');
  const controller = window.CaffChat.createSessionGoalPanelController({ state: { currentConversation: conversation },
    dom: { sessionGoalDrawer: window.document.getElementById('drawer'), sessionGoalBindPlannerButton: button, sessionGoalDetails: window.document.getElementById('details') },
    helpers: { formatDateTime: String, submitGoalCommand: async (id, command) => { commands.push({ id, command }); } }, showToast() {} });
  controller.bindEvents(); controller.render();
  return { window, button, commands, prompts, controller, conversation };
}

test('Goal panel adoption requires confirmation and submits displayed ID/revision through the ordinary user command path', async () => {
  const f = fixture();
  assert.equal(f.button.classList.contains('hidden'), false);
  assert.equal(f.button.disabled, false);
  f.button.click(); await flush();
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /规划者/);
  assert.equal(f.commands.length, 1);
  const { id, command } = f.commands[0];
  assert.equal(id, 'room');
  assert.equal(command.action, 'bind-planner');
  assert.equal(command.goalId, 'goal');
  assert.equal(command.goalRevision, 7);
  assert.ok(command.reason.trim());
  assert.equal(command.ruledBy, undefined);
  assert.equal(command.Authorization, undefined);
});
test('cancelling adoption makes zero writes', async () => {
  const f = fixture({ confirm: false }); f.button.click(); await flush();
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.commands, []);
});
test('adoption is hidden for bound, malformed-bound, DAG and missing Goals; pending proposals disable it', async () => {
  for (const options of [{ binding: { plannerName: 'Planner', goalId: 'goal' } }, { binding: null }, { dag: { planId: 'plan' } }, { noGoal: true }]) {
    const f = fixture(options);
    assert.equal(f.button.classList.contains('hidden'), true);
    assert.equal(f.button.disabled, true);
  }
  const pending = fixture({ pending: true });
  assert.equal(pending.button.disabled, true);
  pending.button.click(); await flush();
  assert.deepEqual(pending.commands, []);
});
test('binding conflict refreshes the displayed Goal and never automatically rebinds', async () => {
  const f = fixture(), calls = [], reads = [], refreshed = [];
  const error = Object.assign(new Error('Changed Goal'), { status: 409, code: 'goal_revision_conflict' });
  await assert.rejects(f.window.CaffShared.sessionGoal.submitWithProposalConfirmation({ conversation: f.conversation,
    command: { action: 'bind-planner', goalId: 'goal', goalRevision: 7, reason: 'User confirmed' },
    post: async body => { calls.push(body); throw error; }, read: async () => { reads.push(true); return { conversation: f.conversation }; },
    refresh: data => refreshed.push(data), confirm: () => { throw Error('Must not reconfirm silently'); },
  }), { code: 'goal_revision_conflict' });
  assert.equal(calls.length, 1);
  assert.equal(reads.length, 1);
  assert.equal(refreshed.length, 1);
});
test('real page wires the adoption control through submitGoalCommand and shared CSRF client', () => {
  assert.match(fs.readFileSync(path.join(root, 'public/index.html'), 'utf8'), /id="session-goal-bind-planner-button"/);
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /sessionGoalBindPlannerButton/);
  assert.match(app, /sessionGoalUtils\.submitWithProposalConfirmation/);
  assert.match(app, /post:.*fetchJson\(endpoint/s);
});
