# WikiSkill 发布审批与上线复测

这是用户最终接受**之后**的运行手册，不是执行授权。本手册原 WikiSkill Goal 只在3268验证，不推送、不合并、不读取或修改3100。2026-11-05 Git 快照采集 v2 的验证实例为隔离3287，部署时还须单独按[采集库外置步骤](badcase-capture-replay.md#v2-部署操作另行批准后当前未执行)处理 `CAFF_BADCASE_CAPTURE_DIR` 与旧完整采集库；仅设置本手册的 Wiki 变量不解决仓库内采集库重叠。旧采集根、既有 imports 及路径映射须保留，不因代码升级自动搬迁、覆盖或删除。发布每个有副作用的阶段都须用户另行批准；最终接受功能也不等于采纳任何提示词候选。

## 当前交付与历史迁移

上一 WikiSkill Goal 已经用户接受并部署，数据已迁入外置目录；下面的首次迁移步骤是历史/通用手册，不能对已有目录再执行来覆盖生产。本轮评分v2仅在隔离副本验证，不能继承上一 Goal 的接受或部署记录。[评分v2契约](wikiskill-scoring.md)记录二值判分、校准目录与已知引用故障；JEV未校准、#10验证不完整两项偏差仍待用户裁决。

上线评分v2还须分别批准：精确代码SHA推送/合并/部署、已有生产数据与隔离断言/结果如何处理、裁判目录的只读配置及上线复测。旧字面结果必须原样保留；迁移工具不是将本轮结果增量并入现有生产集合的工具，不得手改快照。目录无 Key；凭据源及模型额度单独确认。本轮不执行这些步骤。

## Badcase 页与脱水的增量发布边界

[冻结轨迹包与脱水契约](wikiskill-trace-bundles.md) 是独立交付：历史只读回填、用户确认、删除与重新分组目前仅在隔离 Wiki 副本生效，不是已经发布到 3100。上线前单独批准数据导入／冲突处理计划；保留生产当前 revision、全部历史快照、traces、run-replays、imports、用户确认及删除事件，核对逐包 hash，不把测试合成 #21、测试 SQLite 或临时 DeepSeek 配置带入生产，也不覆盖正在写入的 Wiki。当前没有可直接向现有生产集合合并这些记录的发布命令；不得把下文整库搬迁命令当作增量合并工具。

本增量 Goal 的最终验证要求 Windows 与 WSL Node 22.19.0 的同 SHA `typecheck/build`、适用 `test:fast` 及秘密扫描。按用户授权规划者裁决，Windows 完整执行含浏览器 UI 的 `test:fast`；WSL 仅排除[契约明确列出的四个缺浏览器 UI 文件](wikiskill-trace-bundles.md#失败与验证)，其余全部执行。Linux UI 留待另获批准推送后的 PR CI，不冒充当前已通过。其固定 SHA 的规划者终审、用户接受以及后续集成／部署仍须分别记录。判分由评分 v2 Goal 负责，两个 Goal 合入后的 run 选题／判分接线另行实现；发布此页面不代表该接线已完成，不自动发起模型调用或重跑历史评测。

## 页面删除增量（2026-11-12）

普通删除入口及拒绝/保留边界见[删除契约](wikiskill-trace-bundles.md#用例删除与归档)。本增量仅在隔离实例验证，不导入合成归档、不执行生产删除。最终固定 SHA 的 Windows/WSL检查、秘密扫描、规划者独立终审及用户一次性接受由本 Goal 单独记录，不能继承历史交付的结论。

接受不等于部署或生产数据变更批准。另获部署授权并上线后，由用户在用例页确认、填写理由，删除 #22–#24；#21、#16 不在这次生产删除范围。若对照冻结或仍被执行占用，按页面原因停止，不直接改快照、绕过拒绝或清理崩溃预约。删除不重分组、不改知识库条目，不自动开始模型评测。

## 1. 固定交付身份，再批准推送／合并

- 记录用户明确接受的完整SHA、room分支、独立审查、Windows和WSL Linux同源的 `typecheck/build/test:fast/test:smoke` 输出及秘密扫描。任何后续代码提交都产生新候选，不能继承旧SHA的最终接受。
- 用户批准后才推送该room分支；PR目标为develop，保留merge commit，不squash/rebase/force。PR和CI审查必须针对精确head，不能推送未被接受的新提交。
- develop若已前进，先停下说明差异，另获同步/集成授权；新的合并SHA须重新验证并取得用户确认，不把room旧SHA等同于集成结果。
- 按仓库发布流程为被接受的集成SHA建立不可移动的release指针，经独立审查的release→main PR发布；不在main/develop直接写实现提交。生产运行main的已发布精确SHA，之后同步main→develop。以上操作均另等用户批准，不在本Goal执行。

## 2. 批准生产停写和备份（不靠端口猜进程）

操作前明确3100的worktree/branch/SHA、进程和启动器、`PI_CODING_AGENT_DIR`、`PI_SQLITE_PATH`、`CAFF_WIKISKILL_DATA_DIR`（未配置也要记录）、日志、上传目录、外部集成及回滚位置。核实正在运行的进程归属、所有活动turn和评测；停止新写入并等现有任务结束后，才停该实例。若实际环境与发布记录不符，停止询问。

另行批准并校验：

- 生产agent数据（尤其 `badcase-global`、`badcase-capture`、认证/角色/模型配置）、已配置的独立 Wiki 数据目录及SQLite一致性备份；秘密备份仅存私有位置、不进代码或证据。
- 3268**原始未迁移**集合及所有批准的captureRoots停止写入、全树hash/计数。M6迁入副本不能再次作为此迁移命令的来源；`wiki_migration_already_relocated` 不是可忽略警告。
- 本机镜像、真实仓库clone/记录HEAD、Linux运行时与现场依赖缓存仍单独保管；迁移不会复制它们，不能删源来“验证独立”。

## 3. 在生产宿主执行离线迁移命令（先新目录，绝不覆盖3100现有agent）

只在用户单独批准此阶段后，在要发布的代码SHA上构建并准备私有配置。3100 若仍以仓库内 `E:\\pythonproject\\caff\\.pi-sandbox` 为 agentDir，**必须将 Wiki 全局数据放到仓库外**，不能关闭布局保护。先在批准的启动器/本次迁移进程中设置 `CAFF_WIKISKILL_DATA_DIR` 为例如 `%LOCALAPPDATA%\\CAFF\\wikiskill` 展开后的实际绝对路径；目标必须全新且在所有源项目目录外。只设置此项，不搬 agentDir、认证、SQLite或本实例采集目录。评测 CLI 也使用同一变量及原 `PI_CODING_AGENT_DIR`。

迁移 JSON 中 `globalRoot` 始终是源，`destinationAgentDir` 填这个新 Wiki 数据目录（环境变量已设时实际优先取它），避免配置与环境产生误解：

```json
{
  "globalRoot": "<3268原始agent>/badcase-global",
  "sourceWorktree": "<受信CAFF工具checkout绝对路径>",
  "captureRoots": ["<批准的原始captureRoot绝对路径>"],
  "destinationAgentDir": "<与 CAFF_WIKISKILL_DATA_DIR 一致的全新绝对路径>"
}
```

captureRoots须覆盖所有历史快照和样例模型版本，不能只抄当前正式题。配置不含密钥、不提交，目标**必须尚不存在**，不能填正在使用或已有生产agent目录。

```sh
node scripts/badcase-capture/migrate-wiki-layout.cjs --config '<绝对migration.json路径>' --plan
node scripts/badcase-capture/migrate-wiki-layout.cjs --config '<绝对migration.json路径>' --run --confirmed --expected-plan '<刚输出的planHash>'
```

核对源revision/计数/21seal等实际清单及目标路径后才执行run；再次用同一命令应 `migrated:false`。记录源全树hash不变、目标各文件hash/ID/审核状态一致。缺材料/活动写者/源漂移/目标冲突立即停止，不覆盖、不自动重试、不删除staging；完整边界见[迁移契约](wikiskill-data-migration.md)。M6的21seal/861CAS是当时副本实测，不硬编码为未来源数据数量。

**此命令不合并现有生产集合。** 校验staging后，向用户展示实际生产已有Wiki数据及冲突，单独批准数据切换方案：

- **推荐保留原生产 agentDir**，将独立 `CAFF_WIKISKILL_DATA_DIR` 指向验收后的完整迁移目录；三项数据始终成组保留，不复制回仓库内 `.pi-sandbox`。原 agentDir 的 capture/projects、policy、认证和其他数据不动。已有 Wiki 历史先备份，不自动合并；目标已有 imports/receipt 或冲突则停止，不能覆盖。原目录外置且未设置此项的旧布局仍可沿用，但源仓库内布局不会因此获准。
- 或另行批准新的agentDir及角色/配置迁入和启动器切换。离线迁移**不复制**auth、模型配置、SQLite、采集授权，不得把空配置目录直接当生产agent启动；生产原有认证/聊天数据不得被副本替换。
- 不手改历史快照中的captureRoot、ID或hash。位置映射和根receipt必须随数据保留，否则会拒绝或无法证明不回源。保留staging供同计划幂等复核；切换副本另逐文件校验，不能对现有生产目录重跑迁移当作promote。

## 4. 批准重启，核对新实例身份

在生产已发布精确SHA安装/构建，使用已确认的生产启动器、端口3100及原聊天SQLite；确认重启进程继承实际绝对路径的 `CAFF_WIKISKILL_DATA_DIR`，只变更批准的这项数据路径与Wiki runtime配置。页面预分类/归纳的显式runtime JSON、WSL发行版和固定镜像照[Windows入口](wikiskill-windows.md)配置，不设置服务全局 `GIT_CONFIG_*`，不迁入3268的SQLite/日志/认证。保留原外部集成策略，不能继承测试环境的变量或打开新的副作用。

启动后核对健康、运行SHA/进程、数据库和agent路径、无意外活动任务；确认 `/api/wikiskill` 返回200，再只读检查Wiki用例、经验两栏、候选、M4门槛/测试与未采纳解读。分别检查迁入用例从外置数据目录的 imports 解析、本实例新封存用例从原 agentDir/badcase-capture 解析，两者均通过预检；缺失导入材料必须拒绝、不得回源。重新生成只读plan；旧planHash不作上线执行授权。启动失败或路径/数量/hash不符，按批准的回滚方案恢复旧代码和整组数据，不做破坏性现场修补。

## 5. 单独批准上线真实GPT复测和模型用量

- 使用一条用户批准的真实GPT用例：真实仓库clone、采集开启、正常消息标记→预分类→人工归类；不要把正常探针冒标badcase凑数。也可在明确批准后对迁入的真实GPT登记题做只读准入和原版回放。
- 确认该题完整材料、记录HEAD、依赖、回调、resume前缀（如适用）、模型 `openai-codex/gpt-6.1-sol` / xhigh / Fast关闭 / SSE；宿主access仅内存，经10090，无refresh/直连回退。安全扫描的SQLite单行读取权限另确认；不要借复测自动扩大读取范围。
- 用受版本管理的 `run-wiki-evaluation.cjs --plan` 核对新计划；批准本次额度和规则后才 `--run --confirmed --expected-plan <hash> --output <新JSONL>`。页面只读观察进度、完成结果和已知token，确认容器删除、日志/产物无凭据。真实输出、持续时间、用量与准入/行为结论分别报告；原版单例不产生采纳结论。
- 旧字面M4候选bc807f8a未采纳。本轮评分v2候选050be1fb已获批并完成唯一D8批次，#20不过，按D7不采纳；#10技术error致验证不完整。上线单例复测不是重判/补齐该批或第三批开跑的授权，也不允许自动改生产提示词。基线叠加仍须另有明确采纳。

保存上线SHA/迁移收据/计数与hash、页面截图/回放结果及用户裁决于私有或忽略证据目录。失败先保留事实、暂停，再由用户决定回滚或新修复。只有全部批准阶段执行并复测通过，才能称已部署；当前隔离验收不作此声称。
