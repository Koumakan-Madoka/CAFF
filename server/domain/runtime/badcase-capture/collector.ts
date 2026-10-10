// Turn 执行前检查点采集器（契约 §2）。
//
// 流程：授权检查 → 首次扫描 M1 → 秘密哨兵扫描并写 CAS（写时重校 hash）
// → 二次扫描 M2 → 一致性定级 → 回放输入归档（fresh prompt / resume session）
// → 配额预检 → 落盘清单。
//
// 诚实性约束：
// - 秘密命中内容在内存中处理，绝不先写 CAS 再脱敏。
// - 双扫一致只记为 double-scan-stable（有依据），不宣称原子快照；
//   检测到变化则降级 write-during-capture 并阻断严格对照资格。
// - resume 缺 session → complete=false，禁止静默降级 fresh。
// - 配额不足 / 写盘失败 → 策略转 suspended，返回失败，不伪造检查点。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
import { isAuthorizedDir, matchesRelativePattern } from './capture-policy';
import { containsSecretSentinel, replaceControlledVariables } from './secrets';

function sha256Buffer(content: any) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

const MAX_SECRET_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_CONSISTENCY_RETRIES = 2;

function isGitWorkTree(targetDir: any) {
  try {
    const out = execFileSync('git', ['-C', targetDir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '').trim() === 'true';
  } catch {
    return false;
  }
}

function gitListFiles(targetDir: any, extraArgs: any) {
  const out = execFileSync(
    'git',
    ['-C', targetDir, 'ls-files', '-z', ...extraArgs],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return Buffer.from(out)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

// 候选文件清单：tracked + 未被 ignore 的 untracked；includedIgnoredPatterns 命中的
// ignored 文件显式追加。非 git 目录回退为全量遍历（排除 excludedPatterns）。
export function listCandidatePaths(targetDir: any, policy: any) {
  const excluded = policy && Array.isArray(policy.excludedPatterns) ? policy.excludedPatterns : [];
  const includedIgnored = policy && Array.isArray(policy.includedIgnoredPatterns) ? policy.includedIgnoredPatterns : [];
  let candidates: string[] = [];

  if (isGitWorkTree(targetDir)) {
    candidates = gitListFiles(targetDir, ['-c', '-o', '--exclude-standard']);
    if (includedIgnored.length > 0) {
      try {
        const ignored = gitListFiles(targetDir, ['-o', '-i', '--exclude-standard', '--', ...includedIgnored]);
        const seen = new Set(candidates);
        for (const entry of ignored) {
          if (!seen.has(entry)) {
            seen.add(entry);
            candidates.push(entry);
          }
        }
      } catch {
        // 显式纳入清单匹配失败不阻断主清单；记录为空即可。
      }
    }
  } else {
    const walk = (relativeDir: any) => {
      const absoluteDir = relativeDir ? path.join(targetDir, relativeDir) : targetDir;
      for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (matchesRelativePattern(relativePath, excluded)) {
          continue;
        }
        if (entry.isDirectory()) {
          walk(relativePath);
        } else {
          candidates.push(relativePath);
        }
      }
    };
    walk('');
  }

  return candidates
    .map((entry: any) => String(entry || '').replace(/\\/g, '/'))
    .filter((entry: any) => entry && !matchesRelativePattern(entry, excluded))
    .sort();
}

function lstatEntry(targetDir: any, relativePath: any) {
  const absolutePath = path.join(targetDir, relativePath);
  try {
    return { absolutePath, stat: fs.lstatSync(absolutePath) };
  } catch {
    return { absolutePath, stat: null };
  }
}

// 符号链接：越界目标不跟随、不读取；界内链接记录相对目标，恢复时重建。
function resolveSymlink(targetDir: any, relativePath: any) {
  const absolutePath = path.join(targetDir, relativePath);
  let rawTarget = '';
  try {
    rawTarget = fs.readlinkSync(absolutePath);
  } catch {
    return { type: 'symlink', escapes: true, linkTarget: '' };
  }
  const resolvedTarget = path.resolve(path.dirname(absolutePath), rawTarget);
  const relative = path.relative(path.resolve(targetDir), resolvedTarget);
  const escapes = relative.startsWith('..') || path.isAbsolute(relative);
  return {
    type: 'symlink',
    escapes,
    linkTarget: escapes ? '' : rawTarget.replace(/\\/g, '/'),
  };
}

function statSignature(entry: any) {
  return `${entry.size}:${entry.mtimeMs}:${entry.mode}`;
}

function buildManifestHash(files: any, deletions: any) {
  const canonical = JSON.stringify({
    files: Object.keys(files).sort().map((name) => [name, files[name].hash || '', files[name].size || 0, files[name].secretExcluded === true]),
    deletions: (Array.isArray(deletions) ? deletions.slice() : []).sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function createCollector(options: any = {}) {
  const store = options.store;
  const trustMtime = options.trustMtime !== false;

  // 扫描 + 读取 + 秘密哨兵 + 计算 hash。previousFiles 提供 mtime 快速路径。
  function scanFiles(targetDir: any, policy: any, previousFiles: any, scanOptions: any = {}) {
    const files: any = {};
    const skipped: any[] = [];
    const stats = { hashed: 0, reusedHash: 0, secretExcluded: 0, symlinkEscapes: 0, missing: 0 };
    const candidates = listCandidatePaths(targetDir, policy);

    for (const relativePath of candidates) {
      const { absolutePath, stat } = lstatEntry(targetDir, relativePath);
      if (!stat) {
        stats.missing += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        const link = resolveSymlink(targetDir, relativePath);
        if (link.escapes) {
          stats.symlinkEscapes += 1;
        }
        files[relativePath] = {
          type: 'symlink',
          size: 0,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          linkTarget: link.linkTarget,
          escapes: link.escapes === true,
        };
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ path: relativePath, reason: stat.isDirectory() ? 'directory-entry' : 'special-file' });
        continue;
      }

      const previous = previousFiles && previousFiles[relativePath];
      const reusable = trustMtime
        && previous
        && previous.type === 'file'
        && previous.secretExcluded !== true
        && Number(previous.size) === stat.size
        && Number(previous.mtimeMs) === stat.mtimeMs
        && Number(previous.mode) === stat.mode
        && previous.hash;

      if (reusable && scanOptions.statOnly !== true) {
        files[relativePath] = {
          type: 'file',
          size: stat.size,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          hash: previous.hash,
          hashReused: true,
        };
        stats.reusedHash += 1;
        continue;
      }

      const content = fs.readFileSync(absolutePath);
      const secretHit = content.length <= MAX_SECRET_SCAN_BYTES && containsSecretSentinel(content);
      const hash = sha256Buffer(content);
      files[relativePath] = {
        type: 'file',
        size: stat.size,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        hash,
        ...(secretHit ? { secretExcluded: true } : {}),
      };
      stats.hashed += 1;
      if (secretHit) {
        stats.secretExcluded += 1;
      }
    }

    return { files, skipped, stats };
  }

  // stat-only 重扫：只比对 size/mtime/mode/类型，不重新读内容。
  function rescanStatSignatures(targetDir: any, policy: any) {
    const signatures: any = {};
    const candidates = listCandidatePaths(targetDir, policy);
    for (const relativePath of candidates) {
      const { stat } = lstatEntry(targetDir, relativePath);
      if (!stat) {
        continue;
      }
      signatures[relativePath] = stat.isSymbolicLink()
        ? `link:${stat.mtimeMs}`
        : stat.isFile()
          ? statSignature(stat)
          : 'other';
    }
    return signatures;
  }

  function diffSignatures(beforeFiles: any, afterSignatures: any) {
    const differing: string[] = [];
    const beforeNames = Object.keys(beforeFiles);
    const beforeSet = new Set(beforeNames);
    for (const name of beforeNames) {
      const entry = beforeFiles[name];
      const after = afterSignatures[name];
      if (after === undefined) {
        differing.push(name);
        continue;
      }
      const expected = entry.type === 'symlink' ? `link:${entry.mtimeMs}` : statSignature(entry);
      if (after !== expected) {
        differing.push(name);
      }
    }
    for (const name of Object.keys(afterSignatures)) {
      if (!beforeSet.has(name)) {
        differing.push(name);
      }
    }
    return differing.sort();
  }

  function captureTurnCheckpoint(input: any = {}) {
    const startedAt = Date.now();
    const projectId = String(input.projectId || '').trim();
    const targetDir = path.resolve(String(input.targetDir || '').trim() || '.');
    const deliveryMode = input.deliveryMode === 'resume' ? 'resume' : 'fresh';
    const checkpointId = crypto.randomUUID();

    const fail = (reason: any, extra: any = {}) => ({
      captured: false,
      checkpointId: '',
      reason,
      durationMs: Date.now() - startedAt,
      ...extra,
    });

    if (!store) {
      return fail('store_unavailable');
    }
    if (!projectId) {
      return fail('project_id_missing');
    }
    if (!fs.existsSync(targetDir)) {
      return fail('target_dir_missing');
    }

    const policy = store.loadPolicy(projectId);
    if (policy.status !== 'enabled') {
      return fail('policy_not_enabled', { policyStatus: policy.status });
    }
    if (!isAuthorizedDir(policy, targetDir)) {
      return fail('dir_not_authorized');
    }
    // 防止采集存储自身被纳入采集范围（递归/自引用）。
    const rootRelative = path.relative(targetDir, store.captureRoot);
    if (rootRelative === '' || (!rootRelative.startsWith('..') && !path.isAbsolute(rootRelative))) {
      return fail('capture_root_inside_target');
    }

    const previous = store.loadLatestCheckpoint(projectId, targetDir);
    const previousFiles = previous && previous.files ? previous.files : null;

    let consistency: any = null;
    let scanResult: any = null;
    let newBlobBytes = 0;
    let retries = 0;

    for (let attempt = 0; attempt <= MAX_CONSISTENCY_RETRIES; attempt += 1) {
      scanResult = scanFiles(targetDir, policy, attempt === 0 ? previousFiles : null);

      // 配额预检（扫描后、写盘前）：已有占用 + 本次新内容估值超额 → 挂起策略，
      // 不落任何 blob/清单，不伪造成功。
      if (attempt === 0) {
        const usage = store.computeUsage(projectId);
        let estimatedNewBytes = Buffer.byteLength(String(input.prompt || ''), 'utf8');
        for (const relativePath of Object.keys(scanResult.files)) {
          const entry = scanResult.files[relativePath];
          if (entry.type === 'file' && entry.secretExcluded !== true && entry.hash && !store.hasBlob(projectId, entry.hash)) {
            estimatedNewBytes += Number(entry.size) || 0;
          }
        }
        if (usage.totalBytes + estimatedNewBytes > policy.stagingQuotaBytes) {
          store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'quota_exceeded' });
          return fail('quota_exceeded', {
            policyStatus: 'suspended',
            usageBytes: usage.totalBytes,
            estimatedNewBytes,
          });
        }
      }

      // 写 CAS：写时重读并重校 hash，检测扫描与读取之间的变化。
      const writeMismatches: string[] = [];
      for (const relativePath of Object.keys(scanResult.files)) {
        const entry = scanResult.files[relativePath];
        if (entry.type !== 'file' || entry.secretExcluded === true || !entry.hash) {
          continue;
        }
        if (store.hasBlob(projectId, entry.hash)) {
          continue;
        }
        const content = fs.readFileSync(path.join(targetDir, relativePath));
        const actualHash = sha256Buffer(content);
        if (actualHash !== entry.hash) {
          writeMismatches.push(relativePath);
          entry.hash = actualHash;
          entry.size = content.length;
        }
        const written = store.writeBlob(projectId, actualHash, content);
        newBlobBytes += written.bytes;
      }

      if (typeof options.afterFirstScan === 'function') {
        // 测试注入点：模拟采集期间的并发写入者。
        options.afterFirstScan(targetDir, attempt);
      }

      const secondSignatures = rescanStatSignatures(targetDir, policy);
      const differing = diffSignatures(scanResult.files, secondSignatures);
      const changed = Array.from(new Set([...differing, ...writeMismatches])).sort();

      if (changed.length === 0) {
        consistency = {
          evidence: 'double-scan-stable',
          atomicityGuaranteed: false,
          secondScanMode: 'stat-only',
          differingPaths: [],
        };
        break;
      }
      retries = attempt + 1;
      consistency = {
        evidence: 'write-during-capture',
        atomicityGuaranteed: false,
        secondScanMode: 'stat-only',
        differingPaths: changed,
      };
    }

    // 删除状态：相对上一检查点消失的路径。
    const currentPaths = new Set(Object.keys(scanResult.files));
    const deletions = previousFiles
      ? Object.keys(previousFiles).filter((name) => !currentPaths.has(name)).sort()
      : [];

    // 回放输入归档。
    const replayInput: any = {
      deliveryMode,
      complete: true,
      incompleteReasons: [] as string[],
      controlledReplacements: [] as any[],
      promptBlobHash: '',
      normalizedPromptHash: '',
      sessionBlobHash: '',
      sessionContainsSecretSentinel: false,
    };

    const promptText = String(input.prompt || '');
    const replaced = replaceControlledVariables(promptText, input.controlledValues);
    replayInput.controlledReplacements = replaced.replacements;
    replayInput.normalizedPromptHash = crypto.createHash('sha256').update(replaced.text).digest('hex');
    const promptWrite = store.writeBlob(projectId, replayInput.normalizedPromptHash, Buffer.from(replaced.text, 'utf8'));
    newBlobBytes += promptWrite.bytes;
    replayInput.promptBlobHash = replayInput.normalizedPromptHash;

    if (deliveryMode === 'resume') {
      const sessionPath = String(input.sessionPath || '').trim();
      if (!sessionPath || !fs.existsSync(sessionPath)) {
        // 禁止静默降级 fresh：deliveryMode 保持 resume，标记不可完整回放。
        replayInput.complete = false;
        replayInput.incompleteReasons.push('session_missing');
      } else {
        const sessionContent = fs.readFileSync(sessionPath);
        const sessionReplaced = replaceControlledVariables(sessionContent.toString('utf8'), input.controlledValues);
        let sessionText = sessionReplaced.text;
        if (containsSecretSentinel(Buffer.from(sessionText, 'utf8'))) {
          // 历史中出现哨兵内容：本地留存与原始 session 同级风险，但标记出来，
          // 供封存/导出环节强制脱敏；不在这里改写历史以保回放保真。
          replayInput.sessionContainsSecretSentinel = true;
        }
        replayInput.sessionBlobHash = crypto.createHash('sha256').update(sessionText).digest('hex');
        const sessionWrite = store.writeBlob(projectId, replayInput.sessionBlobHash, Buffer.from(sessionText, 'utf8'));
        newBlobBytes += sessionWrite.bytes;
        replayInput.controlledReplacements = replayInput.controlledReplacements.concat(sessionReplaced.replacements);
      }
    }

    const secretExcludedPaths = Object.keys(scanResult.files)
      .filter((name) => scanResult.files[name].secretExcluded === true)
      .sort();
    if (secretExcludedPaths.length > 0) {
      replayInput.secretExcludedPaths = secretExcludedPaths;
    }

    const integrityManifestHash = buildManifestHash(scanResult.files, deletions);
    const strictEvalEligible = consistency.evidence === 'double-scan-stable' && replayInput.complete === true;

    const checkpoint = {
      schemaVersion: 1,
      checkpointId,
      projectId,
      conversationId: String(input.conversationId || '').trim(),
      turnId: String(input.turnId || '').trim(),
      agentId: String(input.agentId || '').trim(),
      createdAt: nowIso(),
      targetDir,
      status: 'staged',
      files: scanResult.files,
      deletions,
      skipped: scanResult.skipped,
      integrity: {
        algorithm: 'sha256',
        manifestHash: integrityManifestHash,
      },
      consistency: { ...consistency, retries },
      replayInput,
      environment: input.environment && typeof input.environment === 'object' ? input.environment : {},
      strictEvalEligible,
      stats: {
        fileCount: Object.keys(scanResult.files).length,
        totalBytes: Object.values(scanResult.files).reduce((sum: any, entry: any) => sum + (Number((entry as any).size) || 0), 0),
        newBlobBytes,
        hashedFiles: scanResult.stats.hashed,
        reusedHashFiles: scanResult.stats.reusedHash,
        secretExcludedFiles: scanResult.stats.secretExcluded,
        symlinkEscapes: scanResult.stats.symlinkEscapes,
        durationMs: Date.now() - startedAt,
      },
    };

    try {
      store.saveCheckpoint(projectId, checkpoint);
      store.saveLatestCheckpointId(projectId, targetDir, checkpointId);
    } catch (error: any) {
      store.savePolicy({ ...policy, status: 'suspended', suspendReason: 'write_failed' });
      return fail('write_failed', {
        policyStatus: 'suspended',
        error: error && error.message ? String(error.message) : String(error),
      });
    }

    return {
      captured: true,
      checkpointId,
      checkpoint,
      reason: '',
      durationMs: Date.now() - startedAt,
    };
  }

  return { captureTurnCheckpoint, scanFiles, listCandidatePaths };
}
