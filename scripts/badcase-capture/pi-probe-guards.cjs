// Pure shared assertions for the container-only SDK probe and its trusted wrapper.
// No SDK, filesystem, process creation, environment discovery or model calls.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
function verifyMaterialBytes(bytes, record) {
  assert.equal(bytes.length, record.size, 'probe_material_size');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256, 'probe_material_hash');
}
function verifyNoProbeSideEffects(systemPrompt, modelCalls, networkCalls) {
  assert.ok(!systemPrompt.includes('Unapproved discovery trap'), 'probe_discovery_forbidden');
  assert.equal(modelCalls, 0, 'probe_model_called');
  assert.equal(networkCalls, 0, 'probe_network_called');
}
function verifiedCleanupId(container, owner, knownId) {
  assert.equal(container.Config.Labels?.['caff.badcase.pi-initialization'], owner, 'probe_cleanup_owner');
  assert.match(container.Id, /^[a-f0-9]{64}$/, 'probe_cleanup_id');
  if (knownId) assert.equal(container.Id, knownId, 'probe_cleanup_id');
  return container.Id;
}
module.exports = { verifyMaterialBytes, verifyNoProbeSideEffects, verifiedCleanupId };
