# Goal Session Reuse Continuity

## Goal

让 Goal Runner 自动续跑只在 provider Session 已知的 Goal 身份、版本和容量证据连续时复用旧 Session，同时修复 checklist 更新导致 continuation iteration 反复回到 1 的问题。

## Terminology

- **Goal ID**：Goal 生命周期的不可变身份。新建、替换或恢复 Goal 时生成新 ID；同一 Goal 内更新状态、owner 或 checklist 时不变。
- **Goal revision**：同一 Goal 的内容版本。objective、status、owner 或 checklist 变化时递增。
- **严格复用**：仅适用于 `source=goal-runner && goalAutoContinue=true` 的自动续跑。人工触发继续使用普通 Session reuse 判定。
- **Provider 已知 Goal 版本**：该 provider Session 最近一次实际收到完整 Goal 上下文时记录的 `goalId + goalRevision`。普通 resume 未重新投递 Goal 段时不得冒充已知新版本。

## Requirements

1. 每个规范化 Goal 暴露 `goalId` 和正整数 `revision`；旧 Goal 使用由原始 `createdAt + objective` 派生的稳定兼容 ID 和 revision 1。
2. `set`/替换与 `resume` 生成新 Goal ID、revision 1；pause/complete/owner/checklist/自动错误暂停保留 ID 并递增 revision。
3. checklist 更新迁移同一 Goal runner 的 epoch key，保留 iteration 和失败 streak；下一次 claim 必须从上一 iteration 继续。
4. Goal Runner 消息固化 claim 时的 `goalId`、`goalRevision` 和 iteration。
5. 自动续跑 resume 要求消息固化值、当前 Goal 和复用行三方 Goal ID/revision 一致；缺失或不一致时 fresh，并记录封闭 reason。
6. 自动续跑 usage ratio 必须严格小于 0.5；即使普通复用阈值配置得更高，达到 0.5 仍 fresh。更低的全局配置继续生效。
7. 人工触发不增加 Goal 身份/revision 门禁，继续沿用普通 Session reuse 契约。
8. 可复用行持久化 provider 实际已知的 Goal ID/revision。fresh 记录当前 Goal；resume 继承 claim 前快照，不能把未投递的 Goal 变化标记为已知。
9. 原子 claim 同时守卫 Goal ID/revision，兼容旧行的 null/null；迁移为 additive nullable columns。
10. 不修改 provider session 文件格式、prompt 字节、delta 注入、KV cache、privateOnly 或工具执行语义。

## Validation Matrix

| Case | Expected |
| --- | --- |
| 首次 Goal run | fresh；成功后 reusable 行记录当前 Goal ID/revision |
| 同 Goal/同 revision 自动续跑，usage < 0.5 | resume |
| Goal ID 变化 | fresh + `goal_identity_mismatch` |
| revision 变化 | fresh + `goal_revision_mismatch` |
| 旧复用行无 Goal 证据 | fresh + `goal_identity_missing` |
| usage ratio = 0.5 或更高 | fresh + `usage_ratio_above_threshold` |
| 普通阈值配置 > 0.5 | Goal Runner 仍以 0.5 为上限 |
| 人工消息且 Goal 元数据不匹配 | 按普通规则判定，可 resume |
| checklist 更新后再次 claim | iteration 连续递增，不回到 1 |
| 普通 resume 期间 Goal revision 外部变化 | reusable 行保留 provider 旧 revision，后续 Goal Runner fresh |

## Acceptance Criteria

- [ ] Goal ID/revision 生命周期与旧数据兼容测试通过。
- [ ] checklist 更新后 continuation iteration 连续。
- [ ] strict Goal Runner 的 identity/revision/50% 边界回归通过。
- [ ] 人工触发普通复用行为不变。
- [ ] SQLite additive migration、round-trip、restore、claim race guard 通过。
- [ ] executor A/B 验证实际 fresh/resume 和审计 reason。
- [ ] specs、check、双 typecheck、build、smoke 与相关测试通过。
- [ ] 隔离 3210 环境验证并取得用户人工验收。
- [ ] 精确候选 SHA 获得非作者独立 APPROVE。

## Non-Goals

- 不为同一 provider run 内模型自行更新 checklist 增加复用例外。
- 不收紧人工消息触发的 Session reuse。
- 不改变普通 Session reuse key、游标一致性或 idle 判定。
- 不修改 provider Session JSONL 或重新注入旧前缀。
