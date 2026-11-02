// Authorized synthetic-only experiment. Real Docker SDK/tools, local synthetic
// HTTPS model; never a supplier call or a paid launch entry point.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { archiveImage } = require('./image-archive.cjs');
const { restoreImageArchive } = require('./image-recovery.cjs');
const { archiveRuntime, readRuntimeArchive } = require('./runtime-archive.cjs');
const { archiveHarness } = require('./harness-archive.cjs');
const { prepareOperator, readOperatorReport, runOperator } = require('./model-evaluation-operator.cjs');
const { startModelReviewServer } = require('./model-review-server.cjs');
const { runDockerCommand } = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const fixture = require('../../tests/helpers/badcase-initialization-fixture.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
let stage = 'prepare';
async function main() {
  const args = process.argv.slice(2), arg = n => { const i = args.indexOf('--' + n); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
  const image = { imageId: arg('image-id'), repositoryDigest: arg('repository-digest'), architecture: arg('architecture'), nodeVersion: arg('node-version'), pythonVersion: arg('python-version') };
  const target = { socket: arg('socket'), daemonId: arg('daemon-id'), dataRoot: arg('data-root') };
  const root = path.join(target.dataRoot, '..', 'model-artifacts'); fs.mkdirSync(root, { mode: 0o700 });
  const repo = path.resolve(__dirname, '../..'), cleanup = [], ids = [], reports = [];
  let server, original;
  try {
    const ref = await archiveImage(image, path.join(root, 'image')); stage = 'restore';
    const restored = await restoreImageArchive(ref, target);
    const sources = { runtimeArchive: archiveRuntime(repo, path.join(root, 'runtime')), harnessArchive: archiveHarness(repo, path.join(root, 'harness')) };
    stage = 'definitions';
    // Inspect SDK definitions inside an isolated container, before plan/approval.
    // Only fixed built-ins; no captured source or host SDK import.
    const definitions = readRuntimeArchive(sources.runtimeArchive);
    definitions.push({ path: 'probe.cjs', bytes: Buffer.from(`const a=require('node:assert/strict');a.equal(process.getuid(),65534);a.equal(process.cwd(),'/work');process.env.PI_OFFLINE='1';globalThis.fetch=()=>{throw Error('network')};(async()=>{const sdk=await import('./runtime/dist/bundle/index.js');a.equal(sdk.VERSION,'0.85.1');const all=sdk.createCodingTools('/work');const names=['read','write','edit','bash'];console.log(JSON.stringify(names.map(n=>{const t=all.find(t=>t.name===n);a.ok(t);return {type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}})))})().catch(()=>process.exitCode=1);`) });
    const discovered = await restored.runProbe(image, definitions); ids.push(discovered.containerId);
    assert.equal(discovered.result.code, 0); assert.equal(discovered.result.stderr, '');
    const tools = JSON.parse(discovered.result.stdout);
    // Return only our dedicated daemon to empty so the real operator restore
    // entry (not a bypass transport) can enforce its empty-target precondition.
    const removeLoaded = async () => {
      const list = await runDockerCommand(['ps', '-aq'], { dockerHost: target.socket });
      assert.equal(list.code, 0); assert.equal(list.stdout.trim(), '');
      const removed = await runDockerCommand(['image', 'rm', image.imageId], { dockerHost: target.socket });
      assert.equal(removed.code, 0); assert.equal(removed.failure, undefined);
    };
    await removeLoaded();
    const config = { settings: { provider: 'synthetic-relay', model: 'synthetic-tools', contextWindowTokens: 10000, maxOutputTokens: 1000,
      temperature: 0, inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 1000000, maxRequestBytes: 65536, maxResponseBytes: 65536 },
      endpoint: { hostname: 'synthetic.example.com', address: '93.184.216.34', path: '/v1/chat/completions', timeoutMs: 2000, maxRequestBytes: 65536, maxResponseBytes: 65536 },
      maxRequests: 8, tools };
    stage = 'tls';
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'),
      '-subj', '/CN=synthetic.example.com', '-addext', 'subjectAltName=DNS:synthetic.example.com'], { stdio: 'ignore', timeout: 15000 });
    const cert = fs.readFileSync(path.join(root, 'cert.pem'));
    let requests = 0, fault = ''; const initialInputs = [];
    server = https.createServer({ key: fs.readFileSync(path.join(root, 'key.pem')), cert }, (req, res) => {
      const pieces = []; let size = 0;
      req.on('data', b => { size += b.length; if (size > 65536) req.destroy(); else pieces.push(b); });
      req.on('end', () => {
        try {
          const q = JSON.parse(Buffer.concat(pieces)); requests++;
          const n = q.messages.filter(m => m.role === 'tool').length;
          if (n === 0) {
            assert.equal(q.messages.filter(m => m.role === 'user').at(-1).content, 'synthetic retained invocation');
            const normalized = structuredClone(q); normalized.messages[0].content = normalized.messages[0].content.replace('Synthetic baseline role.', 'ROLE').replace('Synthetic candidate role.', 'ROLE');
            initialInputs.push(hash(JSON.stringify(normalized)));
          }
          if (fault === 'timeout') return; // exchange must abort and stop its container
          const candidate = q.messages[0].content.includes('candidate');
          const step = [ { name: 'write', arguments: { path: 'evaluation-result.txt', content: candidate ? 'done\n' : 'draft\n' } },
            { name: 'read', arguments: { path: 'evaluation-result.txt' } }, { name: 'bash', arguments: { command: 'cat evaluation-result.txt', timeout: 2 } } ][n];
          assert.ok(n <= 3);
          const message = step ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-' + (n + 1), type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] } : { role: 'assistant', content: 'Synthetic endpoint finished.' };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'synthetic-' + requests, object: 'chat.completion', created: 1, model: fault === 'bad-response' ? 'wrong-model' : config.settings.model,
            choices: [{ index: 0, message, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
        } catch { res.writeHead(500); res.end(); }
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    original = https.request;
    https.request = options => {
      // Test-only routing/CA/peer substitution, exactly as the existing TLS suite.
      // No request uses the declared public address or a supplier credential.
      const req = original({ ...options, hostname: '127.0.0.1', port: server.address().port, ca: cert });
      req.on('socket', socket => Object.defineProperty(socket, 'remoteAddress', { value: options.hostname })); return req;
    };
    for (const scenario of ['fresh', 'resume', 'bad-response', 'timeout']) {
      const mode = scenario === 'resume' ? 'resume' : 'fresh'; fault = ['bad-response', 'timeout'].includes(scenario) ? scenario : '';
      stage = 'run-' + mode;
      const h = args.includes('--captured')
        ? await require('./captured-workbench-fixture.cjs')({ after: fn => cleanup.push(fn) }, mode)
        : fixture({ after: fn => cleanup.push(fn) }, mode);
      const c = { root: path.join(h.root, 'model-reviews'), captureRoot: h.root,
        selection: h.selection || { id: mode, projectId: 'p1', conversationId: 'c1', messageId: 'msg1' }, image, imageArchive: ref, sources,
        roles: { baseline: 'Synthetic baseline role.', candidate: 'Synthetic candidate role.' },
        rule: { expectedHash: hash('done\n'), badcaseHash: hash('draft\n') }, model: config,
        limits: { repetitions: 1, timeoutMs: 25000, perRunLimitMicroUsd: 88000, totalLimitMicroUsd: 176000 }, target, productionResourcesExcluded: true };
      const { entries } = prepareOperator(c);
      // Real local HTTP review, explicit approve, then close the review-only
      // server before the separate operator run. No paid supplier connection.
      const review = await startModelReviewServer({ root: c.root, entries });
      let ticket;
      try {
        const bootstrap = await (await fetch(review.url + '/api/bootstrap')).json();
        const post = async (action, body) => {
          const r = await fetch(review.url + '/api/model-review/p1/' + action, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: review.url, 'X-CAFF-CSRF-Token': bootstrap.localAdmin.modelProviders.csrfToken }, body: JSON.stringify(body) });
          assert.equal(r.status, 200); return r.json();
        };
        ticket = await post('preview', { entryId: mode });
        await post('approve', { confirmed: true, approvalId: ticket.approvalId, planHash: ticket.plan.planHash, bindingHash: ticket.binding.bindingHash });
      } finally { await review.close(); }
      const scope = path.join(c.root, hash('p1'));
      const report = await runOperator(c, ticket.approvalId, true, () => {
        const outer = readOperatorReport(c, ticket.approvalId).report;
        assert.equal(readModelEgress(scope, outer.ledger.runs.at(-1).runId).requests.at(-1).status, 'reserved');
        return { value: 'synthetic-inert-lease', expiresAt: Date.now() + 10000 };
      });
      stage = 'evidence-' + mode;
      if (fault) {
        assert.equal(report.dispatchState, 'unresolved'); assert.equal(report.ledger.runs.length, 1);
        assert.equal(report.ledger.runs[0].score, null); assert.equal(report.ledger.runs[0].costMicroUsd, null);
        const egress = readModelEgress(scope, report.ledger.runs[0].runId);
        assert.equal(egress.requests.length, 1); assert.equal(egress.unknownCostRequests, 1);
        reports.push({ scenario, dispatchState: report.dispatchState, score: null, knownCost: null });
        if (scenario !== 'timeout') await removeLoaded();
        continue;
      }
      assert.equal(report.ledger.state, 'complete'); assert.equal(report.ledger.runs.length, 2);
      assert.equal(report.ledger.summary.baseline.reproduced, 1); assert.equal(report.ledger.summary.candidate.expectationMet, 1);
      assert.equal(report.ledger.summary.candidate.reproduced, 0); assert.equal(report.ledger.summary.baseline.expectationMet, 0);
      assert.equal(report.ledger.knownCostMicroUsd, 240);
      assert.deepEqual(readOperatorReport(c, ticket.approvalId).report, report);
      for (const run of report.ledger.runs) { const r = readModelEgress(scope, run.runId); assert.equal(r.requests.length, 4); assert.equal(r.reason, 'completed'); }
      reports.push({ mode, capture: h.evidence || null, summary: report.ledger.summary, runs: report.ledger.runs, knownCostMicroUsd: report.ledger.knownCostMicroUsd });
      await removeLoaded();
    }
    assert.equal(requests, 18); assert.equal(ids.length, 1);
    assert.equal(initialInputs[0], initialInputs[1]); assert.equal(initialInputs[2], initialInputs[3]);
    console.log(JSON.stringify({ ok: true, kind: 'synthetic-model-docker-relay', requests, normalizedInitialInputsMatch: true,
      definitionContainerIds: ids, completedRunContainers: 4, failedRunContainers: 2, reports,
      realModelInvocations: 0, paidAuthorization: false, faithfulReplay: false, acceptance: false }));
  } finally {
    if (original) https.request = original;
    if (server) await new Promise(r => { server.closeAllConnections(); server.close(r); });
    for (const fn of cleanup.reverse()) fn();
  }
}
if (require.main === module) main().catch(() => { console.error('model_evaluation_verification_failed:' + stage); process.exitCode = 1; });
