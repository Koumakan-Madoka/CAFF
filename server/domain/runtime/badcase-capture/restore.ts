// 检查点恢复与清单校验（契约 §2.2/AC2）。
//
// - 恢复只写调用方给定的空目标目录；secretExcluded 文件不落盘并计入 missingSecrets。
// - 恢复后重扫目标目录，逐文件比对 hash 与清单；任何不一致 → ok=false，不冒充一致。
// - 连续两次恢复同一 checkpoint 必须得到相同清单（由测试断言）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256File(filePath: any) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeJoin(root: any, relativePath: any) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export function restoreCheckpoint(options: any = {}) {
  const store = options.store;
  const projectId = String(options.projectId || '').trim();
  const checkpointId = String(options.checkpointId || '').trim();
  const targetDir = path.resolve(String(options.targetDir || '').trim() || '.');

  const fail = (reason: any, extra: any = {}) => ({ ok: false, reason, mismatches: [], missingSecrets: [], ...extra });

  const checkpoint = store && store.loadCheckpoint(projectId, checkpointId);
  if (!checkpoint) {
    return fail('checkpoint_not_found');
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const preexisting = fs.readdirSync(targetDir);
  if (preexisting.length > 0) {
    return fail('target_dir_not_empty');
  }

  const files = checkpoint.files && typeof checkpoint.files === 'object' ? checkpoint.files : {};
  const missingSecrets: string[] = [];
  const mismatches: any[] = [];

  for (const relativePath of Object.keys(files).sort()) {
    const entry = files[relativePath];
    if (entry.secretExcluded === true) {
      missingSecrets.push(relativePath);
      continue;
    }
    const destination = safeJoin(targetDir, relativePath);
    if (!destination) {
      mismatches.push({ path: relativePath, reason: 'path_escapes_target' });
      continue;
    }
    if (entry.type === 'symlink') {
      if (entry.escapes === true || !entry.linkTarget) {
        mismatches.push({ path: relativePath, reason: 'symlink_escape_not_restored' });
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.symlinkSync(entry.linkTarget, destination);
      } catch (error: any) {
        mismatches.push({ path: relativePath, reason: `symlink_failed: ${error && error.message ? error.message : error}` });
      }
      continue;
    }
    const content = store.readBlob(projectId, entry.hash);
    if (!content) {
      mismatches.push({ path: relativePath, reason: 'blob_missing' });
      continue;
    }
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    if (actualHash !== entry.hash) {
      mismatches.push({ path: relativePath, reason: 'blob_hash_mismatch' });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
    try {
      fs.chmodSync(destination, entry.mode);
    } catch {}
  }

  // 恢复后重扫校验：清单内每个非排除文件都必须存在且 hash 一致。
  const verification = verifyRestoredDirectory({ checkpoint, targetDir });
  mismatches.push(...verification.mismatches);

  return {
    ok: mismatches.length === 0,
    reason: mismatches.length === 0 ? '' : 'restore_mismatch',
    checkpointId,
    mismatches,
    missingSecrets,
    restoredFiles: verification.restoredFiles,
    uncapturedInScope: Array.isArray(checkpoint.uncaptured) ? checkpoint.uncaptured : [],
    replayInputComplete: checkpoint.replayInput?.complete === true
      && (!checkpoint.uncaptured || checkpoint.uncaptured.length === 0)
      && mismatches.length === 0 && missingSecrets.length === 0,
    strictEvalEligible: checkpoint.strictEvalEligible === true && checkpoint.replayInput?.complete === true
      && (!checkpoint.uncaptured || checkpoint.uncaptured.length === 0)
      && mismatches.length === 0 && missingSecrets.length === 0,
  };
}

export function verifyRestoredDirectory(options: any = {}) {
  const checkpoint = options.checkpoint;
  const targetDir = path.resolve(String(options.targetDir || '').trim() || '.');
  const files = checkpoint && checkpoint.files && typeof checkpoint.files === 'object' ? checkpoint.files : {};
  const mismatches: any[] = [];
  const restoredFiles: any = {};

  for (const relativePath of Object.keys(files)) {
    const entry = files[relativePath];
    if (entry.secretExcluded === true) {
      continue;
    }
    const destination = safeJoin(targetDir, relativePath);
    if (!destination || !fs.existsSync(destination)) {
      mismatches.push({ path: relativePath, reason: 'restored_file_missing' });
      continue;
    }
    if (entry.type === 'symlink') {
      try {
        const actual = fs.readlinkSync(destination).replace(/\\/g, '/');
        restoredFiles[relativePath] = `symlink:${actual}`;
        if (actual !== entry.linkTarget) {
          mismatches.push({ path: relativePath, reason: 'symlink_target_mismatch' });
        }
      } catch (error: any) {
        mismatches.push({ path: relativePath, reason: `symlink_verify_failed: ${error && error.message ? error.message : error}` });
      }
      continue;
    }
    const hash = sha256File(destination);
    restoredFiles[relativePath] = hash;
    if (hash !== entry.hash) {
      mismatches.push({ path: relativePath, reason: 'restored_hash_mismatch' });
    }
  }

  return { mismatches, restoredFiles };
}
