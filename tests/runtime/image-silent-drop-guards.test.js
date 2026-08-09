const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');

function listTypeScriptFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listTypeScriptFiles(fullPath));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) results.push(fullPath);
  }
  return results;
}

function collectServerSource() {
  return [
    ...listTypeScriptFiles(path.join(projectRoot, 'server')),
    ...listTypeScriptFiles(path.join(projectRoot, 'lib')).filter((file) => file.endsWith('.ts')),
  ];
}

const SILENT_DROP_PATTERNS = [
  { pattern: /image omitted/u, label: 'Pi silent-downgrade placeholder copied into CAFF' },
  { pattern: /blockImages/u, label: 'Pi blockImages setting gated image filtering' },
  { pattern: /\.filter\([^)]*\.type\s*===\s*['"]image['"]\)/u, label: 'filtering image blocks out of a message' },
  { pattern: /\.filter\([^)]*image['"]/u, label: 'filtering images by field without block fallback' },
];

test('CAFF server code has no silent image-dropping path (AC-B3 grep guard)', () => {
  const sources = collectServerSource();
  assert.ok(sources.length > 20, `expected a substantial source tree, got ${sources.length} files`);

  const violations = [];
  for (const file of sources) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { pattern, label } of SILENT_DROP_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ file: path.relative(projectRoot, file), line: index + 1, label, text: line.trim() });
        }
      }
    });
  }

  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.label}`),
    [],
    'silent image-drop patterns must not appear in CAFF server/lib source'
  );
});

test('CAFF project does not enable Pi blockImages or image-downgrade settings', () => {
  const candidates = [
    path.join(projectRoot, 'lib', 'pi-sdk-host.mjs'),
    path.join(projectRoot, 'lib', 'pi-runtime.ts'),
    path.join(projectRoot, 'lib', 'minimal-pi.ts'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes('blockImages'), false, `${file} must not enable blockImages`);
    assert.equal(content.includes('"image omitted"'), false, `${file} must not inline the Pi downgrade placeholder`);
  }
});
