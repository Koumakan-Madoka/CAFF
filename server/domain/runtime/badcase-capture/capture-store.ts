// Capture 存储层：内容寻址 blob 存储（CAS）+ checkpoint 清单 + CapturePolicy 持久化。
//
// 布局（captureRoot 必须位于授权采集目录之外，且整体被 gitignore）：
//   <captureRoot>/projects/<projectId>/policy.json
//   <captureRoot>/projects/<projectId>/blobs/<aa>/<sha256>
//   <captureRoot>/projects/<projectId>/checkpoints/<checkpointId>.json
//   <captureRoot>/projects/<projectId>/latest/<targetKey>.json   -> { checkpointId }
//
// 契约约束：采集失败显式记录，不伪造成功；blob 写入原子化（tmp + rename）。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
import { defaultCapturePolicy, normalizeCapturePolicy } from './capture-policy';
import { withProjectWriteLock } from './project-write-lock';

function nowIso() {
  return new Date().toISOString();
}

function safeReadJson(filePath: any, fallback: any) {
  const resolved = String(filePath || '').trim();
  if (!resolved || !fs.existsSync(resolved)) {
    return fallback;
  }
  try {
    const text = fs.readFileSync(resolved, 'utf8');
    return text.trim() ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: any, value: any) {
  const resolved = String(filePath || '').trim();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, resolved);
}

export function sha256Hex(content: any) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function sanitizeIdComponent(value: any) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
}

export function createCaptureStore(options: any = {}) {
  const captureRoot = path.resolve(String(options.captureRoot || '').trim());
  if (!captureRoot) {
    throw new Error('captureRoot is required');
  }

  function projectDir(projectId: any) {
    const id = sanitizeIdComponent(projectId);
    if (!id) {
      throw new Error('projectId is required');
    }
    return path.join(captureRoot, 'projects', id);
  }

  function blobsDir(projectId: any) {
    return path.join(projectDir(projectId), 'blobs');
  }

  function blobPath(projectId: any, hash: any) {
    const normalized = String(hash || '').trim().toLowerCase();
    return path.join(blobsDir(projectId), normalized.slice(0, 2), normalized);
  }

  function checkpointsDir(projectId: any) {
    return path.join(projectDir(projectId), 'checkpoints');
  }

  // attempt 暂存目录：位于 blobs/checkpoints 之外，computeUsage 不计入（未提交字节不算占用）。
  function stagingDir(projectId: any, stagingId: any) {
    return path.join(projectDir(projectId), 'staging', sanitizeIdComponent(stagingId));
  }

  function checkpointPath(projectId: any, checkpointId: any) {
    return path.join(checkpointsDir(projectId), `${sanitizeIdComponent(checkpointId)}.json`);
  }

  function latestKey(targetDir: any) {
    return crypto.createHash('sha256').update(path.resolve(String(targetDir || '').trim())).digest('hex').slice(0, 16);
  }

  function latestPath(projectId: any, targetDir: any) {
    return path.join(projectDir(projectId), 'latest', `${latestKey(targetDir)}.json`);
  }

  function policyPath(projectId: any) {
    return path.join(projectDir(projectId), 'policy.json');
  }

  return {
    captureRoot,

    loadPolicy(projectId: any) {
      const raw = safeReadJson(policyPath(projectId), null);
      if (!raw) {
        return defaultCapturePolicy(projectId);
      }
      return normalizeCapturePolicy(raw, projectId);
    },

    savePolicy(policy: any) {
      const normalized = normalizeCapturePolicy(policy, policy && policy.projectId);
      return withProjectWriteLock(captureRoot, normalized.projectId, () => {
        writeJsonAtomic(policyPath(normalized.projectId), { ...normalized, updatedAt: nowIso() });
        return this.loadPolicy(normalized.projectId);
      });
    },

    hasBlob(projectId: any, hash: any) {
      return fs.existsSync(blobPath(projectId, hash));
    },

    blobSize(projectId: any, hash: any) {
      try {
        return fs.statSync(blobPath(projectId, hash)).size;
      } catch {
        return 0;
      }
    },

    // 原子写入；已存在同 hash blob 时跳过（内容寻址去重）。返回是否新写入。
    writeBlob(projectId: any, hash: any, content: any) {
      const target = blobPath(projectId, hash);
      if (fs.existsSync(target)) {
        const existing = fs.statSync(target);
        if (existing.size === content.length) {
          return { written: false, path: target, bytes: 0 };
        }
        throw new Error(`blob hash collision or corruption at ${target}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmpPath = `${target}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, target);
      return { written: true, path: target, bytes: content.length };
    },

    readBlob(projectId: any, hash: any) {
      const target = blobPath(projectId, hash);
      if (!fs.existsSync(target)) {
        return null;
      }
      return fs.readFileSync(target);
    },

    // ---- 逐 attempt 暂存（GPT 复审 #1）----
    // 采集 attempt 期间读到的 blob 先写入 staging，只有 attempt 通过根身份复检与一致性
    // 定级后才原子 rename 提交进 CAS；重试/失败整体回滚。即使读取链路的残余竞态被赢下，
    // 越权内容也只能到达 staging，绝不持久化进 CAS。

    stageBlob(projectId: any, stagingId: any, hash: any, content: any) {
      const dir = stagingDir(projectId, stagingId);
      fs.mkdirSync(dir, { recursive: true });
      const normalized = String(hash || '').trim().toLowerCase();
      const target = path.join(dir, normalized);
      if (fs.existsSync(target)) {
        if (fs.statSync(target).size === content.length) {
          return { written: false, path: target, bytes: 0 };
        }
        throw new Error(`staged blob hash collision at ${target}`);
      }
      const tmpPath = `${target}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, target);
      return { written: true, path: target, bytes: content.length };
    },

    // 提交：暂存 blob 原子 rename 进 CAS（同卷）；已存在同尺寸 blob 时按内容寻址去重跳过。
    commitStaging(projectId: any, stagingId: any) {
      const dir = stagingDir(projectId, stagingId);
      if (!fs.existsSync(dir)) {
        return;
      }
      for (const name of fs.readdirSync(dir)) {
        if (name.includes('.tmp-')) {
          continue;
        }
        const source = path.join(dir, name);
        if (!fs.statSync(source).isFile()) {
          continue;
        }
        const target = blobPath(projectId, name);
        if (fs.existsSync(target)) {
          if (fs.statSync(target).size !== fs.statSync(source).size) {
            throw new Error(`blob hash collision or corruption at ${target}`);
          }
          continue; // 内容寻址去重：CAS 已有同 hash blob
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      // 父目录空了就一并清掉，不留空壳。
      try { fs.rmdirSync(path.dirname(dir)); } catch {}
    },

    rollbackStaging(projectId: any, stagingId: any) {
      const dir = stagingDir(projectId, stagingId);
      fs.rmSync(dir, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(dir)); } catch {}
    },

    saveCheckpoint(projectId: any, checkpoint: any) {
      writeJsonAtomic(checkpointPath(projectId, checkpoint.checkpointId), checkpoint);
      return checkpoint;
    },

    loadCheckpoint(projectId: any, checkpointId: any) {
      return safeReadJson(checkpointPath(projectId, checkpointId), null);
    },

    listCheckpoints(projectId: any) {
      const dir = checkpointsDir(projectId);
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs.readdirSync(dir)
        .filter((name: any) => name.endsWith('.json') && !name.includes('.tmp-'))
        .map((name: any) => safeReadJson(path.join(dir, name), null))
        .filter(Boolean)
        .sort((a: any, b: any) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    },

    saveCaptureResult(projectId: any, result: any) {
      return withProjectWriteLock(captureRoot, projectId, () => {
        writeJsonAtomic(path.join(projectDir(projectId), 'last-capture.json'), result);
      });
    },

    loadCaptureResult(projectId: any) {
      return safeReadJson(path.join(projectDir(projectId), 'last-capture.json'), null);
    },

    saveLatestCheckpointId(projectId: any, targetDir: any, checkpointId: any) {
      writeJsonAtomic(latestPath(projectId, targetDir), {
        targetDir: path.resolve(String(targetDir || '').trim()),
        checkpointId: String(checkpointId || '').trim(),
        updatedAt: nowIso(),
      });
    },

    // latest 指针当前落盘字节数（不存在为 0），用于采集自报新增字节的精确核算。
    latestPointerSize(projectId: any, targetDir: any) {
      try {
        return fs.statSync(latestPath(projectId, targetDir)).size;
      } catch {
        return 0;
      }
    },

    // latest 指针写入后的预期字节数。updatedAt 为定长 ISO 字符串，checkpointId 为定长
    // UUID，因此对同一 (project, targetDir) 该值恒定，可在写入前精确预估。
    latestPointerJsonSize(projectId: any, targetDir: any, checkpointId: any) {
      const text = `${JSON.stringify({
        targetDir: path.resolve(String(targetDir || '').trim()),
        checkpointId: String(checkpointId || '').trim(),
        updatedAt: nowIso(),
      }, null, 2)}\n`;
      return Buffer.byteLength(text, 'utf8');
    },

    loadLatestCheckpoint(projectId: any, targetDir: any) {
      const pointer = safeReadJson(latestPath(projectId, targetDir), null);
      if (!pointer || !pointer.checkpointId) {
        return null;
      }
      return this.loadCheckpoint(projectId, pointer.checkpointId);
    },

    // Committed logical file bytes, NOT physical allocation/free space. CAS is
    // counted once by stored object; copied reference metadata costs extra.
    // Policy, staging and unpublished .tmp-* files remain outside this scope.
    // This synchronous inventory is not an atomic snapshot, quota reservation
    // or GC authorization. Storage ancestors remain same-OS-user trusted TCB.
    computeUsage(projectId: any) {
      const bytesByKind = { blobs: 0, checkpoints: 0, latest: 0, flags: 0, retention: 0, cases: 0, runReferences: 0 };
      let blobCount = 0;
      const unavailable = () => Object.assign(new Error('capture_usage_unavailable'), { code: 'capture_usage_unavailable' });
      try {
        for (const kind of Object.keys(bytesByKind) as (keyof typeof bytesByKind)[]) {
          const directory = path.join(projectDir(projectId), kind);
          let rootStat;
          try { rootStat = fs.lstatSync(directory); }
          catch (failure: any) { if (failure.code === 'ENOENT') continue; throw failure; }
          // Reject static links and special files; not a same-user path-swap
          // defense. Never follow a linked category into a different tree.
          if (!rootStat.isDirectory()) throw unavailable();
          const pending = [directory];
          while (pending.length) {
            const current = pending.pop()!;
            if (!fs.lstatSync(current).isDirectory()) throw unavailable();
            for (const name of fs.readdirSync(current)) {
              if (name.includes('.tmp-')) continue;
              const entryPath = path.join(current, name);
              // An entry disappearing after enumeration is an incomplete
              // inventory, not an empty directory or a zero-byte file.
              const stat = fs.lstatSync(entryPath);
              if (stat.isDirectory()) { pending.push(entryPath); continue; }
              if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw unavailable();
              bytesByKind[kind] += stat.size;
              if (!Number.isSafeInteger(bytesByKind[kind])) throw unavailable();
              if (kind === 'blobs') blobCount++;
            }
          }
        }
        const totalBytes = Object.values(bytesByKind).reduce((sum, value) => sum + value, 0);
        if (!Number.isSafeInteger(totalBytes)) throw unavailable();
        return { blobCount, totalBytes, bytesByKind };
      } catch { throw unavailable(); }
    },
  };
}
