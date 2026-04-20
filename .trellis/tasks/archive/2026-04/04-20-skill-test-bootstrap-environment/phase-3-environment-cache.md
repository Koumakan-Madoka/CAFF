# Phase 3: Environment Cache Draft

## Goal
- 为 `skill-test` 的环境链增加可复用缓存，减少重复 `bootstrap` 带来的时间与网络成本。
- 保持当前 `host-loop + sandbox-tools` 契约不变：缓存命中后的恢复、验证与后续副作用仍只发生在 sandbox case world 中。
- 让缓存失败退化为普通 miss，而不是把本来可跑的 case 直接打成 hard fail。

## Non-Goals
- 不把缓存做成新的执行模式；agent loop 仍留在 host。
- 不尝试缓存 GUI、系统服务、硬件设备、真实账号密钥等当前 runtime 不支持的能力。
- 不把整个 case world 原样快照成黑盒镜像；首期只缓存显式声明的环境产物。

## Why Phase 3 Is Non-Trivial
当前环境链已经有 `preflight -> bootstrap -> verify -> run`，但环境缓存不是简单在 `bootstrap` 前后插一层文件复制，主要卡在这几个点：

1. skill-test 的 case world 是每次运行临时创建、结束后清理的；缓存必须落在 case root 之外。
2. 当前 `sandboxToolAdapter` 只有 `readFile` / `writeFile` / `mkdir` / `runCommand`，没有目录枚举或整树导出 API。
3. 运行路径语义必须继续对 agent 保持 sandbox 视角，不能为了缓存把环境副作用移回 host。
4. 环境产物里可能混入 token、账号、机器本地状态；不能默认把整个目录打包共享。

结论：Phase 3 更适合做成“显式路径 + tarball artifact + restore-then-verify”的缓存，而不是隐式快照整个 world。

## Proposed Execution Model

```text
resolve effective environment config
  -> base preflight
  -> if unsupported: stop (runtime_unsupported)
  -> if already satisfied: verify -> run
  -> compute cache key
  -> try restore cache artifact into sandbox case world
  -> re-run preflight
  -> if satisfied: verify -> run
  -> bootstrap
  -> verify
  -> save cache artifact
  -> run
```

关键语义：
- 只有在 `preflight` 发现缺失项时，才尝试 restore，避免对本来已经满足的基础镜像重复解压缓存。
- cache hit 后仍必须跑 `preflight + verify`，不允许“命中就直接信任”。
- restore 失败时只记 warning，并回退到正常 `bootstrap`；不要把 cache 变成可用性单点。
- save 只发生在 `bootstrap + verify` 成功之后，避免把坏状态写进缓存。

## Cache Key
建议把缓存键拆成两段：

### 1. `planHash`
描述“我要准备什么环境”：
- `skillId`
- 归一化后的 `environmentConfig.requirements`
- 归一化后的 `environmentConfig.bootstrap.commands`
- 归一化后的 `environmentConfig.verify.commands`
- 若配置来自 `TESTING.md`，追加 `TESTING.md` 内容 hash
- 若 run request 带了 `environment.override`，把 override 一并纳入 hash

### 2. `worldHash`
描述“我在什么 sandbox 世界里准备环境”：
- isolation driver name / version
- OpenSandbox image / template / prebaked runtime markers
- platform / arch（建议在 sandbox 里探测一次 `uname -sm` 或等价信息）
- `egressMode`
- tool runtime / path semantics（首期固定为 `sandbox`）

最终 cache key：

```text
skillId + planHash + worldHash
```

这样可以避免：
- 同一个 skill 改了 bootstrap 命令却误命中旧缓存
- driver / image 变化后复用不兼容产物
- 仅靠 `skillId` 导致不同 case 的环境互相污染

## Artifact Layout
建议新增项目级缓存根目录：

```text
.pi-sandbox/skill-test-environment-cache/
  <cacheKey>/
    manifest.json
    artifact.tgz
    summary.json
```

### `manifest.json`
建议字段：

```json
{
  "cacheKey": "...",
  "skillId": "...",
  "planHash": "...",
  "worldHash": "...",
  "createdAt": "2026-04-20T00:00:00.000Z",
  "driver": { "name": "opensandbox", "version": "..." },
  "platform": { "os": "linux", "arch": "x86_64" },
  "paths": [
    { "root": "project", "path": ".venv" },
    { "root": "project", "path": ".cache/uv" }
  ],
  "bootstrapCommandDigest": "...",
  "verifyCommandDigest": "...",
  "artifactSha256": "...",
  "artifactBytes": 123456,
  "lastValidatedAt": "2026-04-20T00:00:00.000Z"
}
```

### `summary.json`
用于 UI / run detail 快速读取，保存：
- 最近命中时间
- 最近保存时间
- 最近 restore/save 结果
- 最近一次对应的 `runId`

## Cache Path Contract
首期不建议自动猜测该缓存哪些目录，而是新增显式配置：

```json
{
  "environmentConfig": {
    "cache": {
      "enabled": true,
      "paths": [
        { "root": "project", "path": ".venv" },
        { "root": "project", "path": ".cache/uv" },
        { "root": "private", "path": ".local/bin" }
      ],
      "maxArtifactBytes": 536870912,
      "ttlHours": 168
    }
  }
}
```

约束建议：
- `root` 首期只允许：`project | private`
- `path` 必须是相对路径，禁止绝对路径、`..`、以及越出 case world
- 没有 `cache.paths` 时，仍可计算 key 并报告“cache disabled/no paths”，但不执行 save
- 对来自 `TESTING.md` 的环境配置，后续可再扩展 `## Cache Paths` 章节；首期可以只支持 JSON config

## Save / Restore Mechanics
由于现有 adapter 没有目录树导出接口，建议使用“在 sandbox 内打包 tarball，再通过已知文件路径拉回 host”的方式。

### Save
1. `bootstrap + verify` 成功后，在 sandbox case world 的 `outputs/environment-cache/` 下生成 `artifact.tgz`
2. 打包命令只包含 `cache.paths` 中显式声明的相对路径
3. host 通过 `sandboxToolAdapter.readFile()` 读取这个 tarball，并写入 `.pi-sandbox/skill-test-environment-cache/<cacheKey>/artifact.tgz`
4. 计算 sha256、大小、命中信息，写 `manifest.json`

建议命令形态：

```text
mkdir -p outputs/environment-cache
rm -f outputs/environment-cache/artifact.tgz
cd <root>
tar -czf outputs/environment-cache/artifact.tgz <declared paths>
```

### Restore
1. base preflight 发现缺失项后，根据 cache key 查 host cache root
2. 若命中，则把 `artifact.tgz` 通过 `sandboxToolAdapter.writeFile()` 写入 sandbox 的 `outputs/environment-cache/restore.tgz`
3. 在 sandbox 内解压到临时目录，再复制回 `project` / `private` 对应根，避免半解压直接污染目标路径
4. restore 完成后重跑 `preflight`

建议 restore 命令形态：

```text
rm -rf outputs/environment-cache/restore-temp
mkdir -p outputs/environment-cache/restore-temp
cd outputs/environment-cache/restore-temp
tar -xzf ../restore.tgz
cp -a <temp relative path> <target root>
```

如果 restore 失败：
- 记录 `restore_failed`
- 清理临时目录
- 继续走正常 `bootstrap`

## Controller / Runtime Insertion Points
最小接线点建议如下：

1. `resolveEnvironmentRunConfig(...)`
   - 归一化 `environment.cache`
   - 计算 cache metadata 所需输入

2. `executeEnvironmentWorkflow(...)`
   - 在 `base preflight` 和 `bootstrap` 之间插入 restore 分支
   - 在成功 `verify` 后插入 save 分支
   - 返回 `environment.cache` 结构化结果

3. isolation / OpenSandbox 层
   - 不新增新的执行模式
   - 继续复用现有 `sandboxToolAdapter.runCommand/readFile/writeFile`
   - 缓存 artifact 只在 host 侧持久化，restore/save 的实际副作用仍发生在 sandbox

## Result Contract
建议扩展 `evaluation_json.environment.cache`：

```json
{
  "enabled": true,
  "key": "...",
  "status": "disabled | miss | restored | restore_failed | saved | save_failed | skipped",
  "reason": "...",
  "paths": [],
  "artifactBytes": 123456,
  "manifestPath": ".pi-sandbox/skill-test-environment-cache/.../manifest.json"
}
```

说明：
- `status` 表示这次 run 的缓存动作结果，不替代 `environment.status`
- `environment.status` 仍负责 `passed / env_missing / env_install_failed / env_verify_failed / runtime_unsupported`
- cache save 失败默认降级为 warning，不应该覆盖已经通过的环境结果

## Safety Rules
- 只缓存显式声明的相对路径，不缓存整棵 project root
- 默认禁止缓存 `.git`、`.trellis`、SQLite、token 文件、auth 配置、浏览器 profile、系统证书目录
- manifest 里只保留摘要，不回显大段 stdout/stderr 或敏感 env
- 命中缓存后仍必须跑 verify，避免“命中旧缓存但工具已坏”
- cache key 必须包含 driver/image/platform 维度，避免跨 runtime 误复用

## Suggested Rollout
### Phase 3A: Metadata-only
- 新增 `environment.cache` schema
- 计算 cache key
- 在 run detail 中显示 `disabled / eligible / no-paths`
- 不做真正 restore/save

### Phase 3B: Restore on Hit
- 实现 host cache lookup
- 实现 sandbox restore + re-preflight
- run detail 展示 `restored / restore_failed / miss`

### Phase 3C: Save on Success
- 成功 `bootstrap + verify` 后导出 tarball
- 写 manifest / summary
- 加入 TTL / size 上限 / 最简单的 LRU 清理

### Phase 3D: TESTING.md Integration
- 支持从 `TESTING.md` 读取 `Cache Paths`
- UI 提示“当前环境链来自 TESTING.md，缓存路径仍需手工声明/确认”

## Open Questions
- 是否允许多个 skill 共享同一个基础 cache，还是首期严格按 `skillId` 隔离。
- `tar` 是否视为 sandbox runtime 的硬依赖；若不是，是否需要 node 侧 fallback 打包器。
- `cache.paths` 是否需要支持“恢复后执行 post-restore hook”。
- UI 是否要提供“清空该 skill 的环境缓存”按钮。
- `run-all` 命中同一 cache key 时，是否需要 host 侧并发锁避免重复保存。

## Recommendation
如果要继续开工，建议顺序是：
1. 先做 `Phase 3A`，把 key、eligibility、result contract 定死
2. 再做 `Phase 3B` restore，因为它直接减少重复安装
3. 最后再做 save + janitor，避免一上来就碰清理策略和大文件管理
