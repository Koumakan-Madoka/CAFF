# PRD: Skill-Test Isolation Foundation

## Goal

- 让 skill-testing 具备可作为 publish gate 前置条件的隔离执行基础。
- 采用 `OpenSandbox + thin bridge/policy` 的 container-first 方案，避免把“本地文件夹隔离”误当成完整沙盒。
- 默认保证 skill test 不读写真实 `.trellis`、shared published skills、真实 chat/memory DB 或其他 agent sandbox。

## Problem Statement

- 当前 skill-testing 运行链路仍偏向宿主机共享 sandbox/store/project 语义。
- 如果将现状直接作为 skill proposal 发布闸，测试执行可能污染真实 `.trellis`、shared `.pi-sandbox/skills`、chat DB、memory cards 或 private mailbox。
- Trellis 类 skill 需要测试读写 project context 的能力，但默认不能触碰 live project。
- OpenSandbox 可提供容器边界，但 CAFF 仍需要 thin bridge/policy 来治理工具权限、路径/DB/env 虚拟化、Trellis 访问档位和审计证据。

## Scope

### In Scope

- 定义 skill-test isolation contract：run/case/turn 颗粒度、资源布局、env/path/db/network/audit 字段。
- 接入 `OpenSandbox` 作为 MVP container backend 候选，保留 driver 接口便于后续替换或扩展。
- 实现 thin bridge/policy：tool whitelist、path rewrite、Trellis project root rewrite、independent SQLite/store、env scrub、audit log、network/egress policy。
- 支持 Trellis 访问档位：`none | fixture | readonlySnapshot`；`liveExplicit` 仅人工显式 opt-in，不进入自动 regression 或 publish gate。
- 每个 test case 具备独立可写世界；同一 run 可共享只读 skill/fixture/snapshot 基底；同一 case 的多 turn 共享 case 状态。
- 增加污染检查与失败诊断：run/case id、sandbox logs、policy rejects、store path、Trellis mode、egress mode、pollution check result。

### Out Of Scope

- Agent-facing skill proposal / patch draft / publish UI。
- 完全无人审核的 shared skill 自动发布。
- L1/L2 memory 实现、memory recall、memory prompt 注入。
- 仅靠本地 temp directory 或 in-process JS sandbox 作为最终 publish gate 隔离。
- 默认 live `.trellis` 或 live shared skill 写入。

## Isolation Strategy

- **Run-level**: 创建只读 skill snapshot、fixture/snapshot 基底、总审计日志和 run metadata。
- **Case-level**: 每个 case 拥有独立 sandbox root、private dir、writable project root、SQLite/store、tool audit 和 output dir。
- **Turn-level**: 同一 case 内多轮共享 case 状态；turn 只做工具额度、超时和 policy 限制，不单独起新隔离世界。
- **Container boundary**: OpenSandbox 负责容器生命周期、文件/进程/网络边界和 sandbox 内执行。
- **CAFF policy boundary**: thin bridge/policy 负责“能做什么、写到哪里、如何审计”，不能被 OpenSandbox 替代。

## Requirements

### 1. Isolation Driver Contract

- 引入明确的 isolation driver 边界，例如 `SkillTestIsolationDriver` / `SkillTestIsolationContext`。
- Driver 必须能创建 run context、创建 case context、执行 case、收集日志、销毁资源。
- OpenSandbox 不可用时必须 fail closed，不能静默退回 live host 环境作为 publish gate。
- 所有 case 结果必须记录 driver name/version、sandbox id、run id、case id 和 cleanup status。

### 2. Thin Bridge / Policy

- Tool allowlist 默认最小化；未声明工具默认拒绝。
- File read/write 必须走 allowlist/path rewrite，不允许访问真实 repo root、真实 `.trellis`、shared `.pi-sandbox/skills` 或其他 agent private dir。
- DB/store 必须指向 case 级 SQLite/store；不得复用主服务真实 DB 句柄。
- Env 必须重写 `PI_AGENT_SANDBOX_DIR`、`PI_AGENT_PRIVATE_DIR`、Trellis project root、SQLite/store path、skill snapshot path。
- Network 默认 deny 或最小 egress policy；任何外部 egress 必须记录 policy 与理由。
- Policy rejects 必须进入 run evidence，供 UI/API/后续 publish gate 判断。

### 3. Trellis Fixture / Snapshot

- `none`: 普通 skill 默认，不提供 `.trellis`。
- `fixture`: 在 case project root 中提供最小 Trellis fixture，用于稳定测试 `trellis-init`、`trellis-write`、before-dev 等能力。
- `readonlySnapshot`: 复制并脱敏真实 `.trellis/spec`、workflow、目标 task 等到 case root；写操作只允许 copy-on-write，不回写真实项目。
- `liveExplicit`: 仅人工显式启用，必须带确认、备份/diff 和审计；不允许作为自动 regression 或 publish gate 默认模式。

### 4. Pollution Checks

- 运行前后检查真实 `.trellis`、shared skills root、真实 chat/memory DB、agent private dir 是否出现非预期改动。
- 污染检查失败必须使 case/run 进入 failed 或 unsafe verdict，并阻断 publish gate。
- Cleanup 失败要保留诊断，不得吞掉错误。

### 5. Backward Compatibility

- 非 publish-gate 的轻量本地调试可以保留显式 legacy/local 模式，但必须在结果中标注 `notIsolated`，不得冒充 isolated gate。
- 现有 dynamic/full skill-testing 语义、case schema、issues envelope 和 regression buckets 应尽量保持兼容。
- UI/API 后续展示可以分阶段做；MVP 至少要在 run detail/evaluation JSON 中保留 isolation evidence。

### 6. Skill-Test Frontend Exposure

- Skill Tests 顶部工具栏应暴露本次运行默认值：`isolationMode`、`trellisMode`、`egressMode`、`publishGate`。
- 默认安全预设为普通 skill 使用 `isolated + none + deny`；Trellis 类 skill 允许显式切到 `fixture` 或 `readonlySnapshot`。
- `legacy-local` 需要在 UI 上明确标注为“仅本地调试 / not isolated”，不能误导用户把结果当成 publish-gate 证据。
- `liveExplicit` 不进入常规下拉；若未来需要前端入口，应放到危险高级设置并带二次确认。
- case 级 override 可以后续补，但 MVP 至少要支持 run/batch-run 级默认值，不要求用户手写 API payload。

## Integration Points

- Skill test controller: `server/api/skill-test-controller.ts`
- Skill test frontend: `public/eval-cases.html`, `public/skill-tests.js`
- Runtime sandbox/env: `server/domain/conversation/turn/agent-sandbox.ts`, `lib/pi-runtime.ts`
- Tool governance: `server/domain/runtime/agent-tool-bridge.ts`
- Prompt/skill loading: `server/domain/conversation/turn/agent-prompt.ts`, `server/domain/conversation/turn/agent-executor.ts`, `lib/skill-registry.ts`
- Storage/migrations if evidence fields need persistence: `storage/sqlite/migrations.ts`
- Tests: `tests/skill-test/`, `tests/runtime/agent-tool-bridge.test.js`, `tests/runtime/skill-loading.test.js`

## Acceptance Criteria

- [x] Skill-test execution has an explicit isolation driver contract with an OpenSandbox-backed implementation path.
- [x] Each test case runs in an isolated writable environment and cannot mutate another case's state.
- [x] Default isolated runs cannot read/write live `.trellis`, shared published skills, real chat/memory DB, or other agent private dirs.
- [x] Trellis-related skill tests can run against `fixture` or `readonlySnapshot` modes without touching live project state.
- [x] Network and tool capabilities are governed by policy, with reject reasons preserved in run evidence.
- [x] Pollution checks detect and fail unsafe runs before they can be treated as publish-gate evidence.
- [x] OpenSandbox unavailability or real cleanup failure fails closed for publish gate usage; `not found`/404 during cleanup is treated as already cleaned.
- [x] Existing skill-test dynamic/full evaluation behavior remains compatible where isolation is not the tested behavior.
- [x] Skill Tests 前端为 run / batch-run 暴露 `isolationMode`、`trellisMode`、`egressMode`、`publishGate`，用户无需手写 API payload 即可切换 `fixture` / `readonlySnapshot`。
- [x] OpenSandbox skill-test live panel can stream sandbox runner progress, tool events, and assistant text deltas before the terminal run result.

## Validation Plan

- Add unit tests for isolation context construction and policy defaults.
- Add skill-test regression where two cases attempt writes and prove per-case isolation.
- Add Trellis fixture/snapshot test proving `trellis-write` targets case project root, not live `.trellis`.
- Add policy rejection test for blocked live project path, shared skills path, and network/egress where supported.
- Add pollution check test that simulates a forbidden live change and verifies publish gate rejection.

## Follow-up: OpenSandbox In-Container Runner POC

This task establishes the isolation contract, case world layout, policy evidence, and fail-closed publish-gate semantics. The current OpenSandbox adapter may prepare a remote case world and record sandbox evidence, but it must not be treated as full container execution unless the adapter implements `startRun` and evidence reports `execution.runtime = "sandbox"`.

Next phase should prove a minimal real container execution path before expanding publish-gate support:

- Implement `OpenSandboxSkillTestIsolationDriver.startRun` for a single-case runner POC.
- Add a sandbox-side Node runner that accepts the existing case input contract and returns the existing evaluation JSON envelope.
- Inject only case-scoped env, skill snapshot path, project root, SQLite/store path, policy config, and skill-test chat bridge run/case identifiers into the sandbox process.
- Preserve dynamic/full skill-loading behavior, including `/skills/<skillId>/SKILL.md` reads from the case skill snapshot.
- Enforce or explicitly fail publish-gate evidence for `egressMode = deny` when the backend cannot apply network restrictions.
- Collect sandbox stdout/stderr, assistant text deltas, policy rejects, chat bridge auth/TTL/reject evidence, cleanup status, remote paths, and runner errors into isolation evidence.

POC success criteria:

- One full skill-test case executes inside OpenSandbox and reports `execution.runtime = "sandbox"`.
- The returned evaluation JSON stays compatible with current dynamic/full skill-test results.
- The case cannot read/write live `.trellis`, shared skills, real chat/memory DB, or another agent sandbox.
- Publish-gate mode remains fail-closed when OpenSandbox is unavailable, cleanup fails, execution falls back to host, bridge credentials cannot be scoped to the case/run, or deny-egress is not enforced.

## Notes

- OpenSandbox is the preferred container backend candidate, but CAFF must still own policy, Trellis virtualization, DB routing, and audit semantics.
- This task intentionally does not implement skill proposal publishing. Proposal work should start only after isolated testing can produce trustworthy evidence.
