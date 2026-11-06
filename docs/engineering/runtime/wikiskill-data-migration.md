# WikiSkill 数据迁移（离线副本）

适用于当前全局 WikiSkill 集合迁往**全新的生产布局副本**。不是部署命令，也不授权接触生产数据。旧的 `migrate-global-wiki.cjs` 只处理项目 Wiki→全局 Wiki，不承担本节的封存现场迁移。

## 独立数据目录

`CAFF_WIKISKILL_DATA_DIR` 只用于没有显式根目录时的实例默认路径组装：设置时必须是宿主 OS 的**绝对路径**（空值、相对路径或 NUL 拒绝，不回退）；未设置时行为不变，实例仍用 `agentDir`。显式 `globalRoot`（包括受信 Wiki CLI 的 JSON 配置）或旧项目 `captureRoot` 始终优先，不被环境变量改道，也不校验无关的环境变量值。该目录仍须在 CAFF 源仓库及实例登记的项目目录外，原 `wiki_storage_inside_source` 保护不放宽。不会自动搬迁任何现有数据。

设置后，目录内只有这组 Wiki 数据布局：`badcase-global/`、迁入的 `badcase-capture/imports/` 和根级 `wiki-migration.json`。实例自己新采集的现场由独立采集根配置决定（服务端显式 `captureRoot` → `CAFF_BADCASE_CAPTURE_DIR` → 默认 `<agentDir>/badcase-capture`），本 Wiki 变量不移动采集库，认证、SQLite、模型配置等也不改位置。2026-11-05 的 Git 快照采集库外置步骤见[采集契约 v2 部署操作](badcase-capture-replay.md#v2-部署操作另行批准后当前未执行)，不是本迁移命令的职责。页面 API 和标记后的 Wiki 写入在默认路径组装时解析该配置，随后预分类/归纳、候选和评测记录共用选定的根；受信 Wiki CLI 必须将 JSON 的 `globalRoot` 明确设为页面实际使用的 `badcase-global` 目录，不能靠环境变量覆盖旧路径。

迁移命令例外地保留 JSON `globalRoot` 为**明确源目录**，绝不让环境变量将源替换为目标；其 `destinationAgentDir` 字段保留兼容，但实际目标优先取 `CAFF_WIKISKILL_DATA_DIR`。计划 hash 绑定解析后的有效目标。未设置时这两个 JSON 字段的原语义不变。运行评测/候选 CLI 时同时设置与实例一致的 `PI_CODING_AGENT_DIR`，使本机新现场解析到正确实例；未设置则沿用服务器默认 agent 目录。

例如 Windows 3100 的 `agentDir` 为仓库内 `.pi-sandbox` 时，可由启动器将 `%LOCALAPPDATA%\\CAFF\\wikiskill` **展开为实际绝对路径**后写入 `CAFF_WIKISKILL_DATA_DIR`（不要把未展开的 `%LOCALAPPDATA%` 字符串直接交给程序）。该变量与 `PI_CODING_AGENT_DIR`、`PI_SQLITE_PATH` 各自独立。部署顺序：配置外置路径 → 迁移并验证 → 重启 → API/两类回放复测；详细审批见[发布手册](wikiskill-release.md)。

## 测试入口隔离

所有 npm 测试脚本通过 `scripts/test-entry.cjs` 启动，在加载测试、构建和子进程前清除继承的 `CAFF_WIKISKILL_DATA_DIR`、`CAFF_BADCASE_CAPTURE_DIR`；需要测试配置路径的用例只能自行设置临时目录。此保护不等于文件系统沙箱，也不清理其他所有实例变量。手动直接运行 `node tests/...` 时必须自行隔离；每条测试命令先将 Wiki、capture、agent、SQLite 指向测试专用临时目录，再经测试入口启动，不能复用生产默认值。

## 入口

先在要发布的固定 SHA 构建：`npm run build`。

准备一个本地、绝对路径的配置文件（不放凭据）：

```json
{
  "globalRoot": "<源 agent 目录>/badcase-global",
  "sourceWorktree": "<当前 CAFF worktree 绝对路径>",
  "captureRoots": ["<明确批准读取的源 captureRoot 绝对路径>"],
  "destinationAgentDir": "<尚不存在的 Wiki 数据目录绝对路径；未配环境变量时即旧副本 agent 目录>"
}
```

`captureRoots` 必须覆盖**所有历史快照**中的登记请求及样例模型版本，不能只列当前正式题。不同根可有相同 projectId，分别存放，不按 projectId 合并。配置不接受数据库路径、认证目录、模型或任意复制目录。

1. 只读生成计划：`node scripts/badcase-capture/migrate-wiki-layout.cjs --config <绝对配置路径> --plan`
2. 核对 revision、各集合数量、封存数、文件数及字节数，确认目的地是新副本。
3. 执行：`node scripts/badcase-capture/migrate-wiki-layout.cjs --config <绝对配置路径> --run --confirmed --expected-plan <上一步 planHash>`
4. 保留配置、计划和结果；同一命令再次执行应返回 `migrated:false`，不增加记录、不覆盖已有文件。

`--confirmed` 是受信本地操作者的明确确认，不是用户身份认证。输出只有固定错误码、hash、数量，不回显数据正文、路径或底层异常。

## 迁移边界与完整性

- 源只读；不写源锁、不“修复”源数据、不清理。应暂停源业务写入；发现进行中的评测、写锁/恢复锁、临时快照或来源变化直接拒绝。只读页面可继续访问。
- 保留全部 `snapshots/`、`comparisons/`、`executions/`、`batch-executions/`，不受页面最近20份的显示窗口限制。用例、模式、归类/审核、经验版本、候选、基线链、演进裁决都随原始快照逐字节保留。[评分 v2](wikiskill-scoring.md) 的断言版本、逐题模型、冻结/确认 hash 与新旧比较一同保留；迁移不重判旧字面结果、不重新确认断言。裁判 eligibility catalog/相邻冻结配置是操作方另行管理的外部配置，不在这组数据迁移内，不复制凭据；新实例须单独配置并核验，否则没有可选打分模型。
- 对明确列出的各采集根枚举全部 `cases/`，包括未登记为回放题、作废题及只出现在旧快照的封存。复制其 seal、retention、已有对应 flag/checkpoint，以及 retention 枚举的全部 CAS blob；重新核对 checkpoint/blob hash。保留原来确实缺失的材料，不提升任何 runnable/complete/strict 标记。
- 不复制采集开关/policy、latest、未封存检查点、暂存/锁/回收目录、认证/模型配置、聊天 SQLite、原工作仓库、运行日志、宿主依赖缓存或 Docker 镜像。操作方 `--output` JSONL/截图等原始验收证据仍单独保管，不把它们冒充页面数据。
- 先构建相邻临时目录，核对每个副本文件，重新清点源以防漂移，最后原子 rename 发布整个副本。失败不发布目标，留下本命令的 `.migration-*` 诊断目录；不自动删除任何目录。源与目标不可重叠、目标不可位于 sourceWorktree 内，静态 symlink/junction 不支持。
- 目标已有无关内容、原迁移文件损坏、源计划变化均拒绝覆盖。不是增量同步、跨历史合并或 ID 冲突解决器。目标后来新增业务快照不会被重跑覆盖；修改已迁入原文件会触发冲突。源有新增数据时，生成新的全新副本并重新验收。
- 迁移和运行仍以 same-OS-user 可信存储为边界；不声称可抵抗恶意同用户路径交换、提供多目录分布式事务或崩溃后的全盘持久性认证。

## 为什么不改历史路径

登记 replay 的 contentHash/ID 包含原始 `request.captureRoot`，样例版本和评测引用也依赖这些身份。直接替换快照里的路径会破坏历史链，故不重写快照、seal、retention 或 comparison。

副本布局：

```text
CAFF_WIKISKILL_DATA_DIR/               # 未设置时仍是 destinationAgentDir
  wiki-migration.json                 # 原计划和已复制文件 hash 收据
  badcase-global/
    snapshots/ comparisons/ executions/ batch-executions/
    capture-locations.json            # checksum 保护的位置映射
  badcase-capture/imports/<源根hash>/projects/<projectId>/...
```

宿主 `resolveWikiReplayRequest({globalRoot, instanceCaptureRoot?}, request)` 在读取现场前解析映射。页面候选生成/确认、候选 CLI、全局批量/生产批量及其单例内核共用它；不把位置映射作为模型输入，不改变原请求对象。副本根是相对映射推导的，因此整个副本可以一起搬动。

迁移后映射损坏、缺失、未知旧根或副本材料缺失直接拒绝，**不能回退读取仍存在的源现场**。新采集使用本实例实际配置的采集根（默认 `<agentDir>/badcase-capture`），导入现场使用数据目录下的 `badcase-capture/imports/<源根hash>`；两者同时识别、不合并。如果请求根也是历史映射的源根，优先映射到 imports，不以“本机目录”名义读回旧源。未配置独立目录时仍按原有副本相邻 `badcase-capture` 规则解析。受信独立 sealed CLI 若不带 Wiki 上下文，须由操作者用同一解析器得到副本请求，不自动搜索其他目录。

## 副本验收与后续发布

- 对比源/副本全部集合数量、ID、审核状态与源前后 hash；重复执行验证幂等。
- 使用副本专属 `PI_CODING_AGENT_DIR`、全新 SQLite、日志、上传目录及未占用端口启动页面；独立目录布局另设 `CAFF_WIKISKILL_DATA_DIR` 指向已迁移目录。禁用外部集成和模型执行。不要复制 auth.json，页面只读验收不需要凭据。
- 浏览器检查用例、经验两栏、候选和分门槛/测试结果；不通过网页启动评测。
- 回放预检使用副本 `globalRoot`。`compare-wiki-batch.cjs --plan` 会重新生成计划 hash；旧执行确认不可沿用。真实仓库恢复还需要显式授权的仓库 clone、固定 HEAD、Linux 依赖缓存及镜像；本迁移不复制活动仓库或把历史 targetDir 改成当前目录。预检不等于重新跑模型。
- 真正迁入生产、停写备份、目标已有数据的处理、推送/合并/重启/上线复测，均是用户最终接受后的独立发布步骤，须逐项批准；本命令不能直接并入一个已有生产 agent 或 Wiki 数据目录。
