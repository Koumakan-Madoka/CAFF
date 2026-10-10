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
      writeJsonAtomic(policyPath(normalized.projectId), { ...normalized, updatedAt: nowIso() });
      return this.loadPolicy(normalized.projectId);
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

    saveLatestCheckpointId(projectId: any, targetDir: any, checkpointId: any) {
      writeJsonAtomic(latestPath(projectId, targetDir), {
        targetDir: path.resolve(String(targetDir || '').trim()),
        checkpointId: String(checkpointId || '').trim(),
        updatedAt: nowIso(),
      });
    },

    loadLatestCheckpoint(projectId: any, targetDir: any) {
      const pointer = safeReadJson(latestPath(projectId, targetDir), null);
      if (!pointer || !pointer.checkpointId) {
        return null;
      }
      return this.loadCheckpoint(projectId, pointer.checkpointId);
    },

    // 项目当前 CAS 占用（遍历统计；W3 配额/GC 会加缓存）。
    computeUsage(projectId: any) {
      const dir = blobsDir(projectId);
      let totalBytes = 0;
      let blobCount = 0;
      const walk = (current: any) => {
        if (!fs.existsSync(current)) {
          return;
        }
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            walk(entryPath);
          } else if (entry.isFile() && !entry.name.includes('.tmp-')) {
            blobCount += 1;
            totalBytes += fs.statSync(entryPath).size;
          }
        }
      };
      walk(dir);
      return { blobCount, totalBytes };
    },
  };
}
