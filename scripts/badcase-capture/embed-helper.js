// 从 helpers/badcase-capture/capture_helper.py 重新生成内嵌 TS 副本。
// 用法：node scripts/badcase-capture/embed-helper.js（修改 .py 后必须运行并提交两者）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(repoRoot, 'helpers', 'badcase-capture', 'capture_helper.py');
const targetPath = path.join(repoRoot, 'server', 'domain', 'runtime', 'badcase-capture', 'helper-source.ts');

const src = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const sha = crypto.createHash('sha256').update(src, 'utf8').digest('hex');
const out = '// 由 helpers/badcase-capture/capture_helper.py 生成的内嵌副本（审计源文件以仓库内 .py 为准）。\n'
  + '// 重新生成：node scripts/badcase-capture/embed-helper.js\n'
  + `// 源码 SHA-256：${sha}\n`
  + 'export const HELPER_PROTOCOL_VERSION = 1;\n'
  + `export const HELPER_SOURCE_SHA256 = ${JSON.stringify(sha)};\n`
  + `export const HELPER_SOURCE = ${JSON.stringify(src)};\n`;
fs.writeFileSync(targetPath, out);
console.log(`embedded ${sourcePath} -> ${targetPath} (sha256 ${sha})`);
