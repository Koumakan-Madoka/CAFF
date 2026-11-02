// 采集能力共享探针：受限读取（openat2 受限域）能力在本进程是否可用。
// 不可用（win32/darwin/内核过旧/缺 python3/helper 安装失败）时，依赖真实采集的
// 测试以 capSkip 跳过；win32 失败关闭行为由 badcase-capture-safe-read.test.js 专项覆盖。
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { detectCaptureCapability } = require('../../build/server/domain/runtime/badcase-capture/safe-read');

const probeRoot = path.join(os.tmpdir(), `badcase-cap-probe-${process.pid}`);
fs.mkdirSync(probeRoot, { recursive: true });
const capability = detectCaptureCapability({ captureRoot: probeRoot });

module.exports = {
  capability,
  capSkip: capability.ok ? false : `capture capability unavailable: ${capability.reason}`,
};
