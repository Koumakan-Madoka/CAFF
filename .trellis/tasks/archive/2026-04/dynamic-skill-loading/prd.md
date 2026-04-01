# PRD: Skill 动态加载机制

## 背景

CAFF 的 skill 加载机制原为**静态全量注入**：所有配置在 agent 上的 persona skills 和 conversation skills 在每次 turn 构建提示词时，都会通过 `formatSkillDocuments()` 将全部 skill body 一次性写入 system prompt。这导致 token 浪费和提示词膨胀。

## 目标

实现 skill 动态加载机制，使 agent 只在需要时加载相关 skill 的完整内容。

## 采纳方案：描述符 + 按需加载

采用方案 1（描述符 + 按需加载），核心思路：
- 提示词中注入 skill 的 name + description（短摘要）作为描述符
- 当 agent 判断需要某个 skill 时，通过 `read-skill` 工具调用读取完整 SKILL.md
- 类似 pi 原生的 `<available_skills>` 模式

### 调研结论

- [x] pi 原生的 skill 机制（`<available_skills>` + `read tool`）是参考模型，CAFF 实现了自己的 `read-skill` 工具
- [x] `agent-chat-tools.js` 新增了 `read-skill` 命令
- [x] Trellis 的 skill 载入与 agent skill 互相独立，不冲突
- [x] Skill 间无依赖关系，无需特殊处理
- [x] 通过 `forceFull` 参数和默认 `dynamic` 模式保证向后兼容

## 实现概要

### 改动文件

| 文件 | 改动说明 |
|------|----------|
| `server/domain/conversation/turn/agent-prompt.ts` | `getSkillLoadingMode()` 默认 `dynamic`；`formatSkillDescriptors()` 只输出摘要；`formatSkillDocuments()` 支持 `forceFull` + 模式切换；read-skill 说明仅在 dynamic 模式注入 |
| `lib/agent-chat-tools.ts` | 新增 `read-skill` 命令，调用 `/api/agent-tools/read-skill` |
| `server/api/agent-tools-controller.ts` | 新增 `GET /api/agent-tools/read-skill` 路由 |
| `server/domain/runtime/agent-tool-bridge.ts` | `handleReadSkill()`：400 参数校验 → 409 无 registry → 404 不存在 → body 截断保护 (32768) → telemetry 事件记录 |
| `server/app/create-server.ts` | 将 `skillRegistry` 注入 `agentToolBridge` |
| `tests/runtime/read-skill.test.js` | 11 个测试：正常读取、404、400、409、截断、401、telemetry 成功/失败、外部目录、full/dynamic 模式提示词验证 |

### 设计决策

1. **Persona Skills 始终全量注入** — `forceFull: true`，agent 核心人设指令每 turn 必需
2. **Conversation Skills 走动态加载** — 只注入描述符，agent 通过 `read-skill` 按需加载
3. **默认 `dynamic` 模式** — `CAFF_SKILL_LOADING_MODE` 默认值为 `dynamic`
4. **环境变量运行时可切换** — `getSkillLoadingMode()` 每 turn 实时读取，无需重启
5. **Body 截断保护** — `MAX_SKILL_BODY_LENGTH = 32768`，超长自动截断

## 验收标准

- [x] 动态模式下 conversation skills 只注入描述符
- [x] Persona skills 始终全量注入
- [x] `read-skill` 工具可按需加载完整 skill body
- [x] 全量模式下行为不变（`CAFF_SKILL_LOADING_MODE=full`）
- [x] 11 个测试全部通过
- [x] 四轮 review 通过，LGTM

## 分支与合并

- **分支：** `feat/dynamic-skill-loading`
- **Commits：** `5bbdcc0`, `5aef23b`
- **状态：** 已推送到远端，待合并到 `main`
