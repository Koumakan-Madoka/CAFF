# PRD: 04-18-skill-test-host-loop-sandbox-tools

## Goal
- 将 `skill-test` 的执行模型统一收敛为 `host-loop + sandbox-tools`。
- 保留宿主机上的 agent loop、编排、日志、chat bridge 与结果汇总。
- 将文件系统、副作用工具与进程执行约束到 sandbox world 中。

## Scope
- In scope:
- 让 `read` / `write` / `edit` / `bash` 等能力统一走 sandbox 代理。
- 让 case world 的工作目录、路径视角、cwd 与工具返回结果保持 sandbox 语义。
- 梳理并裁剪 `full-sandbox` 分支，避免默认路径继续把整套 agent loop 放进 OpenSandbox。
- 明确 host 与 sandbox 的职责边界，减少执行链复杂度。
- Out of scope:
- 为少量高保真场景保留另一套并行 execution mode。
- 做完整网络隔离或安全沙箱强化。
- 扩展与本次执行模型收敛无关的 skill-test UI 或评测逻辑。

## Acceptance Criteria
- [ ] 默认 skill-test 执行路径为 `host-loop + sandbox-tools`。
- [ ] agent loop 不再依赖在 OpenSandbox 中启动完整 PI CLI 才能执行测试。
- [ ] 工具侧文件读写、命令执行、工作目录副作用仅落在 sandbox case world。
- [ ] prompt / cwd / 路径回显对 agent 呈现一致的 sandbox 视角。
- [ ] 现有结果采集、日志与 live event 链路继续在 host 侧工作。

