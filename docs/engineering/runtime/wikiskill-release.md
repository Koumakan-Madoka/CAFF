# WikiSkill 发布审批与上线复测

这是用户最终接受**之后**的运行手册，不是执行授权。当前 Goal 只在3268验证，不推送、不合并、不读取或修改3100。发布每个有副作用的阶段都须用户另行批准；最终接受功能也不等于采纳任何提示词候选。

## 1. 固定交付身份，再批准推送／合并

- 记录用户明确接受的完整SHA、room分支、独立审查、Windows和WSL Linux同源的 `typecheck/build/test:fast/test:smoke` 输出及秘密扫描。任何后续代码提交都产生新候选，不能继承旧SHA的最终接受。
- 用户批准后才推送该room分支；PR目标为develop，保留merge commit，不squash/rebase/force。PR和CI审查必须针对精确head，不能推送未被接受的新提交。
- develop若已前进，先停下说明差异，另获同步/集成授权；新的合并SHA须重新验证并取得用户确认，不把room旧SHA等同于集成结果。
- 按仓库发布流程为被接受的集成SHA建立不可移动的release指针，经独立审查的release→main PR发布；不在main/develop直接写实现提交。生产运行main的已发布精确SHA，之后同步main→develop。以上操作均另等用户批准，不在本Goal执行。

## 2. 批准生产停写和备份（不靠端口猜进程）

操作前明确3100的worktree/branch/SHA、进程和启动器、`PI_CODING_AGENT_DIR`、`PI_SQLITE_PATH`、日志、上传目录、外部集成及回滚位置。核实正在运行的进程归属、所有活动turn和评测；停止新写入并等现有任务结束后，才停该实例。若实际环境与发布记录不符，停止询问。

另行批准并校验：

- 生产agent数据（尤其 `badcase-global`、`badcase-capture`、认证/角色/模型配置）及SQLite一致性备份；秘密备份仅存私有位置、不进代码或证据。
- 3268**原始未迁移**集合及所有批准的captureRoots停止写入、全树hash/计数。M6迁入副本不能再次作为此迁移命令的来源；`wiki_migration_already_relocated` 不是可忽略警告。
- 本机镜像、真实仓库clone/记录HEAD、Linux运行时与现场依赖缓存仍单独保管；迁移不会复制它们，不能删源来“验证独立”。

## 3. 在生产宿主执行离线迁移命令（先新目录，绝不覆盖3100现有agent）

只在用户单独批准此阶段后，在要发布的代码SHA上构建并准备私有配置：

```json
{
  "globalRoot": "<3268原始agent>/badcase-global",
  "sourceWorktree": "<受信CAFF工具checkout绝对路径>",
  "captureRoots": ["<批准的原始captureRoot绝对路径>"],
  "destinationAgentDir": "<生产宿主上全新相邻staging目录绝对路径>"
}
```

captureRoots须覆盖所有历史快照和样例模型版本，不能只抄当前正式题。配置不含密钥、不提交，目标**必须尚不存在**，不能填正在使用或已有生产agent目录。

```sh
node scripts/badcase-capture/migrate-wiki-layout.cjs --config '<绝对migration.json路径>' --plan
node scripts/badcase-capture/migrate-wiki-layout.cjs --config '<绝对migration.json路径>' --run --confirmed --expected-plan '<刚输出的planHash>'
```

核对源revision/计数/21seal等实际清单及目标路径后才执行run；再次用同一命令应 `migrated:false`。记录源全树hash不变、目标各文件hash/ID/审核状态一致。缺材料/活动写者/源漂移/目标冲突立即停止，不覆盖、不自动重试、不删除staging；完整边界见[迁移契约](wikiskill-data-migration.md)。M6的21seal/861CAS是当时副本实测，不硬编码为未来源数据数量。

**此命令不合并现有生产集合。** 校验staging后，向用户展示实际生产已有Wiki数据及冲突，单独批准数据切换方案：

- 若保留原生产agentDir，只可在已停写/备份后，将完整新 `badcase-global`、根级 `wiki-migration.json` 及配套 `badcase-capture/imports` 作为一组切换；保留原生产capture的projects、policy及其他数据。已有Wiki历史需保留备份，已有imports/receipt或不能隔离的冲突则停止，另做审查后的合并方案，不能直接覆盖。
- 或另行批准新的agentDir及角色/配置迁入和启动器切换。离线迁移**不复制**auth、模型配置、SQLite、采集授权，不得把空配置目录直接当生产agent启动；生产原有认证/聊天数据不得被副本替换。
- 不手改历史快照中的captureRoot、ID或hash。位置映射和根receipt必须随数据保留，否则会拒绝或无法证明不回源。保留staging供同计划幂等复核；切换副本另逐文件校验，不能对现有生产目录重跑迁移当作promote。

## 4. 批准重启，核对新实例身份

在生产已发布精确SHA安装/构建，使用已确认的生产启动器、端口3100及原聊天SQLite；只变更批准的数据路径与Wiki runtime配置。页面预分类/归纳的显式runtime JSON、WSL发行版和固定镜像照[Windows入口](wikiskill-windows.md)配置，不设置服务全局 `GIT_CONFIG_*`，不迁入3268的SQLite/日志/认证。保留原外部集成策略，不能继承测试环境的变量或打开新的副作用。

启动后核对健康、运行SHA/进程、数据库和agent路径、无意外活动任务；只读检查Wiki用例、经验两栏、候选、M4门槛/测试与未采纳解读。检查导入现场仅从生产副本解析、无回源，重新生成只读plan；旧planHash不作上线执行授权。启动失败或路径/数量/hash不符，按批准的回滚方案恢复旧代码和整组数据，不做破坏性现场修补。

## 5. 单独批准上线真实GPT复测和模型用量

- 使用一条用户批准的真实GPT用例：真实仓库clone、采集开启、正常消息标记→预分类→人工归类；不要把正常探针冒标badcase凑数。也可在明确批准后对迁入的真实GPT登记题做只读准入和原版回放。
- 确认该题完整材料、记录HEAD、依赖、回调、resume前缀（如适用）、模型 `openai-codex/gpt-6.1-sol` / xhigh / Fast关闭 / SSE；宿主access仅内存，经17890，无refresh/直连回退。安全扫描的SQLite单行读取权限另确认；不要借复测自动扩大读取范围。
- 用受版本管理的 `run-wiki-evaluation.cjs --plan` 核对新计划；批准本次额度和规则后才 `--run --confirmed --expected-plan <hash> --output <新JSONL>`。页面只读观察进度、完成结果和已知token，确认容器删除、日志/产物无凭据。真实输出、持续时间、用量与准入/行为结论分别报告；原版单例不产生采纳结论。
- 第二轮候选050be1fb目前只有diff确认，仍未批准运行。上线单例复测不是其开跑授权，也不允许自动重跑M4或自动改生产提示词。基线叠加须另有明确采纳；当前M4候选bc807f8a未采纳。

保存上线SHA/迁移收据/计数与hash、页面截图/回放结果及用户裁决于私有或忽略证据目录。失败先保留事实、暂停，再由用户决定回滚或新修复。只有全部批准阶段执行并复测通过，才能称已部署；当前隔离验收不作此声称。
