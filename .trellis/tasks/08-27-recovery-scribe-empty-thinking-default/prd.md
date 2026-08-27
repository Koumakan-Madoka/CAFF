# Fix Recovery Scribe Empty Thinking Defaults

## Goal

修复未设置 `PI_THINKING`、`CAFF_DIGEST_THINKING` 和
`CAFF_RECOVERY_THINKING` 时，Recovery Scribe 启动默认配置得到空
`thinking`，进而使 server composition 与 stale-restart 启动失败的问题。

## Requirements

- 仅在 Recovery Scribe 的启动默认链末端将解析后的空 `thinking`
  规范化为 `off`。
- 非空配置保持原值；非法非空 `thinking` 必须继续 fail closed。
- 保持全局 `DEFAULT_THINKING`、Pi 通用默认解析、管理 API 严格校验、
  provider/model/凭据与生产配置不变。
- 保持无效模型、非法超时与其他 Recovery Scribe 配置校验 fail closed。
- 先在清空相关 PI 环境变量的条件下固化回归红测，再实现修复。

## Non-Goals

- 不修改全局 Pi thinking 默认值或其他 agent/digest/skill-draft 的默认行为。
- 不放宽持久化 Recovery Scribe 配置的输入校验。
- 不修改 schema、公开 API、UI 契约、依赖或生产 3100 实例。
- 不通过给 CI 或测试夹具补环境变量掩盖无环境启动问题。

## Acceptance Criteria

- [ ] 清空相关 PI/Recovery/Digest 环境变量时，两条
      `cross-conversation-delivery-wiring` server composition 用例和
      `message-recovery` stale-restart 用例可先复现失败、修复后通过。
- [ ] 无环境启动得到 Recovery Scribe `thinking=off`。
- [ ] 显式合法非空 thinking 保持不变；显式非法非空 thinking 仍拒绝。
- [ ] 无效模型和非法超时等配置仍 fail closed。
- [ ] Recovery/config/HTTP/UI/message/server composition 聚焦测试通过。
- [ ] `check`、typecheck、build、smoke 与完整回归完成，非绿基线逐项记录。
- [ ] 可执行 runtime/backend/unit-test spec 与 Trellis 证据更新并校验。
- [ ] 精确候选 SHA 获独立 commit-pinned 复审批准。
- [ ] 精确候选在隔离环境完成无 PI 环境变量启动与恢复路径验收，生产
      3100 不部署、不重启、不改配置。

## Technical Contract

- Input: `resolveThinkingSetting(...)` 在 Recovery Scribe 启动默认链中返回的
  string。
- Normalization: 仅当该值严格为空字符串时输出 `off`，否则原样输出。
- Validation matrix: empty -> `off`; supported non-empty -> unchanged;
  unsupported non-empty -> existing validation error; unavailable model and
  invalid integer limits -> existing validation errors。
- Good/Base/Bad: empty environment is Good after normalization; explicit
  supported thinking is Base and unchanged; `bogus` thinking is Bad and rejected。

## Likely Files

- `server/domain/conversation/message-recovery.ts`
- Recovery/server-composition regression tests under `tests/`
- `.trellis/spec/backend/message-recovery.md`
- `.trellis/spec/unit-test/runtime-tests.md`
