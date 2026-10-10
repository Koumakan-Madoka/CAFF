// Badcase 采集容量/耗时测量（AC9 证据工具，非测试断言）。
//
// 用法：
//   node scripts/badcase-capture/measure-capture.js --target <dir> --out <captureRoot> [--session <session.jsonl>]
//
// 输出 JSON：首份采集（冷，无历史清单）与增量采集（热，mtime 快速路径）的
// 字节数、blob 数、耗时，以及 session 归档增长。测试条件随结果一并输出。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture/index');

function parseArgs(argv) {
  const args = { target: '', out: '', session: '' };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--target') args.target = argv[++index];
    else if (key === '--out') args.out = argv[++index];
    else if (key === '--session') args.session = argv[++index];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.target || !args.out) {
    console.error('usage: node scripts/badcase-capture/measure-capture.js --target <dir> --out <captureRoot> [--session <file>]');
    process.exit(2);
  }
  const targetDir = path.resolve(args.target);
  const captureRoot = path.resolve(args.out);
  fs.mkdirSync(captureRoot, { recursive: true });

  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('measure', {
    status: 'enabled',
    authorizedDirs: [targetDir],
    // 测量真实仓库时把构建产物/依赖也排除，与默认策略一致
  });

  const report = {
    conditions: {
      targetDir,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      startedAt: new Date().toISOString(),
      note: '合成夹具之外的测量；session 增长仅在提供 --session 时测量',
    },
  };

  // 1) 冷采集（无历史清单，全量 hash + 落盘）
  const cold = service.captureTurnCheckpoint({
    projectId: 'measure',
    targetDir,
    conversationId: 'measure-conv',
    turnId: 'cold',
    agentId: 'measure-agent',
    deliveryMode: 'fresh',
    prompt: 'measurement prompt',
    controlledValues: {},
  });
  if (!cold.captured) {
    console.error(JSON.stringify({ error: cold.reason }, null, 2));
    process.exit(1);
  }
  const usageAfterCold = service.computeUsage('measure');
  report.cold = {
    checkpointId: cold.checkpointId,
    fileCount: cold.checkpoint.stats.fileCount,
    manifestBytes: cold.checkpoint.stats.totalBytes,
    newBlobBytes: cold.checkpoint.stats.newBlobBytes,
    casTotalBytes: usageAfterCold.totalBytes,
    blobCount: usageAfterCold.blobCount,
    hashedFiles: cold.checkpoint.stats.hashedFiles,
    durationMs: cold.checkpoint.stats.durationMs,
    consistency: cold.checkpoint.consistency.evidence,
  };

  // 2) 热采集（无变化）：mtime 快速路径，只写 prompt blob
  const warmUnchanged = service.captureTurnCheckpoint({
    projectId: 'measure', targetDir, conversationId: 'measure-conv',
    turnId: 'warm-unchanged', agentId: 'measure-agent',
    deliveryMode: 'fresh', prompt: 'measurement prompt', controlledValues: {},
  });
  report.warmUnchanged = {
    newBlobBytes: warmUnchanged.checkpoint.stats.newBlobBytes,
    hashedFiles: warmUnchanged.checkpoint.stats.hashedFiles,
    reusedHashFiles: warmUnchanged.checkpoint.stats.reusedHashFiles,
    durationMs: warmUnchanged.checkpoint.stats.durationMs,
    consistency: warmUnchanged.checkpoint.consistency.evidence,
  };

  // 3) 增量采集：修改一个文件 + 新增一个文件
  const probeFile = path.join(targetDir, '.badcase-measure-probe.tmp');
  fs.writeFileSync(probeFile, `probe-${Date.now()}`);
  try {
    const warmChanged = service.captureTurnCheckpoint({
      projectId: 'measure', targetDir, conversationId: 'measure-conv',
      turnId: 'warm-changed', agentId: 'measure-agent',
      deliveryMode: 'fresh', prompt: 'measurement prompt v2', controlledValues: {},
    });
    report.warmChanged = {
      newBlobBytes: warmChanged.checkpoint.stats.newBlobBytes,
      hashedFiles: warmChanged.checkpoint.stats.hashedFiles,
      durationMs: warmChanged.checkpoint.stats.durationMs,
      consistency: warmChanged.checkpoint.consistency.evidence,
    };
  } finally {
    fs.unlinkSync(probeFile);
  }

  // 4) session 归档增长（resume）
  if (args.session) {
    const sessionPath = path.resolve(args.session);
    const sessionBytes = fs.statSync(sessionPath).size;
    const before = service.computeUsage('measure');
    const resume = service.captureTurnCheckpoint({
      projectId: 'measure', targetDir, conversationId: 'measure-conv',
      turnId: 'resume-session', agentId: 'measure-agent',
      deliveryMode: 'resume', prompt: 'resume measurement', controlledValues: {},
      sessionPath,
    });
    const after = service.computeUsage('measure');
    report.sessionArchive = {
      sessionBytes,
      replayInputComplete: resume.checkpoint.replayInput.complete,
      casGrowthBytes: after.totalBytes - before.totalBytes,
      durationMs: resume.checkpoint.stats.durationMs,
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
