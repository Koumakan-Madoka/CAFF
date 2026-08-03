import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] || '').trim();
    const value = String(argv[index + 1] || '').trim();
    if (!key.startsWith('--') || !value) {
      throw new Error('invalid backup arguments');
    }
    values.set(key.slice(2), value);
  }
  return values;
}

async function main() {
  const args = readArguments(process.argv.slice(2));
  const sourcePath = path.resolve(args.get('source') || '');
  const targetPath = path.resolve(args.get('target') || '');
  if (!fs.statSync(sourcePath).isFile() || fs.existsSync(targetPath)) {
    throw new Error('backup source or target is invalid');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(targetPath);
    fs.chmodSync(targetPath, 0o600);
  } catch (error) {
    try {
      fs.rmSync(targetPath, { force: true });
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
