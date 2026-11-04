# WikiSkill 数据迁移（离线副本）

适用于当前全局 WikiSkill 集合迁往**全新的生产布局副本**。不是部署命令，也不授权接触生产数据。旧的 `migrate-global-wiki.cjs` 只处理项目 Wiki→全局 Wiki，不承担本节的封存现场迁移。

## 入口

先在要发布的固定 SHA 构建：`npm run build`。

准备一个本地、绝对路径的配置文件（不放凭据）：

```json
{
  "globalRoot": "<源 agent 目录>/badcase-global",
  "sourceWorktree": "<当前 CAFF worktree 绝对路径>",
  "captureRoots": ["<明确批准读取的源 captureRoot 绝对路径>"],
  "destinationAgentDir": "<尚不存在的副本 agent 目录绝对路径>"
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
- 保留全部 `snapshots/`、`comparisons/`、`executions/`、`batch-executions/`，不受页面最近20份的显示窗口限制。用例、模式、归类/审核、经验版本、候选、基线链、演进裁决都随原始快照逐字节保留。
- 对明确列出的各采集根枚举全部 `cases/`，包括未登记为回放题、作废题及只出现在旧快照的封存。复制其 seal、retention、已有对应 flag/checkpoint，以及 retention 枚举的全部 CAS blob；重新核对 checkpoint/blob hash。保留原来确实缺失的材料，不提升任何 runnable/complete/strict 标记。
- 不复制采集开关/policy、latest、未封存检查点、暂存/锁/回收目录、认证/模型配置、聊天 SQLite、原工作仓库、运行日志、宿主依赖缓存或 Docker 镜像。操作方 `--output` JSONL/截图等原始验收证据仍单独保管，不把它们冒充页面数据。
- 先构建相邻临时目录，核对每个副本文件，重新清点源以防漂移，最后原子 rename 发布整个副本。失败不发布目标，留下本命令的 `.migration-*` 诊断目录；不自动删除任何目录。源与目标不可重叠、目标不可位于 sourceWorktree 内，静态 symlink/junction 不支持。
- 目标已有无关内容、原迁移文件损坏、源计划变化均拒绝覆盖。不是增量同步、跨历史合并或 ID 冲突解决器。目标后来新增业务快照不会被重跑覆盖；修改已迁入原文件会触发冲突。源有新增数据时，生成新的全新副本并重新验收。
- 迁移和运行仍以 same-OS-user 可信存储为边界；不声称可抵抗恶意同用户路径交换、提供多目录分布式事务或崩溃后的全盘持久性认证。

## 为什么不改历史路径

登记 replay 的 contentHash/ID 包含原始 `request.captureRoot`，样例版本和评测引用也依赖这些身份。直接替换快照里的路径会破坏历史链，故不重写快照、seal、retention 或 comparison。

副本布局：

```text
destinationAgentDir/
  wiki-migration.json                 # 原计划和已复制文件 hash 收据
  badcase-global/
    snapshots/ comparisons/ executions/ batch-executions/
    capture-locations.json            # checksum 保护的位置映射
  badcase-capture/imports/<源根hash>/projects/<projectId>/...
```

宿主 `resolveWikiReplayRequest({globalRoot}, request)` 在读取现场前解析映射。页面候选生成/确认、候选 CLI、全局批量/生产批量及其单例内核共用它；不把位置映射作为模型输入，不改变原请求对象。副本根是相对映射推导的，因此整个副本可以一起搬动。

迁移后映射损坏、缺失、未知旧根或副本材料缺失直接拒绝，**不能回退读取仍存在的源现场**。新采集使用副本自身规范 `badcase-capture`；不与导入根合并。受信独立 sealed CLI 若不带 Wiki 上下文，须由操作者用同一解析器得到副本请求，不自动搜索其他目录。

## 副本验收与后续发布

- 对比源/副本全部集合数量、ID、审核状态与源前后 hash；重复执行验证幂等。
- 使用副本专属 `PI_CODING_AGENT_DIR`、全新 SQLite、日志、上传目录及未占用端口启动页面；禁用外部集成和模型执行。不要复制 auth.json，页面只读验收不需要凭据。
- 浏览器检查用例、经验两栏、候选和分门槛/测试结果；不通过网页启动评测。
- 回放预检使用副本 `globalRoot`。`compare-wiki-batch.cjs --plan` 会重新生成计划 hash；旧执行确认不可沿用。真实仓库恢复还需要显式授权的仓库 clone、固定 HEAD、Linux 依赖缓存及镜像；本迁移不复制活动仓库或把历史 targetDir 改成当前目录。预检不等于重新跑模型。
- 真正迁入生产、停写备份、目标已有数据的处理、推送/合并/重启/上线复测，均是用户最终接受后的独立发布步骤，须逐项批准；本命令不能直接并入一个已有生产 agent 目录。
