// Badcase 采集服务门面：聚合 policy / collector / restore / 容量估算。
//
// 默认 captureRoot 解析顺序：options.captureRoot → CAFF_BADCASE_CAPTURE_DIR
// → <agentDir>/badcase-capture。该目录必须在授权采集目录之外且被 gitignore。

const path = require('node:path');
import { normalizeCapturePolicy, matchesRelativePattern, pinAuthorizedDirs, pinKey } from './capture-policy';
import { createCaptureStore } from './capture-store';
import { createCollector } from './collector';
import { restoreCheckpoint } from './restore';
import { runEstimateProcess } from './estimate-process';
import { detectCaptureCapability, statxDirectoryIdentity } from './safe-read';

export function resolveCaptureRoot(options: any = {}) {
  const explicit = String(options.captureRoot || '').trim() || String(process.env.CAFF_BADCASE_CAPTURE_DIR || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const agentDir = String(options.agentDir || '').trim();
  return path.resolve(agentDir ? path.join(agentDir, 'badcase-capture') : path.join(process.cwd(), '.pi', 'badcase-capture'));
}

// 普通配置保存只保留仍列出目录的既有 pin，绝不创建新 pin（GPT 复审 #1 第六轮：
// 普通设置保存不得意外变成扩大授权的动作）。
function preserveExistingPins(existingPins: any, dirs: any) {
  const preserved: Record<string, any> = {};
  const source = existingPins && typeof existingPins === 'object' ? existingPins : {};
  const list = Array.isArray(dirs) ? dirs : [];
  for (const dir of list) {
    const key = pinKey(dir);
    if (key && (source as any)[key]) {
      preserved[key] = (source as any)[key];
    }
  }
  return preserved;
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

    // 普通配置保存：不钉住任何新对象。保留仍在清单中的目录的既有 pin；
    // 新增/变更的目录保持未钉住状态，采集按 authorized_root_unpinned 失败关闭，
    // 直到用户通过 authorizeProject 显式授权（GPT 复审 #1 第六轮）。
    savePolicy(projectId: any, policy: any) {
      const merged = { ...(policy && typeof policy === 'object' ? policy : {}), projectId };
      const existing = store.loadPolicy(projectId);
      merged.authorizedDirPins = preserveExistingPins(existing.authorizedDirPins, merged.authorizedDirs);
      merged.authorizedInputPins = preserveExistingPins(existing.authorizedInputPins, merged.authorizedInputDirs);
      return store.savePolicy(merged);
    },

    // 显式授权动作（唯一允许钉住根身份的入口）：对当前策略中的 authorizedDirs 与
    // authorizedInputDirs 固定 realpath + Linux statx 目录对象身份。采集时根被替换
    // （realpath 变化或 dev/ino/btime 不符）即拒绝；能力不可用时 identity 缺失，
    // 采集阶段按 authorized_root_identity_missing 失败关闭。
    authorizeProject(projectId: any) {
      const policy = store.loadPolicy(projectId);
      const capability = detectCaptureCapability({ captureRoot });
      const statxFn = capability.ok
        ? (dir: any) => {
          const result = statxDirectoryIdentity(capability, dir);
          return result.ok ? result.identity : null;
        }
        : null;
      return store.savePolicy(pinAuthorizedDirs({ ...policy, projectId }, { statxFn }));
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

    // HTTP management must use this bounded asynchronous entry. The sync entry
    // below remains for the child and existing offline capture tests only.
    estimateDirectoryAsync(projectId: any, targetDir: any) {
      return runEstimateProcess({ captureRoot, projectId: String(projectId || ''), targetDir: String(targetDir || '') });
    },

    // 显式授权后、开启采集前的容量预估（AC9）：只读目标元数据，不写检查点。
    // 授权与 enabled 独立；预估不能隐式授权/重新 pin 或开启主动采集。
    estimateDirectory(projectId: any, targetDir: any) {
      const startedAt = Date.now();
      const fail = (reason: string) => ({ ok: false, reason, fileCount: 0, totalBytes: 0, durationMs: Date.now() - startedAt });
      const id = String(projectId || '').trim();
      const target = String(targetDir || '').trim();
      if (!id) return fail('project_id_missing');
      if (!target) return fail('target_dir_missing');
      const policy = normalizeCapturePolicy(store.loadPolicy(id), id);
      const tree: any = collector.estimateTree(path.resolve(target), policy);
      if (!tree.ok) return fail(tree.reason || 'enumeration_failed');
      let totalBytes = 0;
      let fileCount = 0;
      for (const entry of tree.entries) {
        if (entry.path === '.git' || entry.path.endsWith('/.git') || matchesRelativePattern(entry.path, policy.excludedPatterns)) continue;
        if (entry.type === 'file') {
          fileCount += 1;
          totalBytes += entry.size;
        }
      }
      const gaps = tree.unreadableDirs.filter((gap: any) => !matchesRelativePattern(gap.path, policy.excludedPatterns));
      return {
        ok: true,
        reason: '',
        authorized: true,
        complete: gaps.length === 0,
        uncaptured: gaps,
        includesIgnored: true,
        fileCount,
        totalBytes,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
