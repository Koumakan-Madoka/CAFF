// A local derivative has no registry RepoDigest. Permit only the explicit,
// versioned rg recipe, still pinning its immutable Docker image ID and labels.
const assert = require('node:assert/strict');
const RECIPE = 'wikiskill-rg13-v1';
const BASE = 'sha256:5738ddb39d7f2420a5d43b86be907de09eed5c0751a034f233b3a0aa2d5cbebe';
const DEB = 'feba1aea6022d84c67293686fe82132f7283d3c485a2cbd5af5c0e210615ecc2';
function verifyReplayImage(inspected, image) {
  assert.equal(inspected.Id, image.imageId);
  if (image.localBuild === undefined) assert.ok(inspected.RepoDigests.includes(image.repositoryDigest));
  else {
    assert.equal(image.localBuild, RECIPE);
    assert.equal(image.architecture, 'amd64');
    assert.equal(image.repositoryDigest, 'node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0');
    const labels = inspected.Config.Labels;
    assert.equal(labels?.['caff.badcase.replay-recipe'], RECIPE);
    assert.equal(labels?.['caff.badcase.base-image'], BASE);
    assert.equal(labels?.['caff.badcase.ripgrep-deb'], DEB);
  }
}
module.exports = { verifyReplayImage, RECIPE, BASE, DEB };
