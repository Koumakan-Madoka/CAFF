// Badcase 采集服务门面：聚合 policy / collector / restore / 容量估算。
//
// 默认 captureRoot 解析顺序：options.captureRoot → CAFF_BADCASE_CAPTURE_DIR
// → <agentDir>/badcase-capture。该目录必须在授权采集目录之外且被 gitignore。

const fs = require('node:fs');
const path = require('node:path');
import { normalizeCapturePolicy, isAuthorizedDir, matchesRelativePattern } from './capture-policy';
import { createCaptureStore } from './capture-store';
import { createCollector } from './collector';
import { restoreCheckpoint } from './restore';

export function resolveCaptureRoot(options: any = {}) {
  const explicit = String(options.captureRoot || '').trim() || String(process.env.CAFF_BADCASE_CAPTURE_DIR || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const agentDir = String(options.agentDir || '').trim();
  return path.resolve(agentDir ? path.join(agentDir, 'badcase-capture') : path.join(process.cwd(), '.pi', 'badcase-capture'));
}

export function createBadcaseCaptureService(options: any = {}) {
  const captureRoot = resolveCaptureRoot(options);
  const store = createCaptureStore({ captureRoot });
  const collector = createCollector({
    store,
    trustMtime: options.trustMtime,
    afterScan: typeof options.afterScan === 'function' ? options.afterScan : null,
    afterFirstScan: typeof options.afterFirstScan === 'function' ? options.afterFirstScan : null,
    onFileRead: typeof options.onFileRead === 'function' ? options.onFileRead : null,
  });

  return {
    captureRoot,
    store,

    loadPolicy(projectId: any) {
      return store.loadPolicy(projectId);
    },

    savePolicy(projectId: any, policy: any) {
      return store.savePolicy({ ...(policy && typeof policy === 'object' ? policy : {}), projectId });
    },

    captureTurnCheckpoint(input: any) {
      return collector.captureTurnCheckpoint(input);
    },

    restoreCheckpoint(input: any) {
      return restoreCheckpoint({ ...input, store });
    },

    computeUsage(projectId: any) {
      return store.computeUsage(projectId);
    },

    // 开启采集前的容量预估（AC9）：stat-only 扫描，不读取内容、不落盘。
    estimateDirectory(projectId: any, targetDir: any) {
      const startedAt = Date.now();
      const policy = normalizeCapturePolicy(this.loadPolicy(projectId), projectId);
      const resolved = path.resolve(String(targetDir || '').trim() || '.');
      const emptyPolicy = { ...policy, includedIgnoredPatterns: [] };
      if (!fs.existsSync(resolved)) {
        return { ok: false, reason: 'target_dir_missing', fileCount: 0, totalBytes: 0, durationMs: Date.now() - startedAt };
      }
      const effectivePolicy = {
        ...emptyPolicy,
        // 预估按“假设已授权该目录”统计；未授权时仍返回结果并标注，便于开启前展示。
        authorized: isAuthorizedDir(policy, resolved),
      };
      const candidates = collector.listCandidatePaths(resolved, effectivePolicy);
      let totalBytes = 0;
      let fileCount = 0;
      for (const relativePath of candidates) {
        if (matchesRelativePattern(relativePath, effectivePolicy.excludedPatterns)) {
          continue;
        }
        try {
          const stat = fs.lstatSync(path.join(resolved, relativePath));
          if (stat.isFile()) {
            fileCount += 1;
            totalBytes += stat.size;
          }
        } catch {}
      }
      return {
        ok: true,
        reason: '',
        authorized: effectivePolicy.authorized,
        fileCount,
        totalBytes,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
