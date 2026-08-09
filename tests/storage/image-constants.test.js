const assert = require('node:assert/strict');
const test = require('node:test');
const imageConstants = require('../../build/lib/image-constants');

test('image constants match AC-A1 exact upper bounds', () => {
  assert.equal(imageConstants.MAX_IMAGE_BYTES, 10_485_760);
  assert.equal(imageConstants.MAX_IMAGES_PER_UPLOAD, 5);
  assert.equal(imageConstants.MAX_IMAGES_PER_MESSAGE, 5);
  assert.equal(imageConstants.MAX_IMAGE_WIDTH, 4096);
  assert.equal(imageConstants.MAX_IMAGE_HEIGHT, 4096);
  assert.equal(imageConstants.MAX_IMAGE_PIXELS, 16_000_000);
});

test('image constants whitelist covers png/jpeg/webp/gif only', () => {
  assert.deepEqual(
    Array.from(imageConstants.ALLOWED_IMAGE_MIME_TYPES).sort(),
    ['image/gif', 'image/jpeg', 'image/png', 'image/webp']
  );
});

test('image constants expose budget and lifecycle bounds', () => {
  assert.ok(imageConstants.MAX_IMAGES_PER_INVOCATION >= 1);
  assert.ok(imageConstants.MAX_IMAGE_PROMPT_BYTES >= 1);
  assert.ok(imageConstants.STAGED_IMAGE_TTL_MS >= 1);
  assert.ok(imageConstants.UPLOAD_LEASE_TTL_MS >= 1);
  assert.ok(imageConstants.UPLOAD_RETRY_AFTER_MS >= 1);
});
