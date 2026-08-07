const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const assetPath = path.join(root, 'assets', 'model-catalog.json');
const sourcePath = path.join(root, 'assets', 'model-catalog.SOURCE.md');
const licensePath = path.join(root, 'assets', 'model-catalog.LICENSE');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('vendored models.dev snapshot has reproducible provenance and license artifacts', () => {
  assert.equal(fs.existsSync(assetPath), true, 'vendored catalog asset exists');
  assert.equal(fs.existsSync(sourcePath), true, 'source declaration exists');
  assert.equal(fs.existsSync(licensePath), true, 'upstream license exists');

  const document = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
  const source = fs.readFileSync(sourcePath, 'utf8');
  const license = fs.readFileSync(licensePath, 'utf8');

  assert.equal(document.schemaVersion, 1);
  assert.ok(document.providers && typeof document.providers === 'object');
  assert.ok(Object.keys(document.providers).length > 0);
  assert.equal(document.provenance.kind, 'vendored');
  assert.equal(document.provenance.sourceUrl, 'https://models.dev/api.json');
  assert.match(document.provenance.commitSha, /^[0-9a-f]{40}$/u);
  assert.match(document.provenance.payloadSha256, /^[0-9a-f]{64}$/u);
  assert.match(document.provenance.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);

  assert.match(source, new RegExp(document.provenance.commitSha, 'u'));
  assert.match(source, new RegExp(document.provenance.payloadSha256, 'u'));
  assert.match(source, /https:\/\/models\.dev\/api\.json/u);
  assert.match(source, /generatedAt/u);
  assert.match(license, /^MIT License\b/u);

  const normalizedProvidersHash = sha256(`${JSON.stringify(document.providers)}\n`);
  assert.match(source, new RegExp(normalizedProvidersHash, 'u'));
});
