const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { verifyReplayImage, RECIPE, BASE, DEB } = require('../../scripts/badcase-capture/replay-image.cjs');
test('rg derivative is pinned by immutable ID and fixed recipe labels, never pretending to have the base RepoDigest', () => {
  const image = { imageId: 'sha256:' + 'a'.repeat(64), architecture: 'amd64', repositoryDigest: 'node@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0', localBuild: RECIPE };
  const actual = { Id: image.imageId, RepoDigests: [], Config: { Labels: { 'caff.badcase.replay-recipe': RECIPE, 'caff.badcase.base-image': BASE, 'caff.badcase.ripgrep-deb': DEB } } };
  assert.doesNotThrow(() => verifyReplayImage(actual, image));
  for (const label of Object.keys(actual.Config.Labels)) { const b = structuredClone(actual); b.Config.Labels[label] = 'changed'; assert.throws(() => verifyReplayImage(b, image)); }
  assert.throws(() => verifyReplayImage({ ...actual, Id: 'wrong' }, image));
  assert.throws(() => verifyReplayImage(actual, { ...image, localBuild: 'other' }));
  assert.throws(() => verifyReplayImage(actual, { ...image, architecture: 'arm64' }));
  assert.throws(() => verifyReplayImage(actual, { ...image, localBuild: undefined }));
  assert.doesNotThrow(() => verifyReplayImage({ ...actual, RepoDigests: [image.repositoryDigest] }, { ...image, localBuild: undefined }));
});
test('versioned offline replay Dockerfile pins base, package bytes and installed rg version', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../scripts/badcase-capture/replay.Dockerfile'), 'utf8');
  assert.ok(text.includes(BASE)); assert.ok(text.includes(DEB));
  assert.match(text, /13\.0\.0-4\+b2/); assert.match(text, /ripgrep 13\.0\.0/);
  assert.doesNotMatch(text, /apt-get|curl |wget |auth\.json|COPY \./);
});
