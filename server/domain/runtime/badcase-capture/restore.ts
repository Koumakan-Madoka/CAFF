// 检查点恢复与清单校验（契约 §2.2/AC2）。
//
// - 恢复只写调用方给定的空目标目录；secretExcluded 文件不落盘并计入 missingSecrets。
// - 恢复后重扫目标目录，逐文件比对 hash 与清单；任何不一致 → ok=false，不冒充一致。
// - 连续两次恢复同一 checkpoint 必须得到相同清单（由测试断言）。

import { isSafeRelativePath } from './replay-path';
import { materializeGitSnapshot, snapshotSkillLocation } from './git-snapshot-materialization';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256File(filePath: any) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeJoin(root: any, relativePath: any) {
  if (!isSafeRelativePath(relativePath)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

// Resolve even not-yet-created destinations through their nearest existing
// ancestor. Inspect every existing component too: a lexical child of an empty
// target may otherwise be reached through a source-pointing symlink/junction.
// These are preflight checks, not protection against concurrent replacement.
function inspectRestorePath(value: string, rejectLinks = false) {
  const absolute = path.resolve(value), suffix: string[] = [];
  let current = absolute, existing = '', linked = false;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (!existing) existing = current;
      if (stat.isSymbolicLink()) linked = true;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      if (!existing) suffix.unshift(path.basename(current));
    }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  // A dangling link must be refused too, without trying to resolve its target.
  return { linked, realPath: linked && rejectLinks ? absolute : path.resolve(fs.realpathSync(existing), ...suffix) };
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
  if (checkpoint.schemaVersion === 2) return restoreGitSnapshotCheckpoint(options, checkpoint, targetDir);

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
    // Hash verification concerns archived bytes, not byte equality with the
    // original source. Legacy excluded files remain missing; never fabricate.
    redactedFiles: Object.keys(files).filter(p => files[p].secretRedacted === true).sort().map(p => ({
      path: p, byteIdenticalToSource: false, originalSize: files[p].originalSize,
      restoredSize: files[p].size, redactionCount: files[p].redactionCount,
    })),
    uncapturedInScope: Array.isArray(checkpoint.uncaptured) ? checkpoint.uncaptured : [],
    replayInputComplete: checkpoint.replayInput?.complete === true
      && (!checkpoint.uncaptured || checkpoint.uncaptured.length === 0)
      && mismatches.length === 0 && missingSecrets.length === 0,
    strictEvalEligible: checkpoint.strictEvalEligible === true && checkpoint.replayInput?.complete === true
      && (!checkpoint.uncaptured || checkpoint.uncaptured.length === 0)
      && mismatches.length === 0 && missingSecrets.length === 0,
  };
}

function restoreGitSnapshotCheckpoint(options: any, checkpoint: any, targetDir: string) {
  const fail = (reason: string) => ({ ok: false, reason, mismatches: [], missingSecrets: [] });
  try {
    const skillRoots = checkpoint.gitSnapshot?.projectSkills || [];
    const skills = skillRoots.map((s: any) => ({ ...s, ...snapshotSkillLocation(checkpoint.targetDir, s.originalPath) }));
    const external = skills.some((s: any) => !s.internal);
    if (external && !options.projectSkillsDir) return fail('project_skills_target_required');
    const skillDir = options.projectSkillsDir ? path.resolve(options.projectSkillsDir) : '';
    const destinations = [targetDir, ...(skillDir ? [skillDir] : [])].map(dest => inspectRestorePath(dest, true));
    if (destinations.some(dest => dest.linked)) return fail('restore_target_linked_ancestor');
    const sources = [checkpoint.targetDir, checkpoint.gitSnapshot.sourceRepository, checkpoint.gitSnapshot.commonDir, ...skillRoots.map((s: any) => s.originalPath)]
      .filter(Boolean).map(source => inspectRestorePath(source).realPath);
    for (const { realPath: dest } of destinations) {
      if (sources.some(source => { const rel = path.relative(source, dest); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); })) {
        return fail('restore_target_overlaps_source');
      }
      if (fs.existsSync(dest) && (fs.lstatSync(dest).isSymbolicLink() || !fs.lstatSync(dest).isDirectory() || fs.readdirSync(dest).length)) return fail('target_dir_not_empty');
    }
    // Keep the two writable roots disjoint; no private helper directories are
    // allowed to pollute a restored project tree or overwrite source paths.
    if (skillDir) {
      const rel = path.relative(destinations[0].realPath, destinations[1].realPath), back = path.relative(destinations[1].realPath, destinations[0].realPath);
      if (!rel || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
        || !back.startsWith('..' + path.sep) && back !== '..' && !path.isAbsolute(back)) return fail('restore_targets_overlap');
    }
    // Validate/read all detached inputs before the first caller-target write.
    const materialized = materializeGitSnapshot({ ...options, checkpoint });
    const writeFiles = (root: string, files: any) => {
      fs.mkdirSync(root, { recursive: true });
      for (const [name, entry] of Object.entries(files) as any[]) {
        const dest = safeJoin(root, name); if (!dest) throw Error();
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, entry.content);
        try { fs.chmodSync(dest, entry.mode); } catch {}
      }
    };
    writeFiles(targetDir, materialized.files);
    const verification = verifyRestoredDirectory({ checkpoint: { files: materialized.files }, targetDir });
    const projectSkills = materialized.projectSkills.map((skill: any) => {
      const restoredPath = path.join(skill.internal ? targetDir : skillDir, skill.relativePath);
      if (!skill.internal && Object.keys(skill.files).length) {
        const directory = skill.rootKind === 'file' ? path.dirname(restoredPath) : restoredPath;
        writeFiles(directory, skill.files);
        verification.mismatches.push(...verifyRestoredDirectory({ checkpoint: { files: skill.files }, targetDir: directory }).mismatches);
      }
      return { originalPath: skill.originalPath, restoredPath, rootKind: skill.rootKind, fileCount: Object.keys(skill.files).length };
    });
    return { ok: verification.mismatches.length === 0, reason: verification.mismatches.length ? 'restore_mismatch' : '',
      checkpointId: checkpoint.checkpointId, sourceHead: materialized.sourceHead, mismatches: verification.mismatches, missingSecrets: [],
      restoredFiles: verification.restoredFiles, redactedFiles: materialized.redactedFiles, projectSkills, lineEndingEvidence: materialized.lineEndingEvidence,
      uncapturedInScope: materialized.uncaptured, replayInputComplete: checkpoint.replayInput?.complete === true && materialized.lineEndingEvidence === 'captured-eol'
        && !materialized.uncaptured.length && !verification.mismatches.length,
      strictEvalEligible: false };
  } catch (error: any) {
    return fail(/^git_snapshot_[a-z_]+$/.test(error?.code || '') ? error.code : 'git_snapshot_restore_failed');
  }
}

export function verifyRestoredDirectory(options: any = {}) {
  const checkpoint = options.checkpoint;
  if (checkpoint?.schemaVersion === 2) return { mismatches: [{ path: '.', reason: 'git_snapshot_requires_head_materialization' }], restoredFiles: {} };
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
