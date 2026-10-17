// Regenerate audited Python sources as exact LF-normalized embedded TS copies.
// Run after editing either helper and commit source + generated copy together.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..', '..');
for (const [file, target, prefix] of [
  ['capture_helper.py', 'helper-source.ts', 'HELPER'],
  ['windows_read.py', 'windows-helper-source.ts', 'WINDOWS_HELPER'],
]) {
  const sourcePath = path.join(repoRoot, 'helpers', 'badcase-capture', file);
  const targetPath = path.join(repoRoot, 'server', 'domain', 'runtime', 'badcase-capture', target);
  const src = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
  const sha = crypto.createHash('sha256').update(src, 'utf8').digest('hex');
  // Keep the legacy Linux comment format byte-stable, but generate both
  // headers deterministically from source (never preserve a stale hash).
  const header = prefix === 'HELPER'
    ? '// 由 helpers/badcase-capture/capture_helper.py 生成的内嵌副本（审计源文件以仓库内 .py 为准）。\n'
      + '// 重新生成：node scripts/badcase-capture/embed-helper.js\n' + `// 源码 SHA-256：${sha}\n`
    : `// Generated from helpers/badcase-capture/${file}; audit the Python source.\n`
      + '// Regenerate: node scripts/badcase-capture/embed-helper.js\n' + `// SHA-256: ${sha}\n`;
  const out = header + `export const ${prefix}_PROTOCOL_VERSION = 1;\n`
    + `export const ${prefix}_SOURCE_SHA256 = ${JSON.stringify(sha)};\n`
    + `export const ${prefix}_SOURCE = ${JSON.stringify(src)};\n`;
  fs.writeFileSync(targetPath, out);
  console.log(`embedded ${file} -> ${target} (sha256 ${sha})`);
}
