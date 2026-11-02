// Trusted SDK gateway lifecycle over the ORIGINAL approval and two ledgers.
// No HTTP authorization/CLI, credential discovery, SDK import or default launcher.
// drive is a trusted isolated launcher, NOT tested code: it must independently
// verify its declared launchHash/materials, own process termination and scoring,
// and return ONLY after its worker/callback/processes have actually stopped.
const { captureHostCode } = require('./model-host-code.cjs');
const snapshot = captureHostCode(); // before loading dependencies; disk source/ancestors remain same-user TCB
const crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const { readBoundModelApproval, dispatchBoundModelEvaluation } = require('../../build/server/domain/runtime/badcase-capture/model-binding');
const { readModelEgress } = require('../../build/server/domain/runtime/badcase-capture/model-egress');
const { startSdkModelGateway, sdkGatewayModelRouting } = require('./sdk-model-gateway.cjs');
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const copy = v => JSON.parse(JSON.stringify(v));
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function check(v) { if (!v) throw Error('approved_sdk_gateway_invalid'); }
function approvedSdkGatewayHarness(launchHash) {
  check(digest(launchHash)); snapshot.verify();
  const declaration = { kind: 'approved-native-sdk-gateway-v1', launchHash, files: snapshot.files };
  // launchHash is the launcher's reviewed code/staged-input declaration, NOT
  // something this generic supervisor can independently attest or reconstruct.
  return { ...copy(declaration), harnessHash: hash(declaration) };
}
async function dispatchApprovedSdkGateway(root, approvalId, launchHash, credential, drive) {
  check(typeof drive === 'function' && typeof credential === 'function');
  const harness = approvedSdkGatewayHarness(launchHash), initial = readBoundModelApproval(root, approvalId);
  check(initial.report.ledger.spec.harnessHash === harness.harnessHash);
  const config = initial.binding.config, spec = initial.report.ledger.spec;
  // Current ordinary-SDK validation scope only: no model/mode/rate fallback,
  // arbitrary unbounded session or background loop. Every new plan is immutable.
  check(Object.hasOwn(config, 'tools') && config.maxRequests <= 2 && spec.timeoutMs <= 25000);
  check(config.settings.provider === 'opencode-go' && config.settings.model === 'deepseek-v4.1-flash' && config.settings.compatibilityProfile);
  const profile = { settings: config.settings, tools: config.tools };
  return dispatchBoundModelEvaluation(root, approvalId, async (run, authorizedSend) => {
    snapshot.verify();
    const started = performance.now(), expiresAt = Math.min(run.expiresAt, Date.now() + run.timeoutMs);
    const expired = () => Date.now() >= expiresAt || performance.now() - started >= run.timeoutMs;
    const controller = new AbortController();
    let gateway, timer, result;
    try {
      gateway = await startSdkModelGateway({ profile, maxRequests: config.maxRequests, expiresAt }, async body => {
        snapshot.verify(); check(!controller.signal.aborted && !expired());
        const response = await authorizedSend(body);
        snapshot.verify(); check(!controller.signal.aborted && !expired()); return response;
      });
      const wake = () => {
        if (expired()) {
          controller.abort(); void gateway.stop().catch(() => {});
        } else timer = setTimeout(wake, Math.max(1, Math.min(expiresAt - Date.now(), run.timeoutMs - (performance.now() - started))));
      };
      wake(); check(!controller.signal.aborted && !expired());
      // Only a fresh LOCAL identity reaches the launcher/worker. Neither the
      // supplier lease, raw source file nor the supervisor's send capability does.
      result = await drive({ run: copy(run), ...sdkGatewayModelRouting(profile, gateway), signal: controller.signal });
      check(!controller.signal.aborted && !expired() && gateway.status().failed === false); snapshot.verify();
    } finally {
      clearTimeout(timer); controller.abort(); await gateway?.stop();
    }
    // Gateway stop joins all pending sends before the outer run can settle.
    // An uncooperative launcher is JOINED, not magically killed; the original
    // Docker/preview owner must enforce and observe worker termination itself.
    snapshot.verify();
    const egress = readModelEgress(root, run.runId);
    check(egress.requests.length > 0 && egress.unknownCostRequests === 0 && egress.requests.every(r => r.status === 'completed'));
    check(exact(result, ['outputHash', 'score']) && digest(result.outputHash)
      && exact(result.score, ['expectationMet', 'badcaseReproduced'])
      && typeof result.score.expectationMet === 'boolean' && typeof result.score.badcaseReproduced === 'boolean');
    return { runId: run.runId, status: 'completed', costMicroUsd: egress.knownCostMicroUsd, ...copy(result) };
  }, scope => { snapshot.verify(); return credential(scope); });
}
module.exports = { approvedSdkGatewayHarness, dispatchApprovedSdkGateway };
