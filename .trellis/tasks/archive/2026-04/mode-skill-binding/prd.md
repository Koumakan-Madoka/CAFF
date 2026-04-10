# PRD: 模式-技能绑定 (Mode-Skill Binding)

## 背景

CAFF 目前支持三种会话模式（conversation type）：
- `standard` — 普通对话
- `werewolf` — 狼人杀（后端全自动主持）
- `who_is_undercover` — 谁是卧底（后端全自动主持）

当前 skill 注入机制：
- **Persona skills**（`agent.skillIds`）：人格级绑定，始终全量注入（`forceFull: true`）。
- **Conversation skills**（`agent.conversationSkillIds`）：会话级绑定，由 werewolf/undercover service 在 `prepareConversation` 时硬编码 merge。
- **Skill loading mode**（`CAFF_SKILL_LOADING_MODE`）：全局环境变量，`dynamic` 模式下 conversation skills 仅注入描述符，Agent 通过 `read-skill` 工具按需加载。

**痛点：** 模式与 skill 的绑定关系是硬编码在 werewolf-service / undercover-service 中的。用户无法：
1. 在 UI 上配置某个模式应该注入哪些 skill（如给 Coding 模式绑定 trellis 相关 skill）。
2. 自定义新模式（如 Coding、Roleplay），并为其指定常驻 skill 集合。
3. 控制每个模式下的 skill 加载策略（全量 vs 渐进式 dynamic）。

## 目标

在 Skill 管理页面新增「模式-技能绑定」功能，使用户能够：
1. 查看所有已定义的模式（内置 3 种 + 自定义模式）。
2. 为每个模式配置一组常驻 skill（binding skill IDs）。
3. 选择每个模式的 skill 加载策略：`full`（全量注入）或 `dynamic`（渐进式加载，仅注入描述符）。
4. 创建自定义模式（仅需名称 + 说明，不需要后端游戏逻辑）。
5. 新建会话时，选择模式后自动加载该模式绑定的常驻 skill 到所有参与 Agent 的 conversation context。

## 范围

### In Scope
- 后端：新增 Mode 概念及持久化存储（SQLite）。
- 后端：`GET/POST/PUT/DELETE /api/modes` API（CRUD 模式）。
- 后端：`GET/PUT /api/modes/:modeId/skills` API（管理模式绑定的 skill IDs + 加载策略）。
- 后端：新建会话时，根据会话 type 查找对应 Mode 配置，自动将绑定的 skill 注入到所有 participant 的 `conversationSkillIds`。
- 后端：修改 `buildAgentTurnPrompt` 中的 skill 加载逻辑，支持按模式的加载策略决定 `forceFull` 还是 `dynamic`。
- 前端：在 `skills.html` 新增「模式管理」Tab 或区域。
- 前端：模式列表（展示名称、说明、绑定 skill 数量、加载策略）。
- 前端：模式编辑表单（名称、说明、绑定 skill 多选、加载策略选择）。
- 内置模式种子数据：`standard`、`werewolf`、`who_is_undercover`（首次启动自动写入）。

### Out of Scope
- 自定义模式的后端游戏逻辑（自定义模式仅是 skill 绑定容器，不含游戏规则）。
- 修改已有 werewolf/undercover 的游戏流程代码。
- 会话中途切换模式（会话 type 在创建时确定，后续不可变）。
- 模式级别的 Agent 配置（模型、人格等），仅关注 skill 绑定。

## 技术方案

### 数据模型

```sql
CREATE TABLE modes (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin   INTEGER NOT NULL DEFAULT 0,
  skill_ids_json TEXT NOT NULL DEFAULT '[]',
  loading_strategy TEXT NOT NULL DEFAULT 'dynamic',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 关键代码改动

1. **新增 `lib/mode-store.ts`** — Mode 持久化 + 内置种子。
2. **新增 `server/api/modes-controller.ts`** — REST API。
3. **修改 `server/api/conversations-controller.ts`** — 创建会话时注入 mode skill bindings。
4. **修改 `server/domain/conversation/turn/agent-executor.ts`** — 传递 mode loading strategy。
5. **修改 `server/domain/conversation/turn/agent-prompt.ts`** — 按策略控制 skill 注入深度。
6. **修改前端 `skills.html` + `skills.js`** — 模式管理 UI。

## 验收标准

- [ ] 内置 3 种模式在首次启动后自动出现在数据库中。
- [ ] 通过 UI 可查看所有模式及其绑定的 skill。
- [ ] 通过 UI 可为任意模式添加/移除绑定的 skill，并选择加载策略。
- [ ] 通过 UI 可创建自定义模式（输入名称+说明）。
- [ ] 创建新会话并选择某模式后，该模式绑定的 skill 以正确的加载策略出现在 Agent prompt 中。
- [ ] 现有 werewolf/undercover 会话行为不受影响（向后兼容）。
- [ ] 不选择任何 mode 或使用 standard 模式时，不自动注入额外 skill。
