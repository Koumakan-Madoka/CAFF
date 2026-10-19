// Badcase 采集服务门面：聚合 policy / collector / restore / 容量估算。
//
// 默认 captureRoot 解析顺序：options.captureRoot → CAFF_BADCASE_CAPTURE_DIR
// → <agentDir>/badcase-capture。该目录必须在授权采集目录之外且被 gitignore。

const path = require('node:path');
import { normalizeCapturePolicy, matchesRelativePattern, pinAuthorizedDirs, pinKey } from './capture-policy';
import { createCaptureStore } from './capture-store';
import { createCollector } from './collector';
import { createWindowsTurnCollector } from './windows-turn-collector';
import { restoreCheckpoint } from './restore';
import { runEstimateProcess } from './estimate-process';
import { detectCaptureCapability, statxDirectoryIdentity } from './safe-read';
import { prepareWindowsAuthorization } from './windows-authorization';
import { invokeWindowsHelper } from './windows-helper';
import { estimateWindowsDirectory, estimateWindowsDirectoryAsync } from './windows-estimate';
import { readPreTurnCallbackInput } from './callback-source';

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
  // Constructor-owned source handle only; never accept DB/path/source bytes
  // from an invocation. Collectors invoke this after file-root authorization
  // and while holding their project policy lease. Null is an explicit gap.
  const sourceStore = options.chatStore;
  const readCallbackInput = (input: any, policy: any) => readPreTurnCallbackInput(sourceStore, input, policy);
  const collector = createCollector({
    store, readCallbackInput,
    trustMtime: options.trustMtime,
    afterScan: typeof options.afterScan === 'function' ? options.afterScan : null,
    afterFirstScan: typeof options.afterFirstScan === 'function' ? options.afterFirstScan : null,
    onFileRead: typeof options.onFileRead === 'function' ? options.onFileRead : null,
  });

  // One constructor-owned trusted Windows scope for preview AND collection.
  // Do not borrow mutable caller options across requests/awaits. Linux retains
  // its original path and does not consume Windows-only private-root settings.
  const windowsScope = process.platform === 'win32'
    ? { agentDir: options.agentDir, privateDirs: structuredClone(options.privateDirs === undefined ? [] : options.privateDirs) }
    : null;
  // No enable bypass: Windows estimate still advertises captureAvailable=false.
  // Selection is host-platform explicit, never a failed-Windows fallback to Linux.
  const turnCollector = windowsScope
    ? createWindowsTurnCollector({ store, readCallbackInput, ...windowsScope }) : collector;

  return {
    captureRoot,
    store,

    loadPolicy(projectId: any) {
      return store.loadPolicy(projectId);
    },

    // 普通配置保存：不钉住任何新对象。保留仍在清单中的目录的既有 pin；
    // 新增/变更的目录保持未钉住状态，采集按 authorized_root_unpinned 失败关闭，
    // 直到用户通过 authorizeProject 显式授权（GPT 复审 #1 第六轮）。
    savePolicy(projectId: any, policy: any, consent: any = {}) {
      const merged = { ...(policy && typeof policy === 'object' ? policy : {}), projectId };
      const existing = store.loadPolicy(projectId);
      merged.authorizedDirPins = preserveExistingPins(existing.authorizedDirPins, merged.authorizedDirs);
      merged.authorizedInputPins = preserveExistingPins(existing.authorizedInputPins, merged.authorizedInputDirs);
      // Only the explicit local-admin authorize action may replace this scope.
      // Ordinary save ignores caller-supplied grants AND revocations.
      merged.callbackInputAuthorized = typeof consent.authorizeCallbackInput === 'boolean'
        ? consent.authorizeCallbackInput : existing.callbackInputAuthorized;
      const normalized = normalizeCapturePolicy(merged, projectId);
      if (normalized.callbackInputAuthorized !== existing.callbackInputAuthorized
        || JSON.stringify(normalized.windowsExternalGit) !== JSON.stringify(existing.windowsExternalGit)) {
        normalized.status = 'disabled'; normalized.suspendReason = '';
      }
      return store.savePolicy(normalized);
    },

    // 显式授权动作（唯一允许钉住根身份的入口）：对当前策略中的 authorizedDirs 与
    // authorizedInputDirs 固定目录对象身份。Linux: realpath + statx；Windows:
    // literal path + native NT identity (no junction resolution/fallback).
    // Windows authorization always leaves capture disabled. Its separate
    // metadata preview cannot issue an enable receipt; collector stays closed.
    authorizeProject(projectId: any) {
      const policy = store.loadPolicy(projectId);
      if (process.platform === 'win32') {
        const runtime = prepareWindowsAuthorization({ captureRoot });
        const nativeIdentityFn = (dir: any) => {
          if (!runtime.ok) return null;
          const result = invokeWindowsHelper(runtime.python, runtime.helperPath, { version: 1, op: 'identity', root: dir });
          return result.ok ? result.identity : null;
        };
        const saved = store.savePolicy(pinAuthorizedDirs({ ...policy, projectId, status: 'disabled', suspendReason: '' }, { nativeIdentityFn }));
        const allPinned = saved.authorizedDirs.every((dir: any) => saved.authorizedDirPins[pinKey(dir)]?.identity)
          && saved.authorizedInputDirs.every((dir: any) => saved.authorizedInputPins[pinKey(dir)]?.identity);
        // Persist disabled/cleared pins first, but never report an unsupported
        // native root or runtime as successful authorization to management UI.
        if (!runtime.ok || !allPinned) {
          const code = runtime.ok ? 'windows_authorization_root_rejected' : 'windows_authorization_unavailable';
          throw Object.assign(new Error('Windows capture authorization unavailable'), { code });
        }
        return saved;
      }
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
      return turnCollector.captureTurnCheckpoint(input);
    },

    restoreCheckpoint(input: any) {
      return restoreCheckpoint({ ...input, store });
    },

    computeUsage(projectId: any) {
      return store.computeUsage(projectId);
    },

    // HTTP management must use this bounded asynchronous entry. Windows starts
    // one audited, no-descendant Python metadata helper directly (no Linux
    // process-group approximation); Linux retains its isolated estimate worker.
    // The sync entry below is for workers/offline capture tests only.
    async estimateDirectoryAsync(projectId: any, targetDir: any) {
      if (process.platform === 'win32') {
        const start = Date.now();
        const id = String(projectId || '').trim(), target = String(targetDir || '').trim();
        if (!id || !target) return { ok: false, reason: !id ? 'project_id_missing' : 'target_dir_missing',
          fileCount: 0, totalBytes: 0, durationMs: Date.now() - start };
        const result = await estimateWindowsDirectoryAsync({ captureRoot, ...windowsScope,
          targetDir: target, policy: store.loadPolicy(id) });
        return { ...result, durationMs: Date.now() - start };
      }
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
      if (process.platform === 'win32') {
        return { ...estimateWindowsDirectory({ captureRoot, ...windowsScope, targetDir: target, policy }),
          durationMs: Date.now() - startedAt };
      }
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
