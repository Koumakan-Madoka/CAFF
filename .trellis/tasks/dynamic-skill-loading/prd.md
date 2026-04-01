# PRD: Skill 动态加载机制调研与实现

## 背景

当前 CAFF 的 skill 加载机制是**静态全量注入**：所有配置在 agent 上的 persona skills 和 conversation skills 在每次 turn 构建提示词时，都会通过 `formatSkillDocuments()` 将全部 skill body 一次性写入 system prompt。

### 现状分析

**关键文件与流程：**

1. **`lib/skill-registry.ts`** — `SkillRegistry` 类
   - 从磁盘读取 skill 目录下的 `SKILL.md`
   - `resolveSkills(skillIds, options)` 返回完整的 skill 对象（包含 body）
   - 支持 local skills（agent sandbox）和 external skills（项目 `.agents/skills/`、`.codex/skills/`）

2. **`server/domain/conversation/turn/agent-executor.ts`** — `executeConversationAgent()`
   - 从 agent config 读取 `skillIds` 和 `conversationSkillIds`
   - 调用 `skillRegistry.resolveSkills()` 全量解析
   - 将结果传入 `buildAgentTurnPrompt()`

3. **`server/domain/conversation/turn/agent-prompt.ts`** — `buildAgentTurnPrompt()`
   - `formatSkillDocuments(skills)` 将每个 skill 的 name、description、path、body 全部写入提示词
   - 没有任何过滤、摘要或按需加载逻辑

**问题：**
- Token 浪费：大量 skill body 在不需要时也被注入
- 随 skill 数量增长，提示词膨胀
- 无法根据上下文动态选择相关 skill

## 目标

调研并设计 skill 动态加载机制，使 agent 只在需要时加载相关 skill 的完整内容。

## 调研范围

### 方案方向（待评估）

1. **描述符 + 按需加载（Recommended 方向）**
   - 提示词中只注入 skill 的 name + description（短摘要）
   - 当 agent 判断需要某个 skill 时，通过工具调用读取完整 SKILL.md
   - 类似 pi 原生的 `<available_skills>` 模式（当前 pi 的 skill 机制就是这样做的）

2. **上下文相关性预过滤**
   - 在 `agent-executor` 层根据当前消息内容、任务类型等预筛选
   - 使用简单的关键词/嵌入匹配来决定加载哪些 skill

3. **分层加载**
   - 第一层：描述符始终注入（name + description，极短）
   - 第二层：匹配到的 skill body 注入
   - 第三层：通过工具调用按需读取补充文件

### 需要回答的问题

- [ ] pi 原生的 skill 机制（`<available_skills>` + `read tool`）是否可以复用？
- [ ] 现有 `agent-chat-tools.js` 是否需要新增 `read-skill` 命令？
- [ ] Trellis 的 skill 载入（`buildTrellisPromptContext`）与 agent skill 的关系？
- [ ] 是否需要考虑 skill 间的依赖关系？
- [ ] 对现有 agent 行为的兼容性影响？

## 验收标准

1. 输出一份调研报告，记录当前机制分析和推荐方案
2. 推荐方案有明确的代码变更点和伪代码
3. 不需要在本任务中完成实现，只需完成调研和方案设计

## 参考代码路径

- `lib/skill-registry.ts` — Skill 注册表
- `server/domain/conversation/turn/agent-executor.ts` — Agent 执行器（skill 解析入口）
- `server/domain/conversation/turn/agent-prompt.ts` — 提示词构建（skill 注入）
- `server/domain/conversation/turn/trellis-context.ts` — Trellis 上下文构建
- `.agents/skills/*/SKILL.md` — 项目级 skill 定义
- `.pi-sandbox/skills/*/SKILL.md` — 沙箱 skill 定义
