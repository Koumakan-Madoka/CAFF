// Synthetic layouts only: no live instance, credentials or model calls.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const base = '../../build/server/domain/runtime/badcase-capture/';
require('../helpers/external-integrations').isolateExternalIntegrations();
const { browserFetch: fetch } = require('../helpers/browser-fetch');
function layout(t, configured = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-data-dir-'));
  const sourceWorktree = path.join(root, 'repo'), agentDir = path.join(sourceWorktree, '.pi-sandbox'), dataDir = path.join(root, 'wiki-data');
  const old = Object.fromEntries(['CAFF_WIKISKILL_DATA_DIR', 'PI_CODING_AGENT_DIR'].map(k => [k, process.env[k]]));
  if (configured) process.env.CAFF_WIKISKILL_DATA_DIR = dataDir; else delete process.env.CAFF_WIKISKILL_DATA_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup) await fn(); for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(root, { recursive: true, force: true }); });
  return { root, sourceWorktree, agentDir, dataDir, cleanup, defaults: { agentDir, sourceWorktree }, scope: { globalRoot: path.join(agentDir, 'badcase-global'), sourceWorktree } };
}
test('external data directory is shared by wiki snapshots and every progress store', t => {
  const h = layout(t), { createWikiStore } = require(base + 'wiki-store');
  const store = createWikiStore(h.defaults); assert.equal(store.read().revision, 0);
  store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p', conversationId: 'c', messageId: 'm', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'unclear', expected: 'clear', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'badcase-global/snapshots/000000000001.json')), true);
  assert.equal(fs.existsSync(h.scope.globalRoot), false);
  const progress = require(base + 'wiki-execution-store').createWikiExecutionStore(h.defaults);
  const p = { kind: 'sealed-original-replay-v1', model: 'deepseek/deepseek-v4-flash', repeats: 1, variants: ['original'], caseId: 'case-fixture', checkpointId: 'cp1', checkpointHash: 'a'.repeat(64), rulesHash: 'b'.repeat(64) };
  const r = progress.start(p); progress.fail(r.id, 'evaluation_failed');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'badcase-global/executions', r.id + '.json')), true);
  assert.deepEqual(require(base + 'wiki-comparison-store').createWikiComparisonStore(h.defaults).read(), []);
  assert.deepEqual(require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.defaults).read(), []);
});
test('evaluation command respects its explicit JSON globalRoot despite configured defaults', async t => {
  const h = layout(t), file = path.join(h.root, 'evaluation.json'), output = path.join(h.root, 'evidence.jsonl');
  const globalRoot = path.join(h.root, 'explicit-global');
  fs.writeFileSync(file, JSON.stringify({ ...h.scope, globalRoot, comparison: {} }));
  const summary = { kind: 'sealed-original-replay-v1', model: 'deepseek/deepseek-v4-flash', repeats: 1, variants: ['original'], caseId: 'case-fixture', checkpointId: 'cp1', checkpointHash: 'a'.repeat(64), rulesHash: 'b'.repeat(64) };
  const main = require('../../scripts/badcase-capture/run-wiki-evaluation.cjs').main;
  const deps = { prepare: () => ({ supported: true, summary }), print: () => {}, run: async () => { throw Object.assign(Error('synthetic'), { code: 'evaluation_failed' }); } };
  const plan = await main(['--config', file, '--plan'], deps);
  await assert.rejects(main(['--config', file, '--run', '--confirmed', '--expected-plan', plan.planHash, '--output', output], deps), /evaluation_failed/);
  assert.equal(fs.readdirSync(path.join(globalRoot, 'executions')).length, 1);
  assert.equal(fs.existsSync(h.dataDir), false);
  assert.equal(fs.existsSync(h.scope.globalRoot), false);
});
test('configured data directory inside a source still fails the existing boundary', t => {
  const h = layout(t); process.env.CAFF_WIKISKILL_DATA_DIR = path.join(h.sourceWorktree, 'wiki-data');
  assert.throws(() => require(base + 'wiki-store').createWikiStore(h.defaults), /wiki_storage_inside_source/);
});
test('configured directory must be absolute; invalid values never fall back to agentDir', t => {
  const h = layout(t);
  for (const value of ['relative/wiki', '', 'bad\0path']) {
    process.env.CAFF_WIKISKILL_DATA_DIR = value;
    assert.throws(() => require(base + 'wiki-store').createWikiStore(h.defaults), /wiki_data_dir_invalid/);
  }
});
test('real API and marked-case writes use external wiki data while capture stays in the instance agentDir', async t => {
  const h = layout(t); fs.mkdirSync(h.sourceWorktree, { recursive: true });
  const { createTestServerApp: createServerApp } = require('../helpers/server-app');
  let inducted = false;
  const app = createServerApp({ host: '127.0.0.1', port: 0, agentDir: h.agentDir, projectDir: h.sourceWorktree, sqlitePath: path.join(h.root, 'chat.sqlite'), uploadsDir: path.join(h.root, 'uploads'), badcaseWikiInductionRunner: async ({ store }) => { assert.equal(store.read().cases.length, 1); inducted = true; } });
  h.cleanup.push(() => new Promise(resolve => app.close(resolve)));
  await new Promise(resolve => app.start(resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const response = await fetch(url + '/api/wikiskill'); assert.equal(response.status, 200); assert.equal((await response.json()).revision, 0);
  const projectId = (await (await fetch(url + '/api/projects')).json()).activeProjectId;
  app.store.saveCustomRoleConfig({ id: 'data-agent', name: 'Synthetic', personaPrompt: 'test' });
  app.store.createConversation({ id: 'data-room', title: 'Synthetic', participants: ['data-agent'], projectScopeId: projectId });
  app.store.createMessage({ id: 'data-message', conversationId: 'data-room', role: 'assistant', status: 'completed', agentId: 'data-agent', runId: 101, content: 'synthetic' });
  const marked = await fetch(url + `/api/projects/${projectId}/conversations/data-room/messages/data-message/badcase-flag`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, actual: 'unclear', expected: 'clear' }) });
  assert.equal(marked.status, 201); const body = await marked.json(); assert.ok(body.wikiCase.case?.id, JSON.stringify(body.wikiCase));
  assert.equal((await (await fetch(url + '/api/wikiskill')).json()).cases.length, 1);
  const induction = await fetch(url + '/api/wikiskill/induct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, expectedRevision: 1 }) });
  assert.equal(induction.status, 200); assert.equal(inducted, true);
  assert.equal(fs.existsSync(path.join(h.agentDir, 'badcase-global')), false);
  assert.equal(fs.existsSync(path.join(h.agentDir, 'badcase-capture')), true);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'badcase-capture')), false);
});
test('unset data directory preserves the old root and inside-source rejection', t => {
  const h = layout(t, false), { createWikiStore } = require(base + 'wiki-store');
  assert.throws(() => createWikiStore(h.scope), /wiki_storage_inside_source/);
  const legacy = path.join(h.root, 'legacy'); assert.equal(createWikiStore({ ...h.scope, globalRoot: legacy }).read().revision, 0);
});
