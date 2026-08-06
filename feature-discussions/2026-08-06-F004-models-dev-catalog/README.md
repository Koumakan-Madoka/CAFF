---
feature_ids: [F004]
topics: [models.dev, catalog, provider-import, provenance, security, runtime]
doc_kind: discussion
created: 2026-08-06
status: approved_for_implementation
---

# F004 Kickoff Discussion and Decision Record

## Status

Operator 已在消息 `0001786011448504-000282-70c4ca08` 授权立即立项 P1，并同意继续推进 v2.1 设计。当前实现工作树为 `E:\pythonproject\caff-models-dev-catalog`，基线 `origin/main@092938a`。

## Operator Experience / 原始需求锚点

Operator 需要在 provider editor 中减少手工输入，但不希望外部目录悄悄改变 CAFF 的运行时契约或引入密钥泄露风险。确认的终态是“固定来源的目录 + 显式导入确认 + 可追溯 provenance”，而不是把远端数据直接写进用户配置。

## Explanation: vendored snapshot 是什么

“Vendored snapshot” means CAFF 将某一时刻的 models.dev 数据副本随代码提交，并记录来源 URL、上游 commit SHA、生成日期、payload hash 与许可证。这样离线运行和历史复现不依赖网络，也能让 reviewer 知道数据从哪里来。它不是把第三方数据宣称为 CAFF 自有代码；MIT license 和 source declaration 必须一起提交。在线刷新属于 P2，不能在 P1 里用未核验的网络结果替代固定快照。

## Confirmed Decisions

1. **P1 先做**：vendored snapshot、显式 allowlist 映射、provider-editor 导入向导。
2. **数据边界**：`models.json` 契约不扩展；catalog metadata/provenance 存在独立 cache，只有 operator 显式保存才写入用户配置。
3. **映射规则**：provider 默认值与 model-level `provider` override 合并，override 优先；未知方言必须手工配置；family 使用显式七族表，未知值标记未归类。
4. **安全规则**：完整展示 `env[]` 变量名；key 类变量必须来自 provider-specific allowlist；绝不读取、上传或持久化环境变量值。
5. **UI 规则**：目录元数据和 Pi runtime 实际支持的控制项分区展示；未映射的 `reasoning_options` 等字段不得伪装成可执行能力。
6. **分期**：P2 才做在线刷新（HTTPS、限额、schema 校验、ETag、原子替换、last-known-good）；P3 才考虑 cost/limit 的参考展示。

## Evidence Read

- CAFF provider/configuration boundaries: `server/domain/models/model-provider-config.ts`, `configured-model-catalog.ts`, `model-provider-persistence.ts`, `server/api/model-providers-controller.ts`.
- Existing UI surfaces: `public/personas/provider-editor.js`, `public/personas/provider-management.js`, `public/personas.html`.
- Official models.dev source audit: GitHub repository default branch `dev`, MIT license, `/api.json` provider map, multiple provider env names, and model-level provider overrides. Exact commit retrieval is currently blocked by TLS/network failure and remains an open item.

## Tradeoffs

- Explicit allowlists temporarily leave some providers as manual configuration, but prevent silently generating invalid or unsafe runtime configs.
- Keeping catalog cache separate means more projection code, but preserves the existing `models.json` contract and makes provenance/replacement auditable.
- Vendoring adds a snapshot update step, but gives deterministic offline behavior and avoids pretending an unverified remote payload is current truth.

## Design Gate

**Approved for implementation** for P1. The implementation must keep the unresolved upstream SHA/hash as a blocker for the snapshot asset itself; it may proceed with schema/tests/domain scaffolding without fabricating those values.

Architecture cell: `server/domain/models + model-provider persistence + model-providers controller + public/personas`

Map delta: none

Why: the feature extends the existing provider/configuration cell; no parallel store or runtime registry is introduced.

## Next Action

Create the P1 implementation plan, then use TDD for schema, override merge, env redaction, allowlist, family mapping, cache isolation, controller projection, and provider-editor import behavior.
