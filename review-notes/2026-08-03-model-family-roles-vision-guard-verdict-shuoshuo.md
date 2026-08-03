---
feature_ids: [CAFF-MODEL-FAMILY-ROLES]
topics: [completion, vision-guard, verdict, user-journey, acceptance]
doc_kind: vision-guard-verdict
created: 2026-08-03
---

# Vision Guard Verdict: CAFF Model-family Roles — APPROVE

Guardian: `cat-mcmk1s9b` / Siamese / k3-256k（非作者、非 reviewer 的第三独立个体）
Merged truth: `origin/main@4e2c532`（squash `4bbc260` + truth sync `98eeb8d` + packet `4e2c532`）
Guardian worktree: `E:\pythonproject\caff-model-family-postmerge`（detached `4e2c532`，全新 `npm ci` + build）
Runtime isolation: 临时 agentDir/SQLite（`%TEMP%\caff-visionguard-main`），port 3210；未触碰 Redis 6399 与 3003/3004。
Browser evidence: 真机 headless Edge（本机 CDP 驱动，非转述作者截图），`%TEMP%\cat-cafe-evidence\visionguard-main\`。

**Verdict: APPROVE。** operator experience 与两条 User Journey 全部与 merged main 实际行为匹配，无用户可见 mismatch。

## 1. Operator experience ↔ 实际状态 ↔ 匹配表

| Surface | operator 期望 | merged main 独立实测 | 证据 | 判定 |
|---|---|---|---|---|
| 模型供应商 | 前端新增/编辑/验证/清除/移除，凭据安全 | PUT `team-gateway` 成功；响应 DTO 只有 `hasApiKey:true`，密钥 `vg-secret-key-12345` 在整页 DOM 中零出现（`hasSecretLeak:false`）；`durability:"directory_sync_unsupported"` 显式建模；agentDir 留下 `models.json.pre-model-provider-config.*` 无 TTL 备份 | 02-providers-desktop.png；API 响应原文 | met |
| 角色目录/详情 | 7 个永久 family role + custom；family 无 Persona/Skills | GET `/api/agents` 恰好 7 个 `role-family-*`，`systemManaged:true`；family 详情无 Persona/Skills 输入（仅边界说明文案），锁定字段 `id` 回显即 422 `role_locked_field`，family profile 带 personaPrompt 即 422 `family_persona_not_allowed`；custom 角色 Persona + 跨族 Profile（base gpt / profile qwen）201 创建成功 | 01-roles-desktop.png；03-role-detail-qwen.png；API 422/201 原文 | met |
| 新建聊天 | defaults 只预选，提交前确认 | dialog 打开时仅 `role-family-qwen` 预勾选（唯一 default），6 个 unavailable 角色 checkbox disabled；`app-shell` inert；提交后 `agentCount:1` 持久化 | 04-new-conversation-defaults-desktop.png；05-conversation-created-desktop.png；`/api/conversations` | met |
| 已有聊天设置 | unavailable 原因 + 修复路径 | 删除 provider 后参与者卡显示原文："当前配置不可运行：默认模型不可用。可改选有效运行 Profile、修复角色与模型配置，或取消勾选移除此参与者。" | 08-conversation-settings-unavailable-desktop.png + DOM 原文 | met |
| Runtime | 失效时结构化阻断，不静默换模/clamp | drift 后角色保留 `team-gateway/qwen3-max` 引用并显式 `default_model_missing`（`familyModelCount` 109→108），无跨族 fallback；`runtime-role-resolution` / `configured-model-catalog` / `model-family-registry` 在 merged main 独立跑 8/8 PASS | API drift 实测；测试输出 | met |
| 历史与迁移 | 旧 seed 退出但历史保留 | 见 Migration Journey 表 | 迁移测试 + 重启实测 | met |

## 2. User Journey ↔ 实际行为 ↔ 匹配表

### Primary Journey — 配置模型族角色并创建聊天

| 步骤 | merged main 实测 | 判定 |
|---|---|---|
| 1. Provider 页新增连接与模型，密钥只写不回显，显式 family | PUT `team-gateway` + `qwen3-max family=qwen`；GET/bootstrap 无明文、无 reference；catalog 出现 `team-gateway/qwen3-max/qwen/explicit` | met |
| 2. catalog 刷新后角色显示真实 availability | 初始 7 角色全部 `default_model_missing`；加 provider 后 qwen `familyModelCount:109` 但仍 `default_model_missing`（原因：未选 base），其余 6 族保持不可用并给出原因 | met |
| 3. 角色详情选同族 base/thinking/Profiles；family 无 Persona/Skills，custom 保留 | qwen 保存 `qwen3-max + high + profile(quick/low)` 后 `available`；family persona 422；custom 跨族 profile + persona 201 | met |
| 4. defaults 预勾选、dialog 确认后才创建 | 设 qwen 为 default → dialog 仅预勾 qwen；提交后 `愿景守护验收` 会话持久化 1 参与者 | met |
| 5. 每轮运行前重验，漂移结构化阻断 | drift 实测显式不可用 + 恢复指引；runtime resolution 契约测试独立 PASS（不创建 placeholder、不静默 clamp） | met |
| 6. 已有会话 participant 失效可修复/移除，历史不改写 | 会话设置卡显示不可用原因 + 三条恢复路径；重启后历史会话与角色配置完整保留 | met |

### Migration Journey — 保留旧身份与用户状态

| 步骤 | merged main 实测 | 判定 |
|---|---|---|
| 1. 迁移前不覆盖备份 + 单事务重建边界 | `tests/storage/model-family-role-migration.test.js` 在 merged main 独立跑 4/4 PASS（含 backup-once、transaction、identity-bound history） | met |
| 2. 旧九 seed 退出且重启不复活；用户状态逐项保留 | 真实服务器重启后：角色仍恰好 7 个，`legacy_revived:0`；会话、角色配置、defaults 全保留；fresh schema 永久 reserved 旧 ID | met |
| 3. backup/FK/audit 失败 fail closed/rollback | 迁移测试含 backup-helper 失败拒启、audit 失败回滚且备份可用两条红绿契约，独立 PASS | met |

## 3. 移动端与视觉核验（设计位独立判断）

- 375×812 真实视口：`scrollWidth === 375`（角色页与新建 dialog 均无横向溢出）；单栏布局、分组与状态徽章可辨认；dialog 全屏 sheet。
- 视觉语言与冻结 UI Gate 一致：暖中性实底、细边框、pill 标签、分组卡片、可运行/不可用状态色区分；管理 shell 内"角色管理 / 模型供应商"双 surface 同级清晰。
- 截图：`01/02/03/04/05/06/07/08` 共 8 张于 `%TEMP%\cat-cafe-evidence\visionguard-main\`（按 artifact hygiene 不入 Git）。

## 4. 独立验证清单

```text
npm ci + build @4e2c532                 PASS
model-family-role-migration.test.js     4/4 PASS（独立重跑）
runtime-role-resolution                 3/3 PASS
configured-model-catalog                3/3 PASS
model-family-registry                   2/2 PASS
model-family-roles-production.test.js   PASS（上一会话独立重跑于 fcae97f 代码，main 同源）
new-conversation-dialog.test.js         PASS（同上）
真实服务器全旅程（API + 真机 Edge）     上表全 met
```

## 5. Intentional boundaries 确认

loopback-only provider admin、session-local 验证状态、无 OAuth/市场/自动跨族 fallback——均为 spec 显式 non-goal，不是缺口。

[烁烁/k3-256k🐾]
