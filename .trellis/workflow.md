# Workflow

本目录用于为 CAFF 提供 Trellis 上下文（任务 / PRD / 工作流），在"激活项目"存在时会注入到每次 turn 的 prompt 中。

## 目录结构

```
.trellis/
├── workflow.md           # 本文件 - 工作流说明
├── config.yaml           # Trellis 配置
├── .current-task         # 当前激活的任务名称
├── .developer            # 当前开发者信息
├── tasks/                # 任务目录
│   ├── {task-name}/
│   │   ├── prd.md        # 产品需求文档
│   │   ├── task.json     # 任务元数据
│   │   ├── implement.jsonl  # 实现记录
│   │   ├── check.jsonl   # 检查记录
│   │   └── spec.jsonl    # 规格更新记录
│   └── archive/          # 已归档的任务
├── spec/                 # 规格文档索引
│   ├── index.md          # 主索引
│   ├── backend/          # 后端规格
│   ├── frontend/         # 前端规格
│   ├── runtime/          # 运行时规格
│   ├── unit-test/        # 单元测试规格
│   ├── skills/           # Skills 规格
│   └── guides/           # 思考指南
└── workspace/            # 开发者工作区
    ├── index.md          # 工作区索引
    └── {developer-name}/ # 个人工作区
```

## 快速开始

1. **选择当前任务**：编辑 `.trellis/.current-task`，填入任务名（例如 `skill-testing`）
2. **写 PRD**：在 `.trellis/tasks/<task>/prd.md` 描述目标、范围、验收标准
3. **标记任务 READY**：在 `.trellis/tasks/<task>/implement.jsonl` / `check.jsonl` / `spec.jsonl` 至少写入一行内容
4. **使用 Skills**：在开发前使用 `before-dev` skill 加载相关规格
5. **更新规格**：实现完成后使用 `update-spec` skill 更新规格文档
6. **检查质量**：使用 `check` skill 验证代码符合规范
7. **记录会话**：使用 `record-session` skill 记录完成的工作

## Tasks 目录说明

### 任务生命周期

```
创建任务 → 开发中 → 测试中 → 完成 → 归档
  (new)   (dev)   (test)  (done) (archive)
```

### 任务文件说明

- `prd.md`：产品需求文档，描述目标、范围、技术方案、验收标准
- `task.json`：任务元数据（标题、状态、创建时间）
- `implement.jsonl`：实现记录（每次实现操作追加一行）
- `check.jsonl`：检查记录（每次质量检查追加一行）
- `spec.jsonl`：规格更新记录（每次规格更新追加一行）
- `research.md`（可选）：调研记录，包含研究笔记和技术探索

### 任务归档

使用 `record-session` skill 归档任务后，任务目录会被移动到 `tasks/archive/` 下按日期组织。

## Spec 目录说明

### 规格文档组织

- `index.md`：主索引，描述项目结构和各规格区域
- `backend/`：后端相关规格（架构、控制器模式）
- `frontend/`：前端相关规格（UI 结构）
- `runtime/`：运行时相关规格（Agent 运行、Prompt 构造）
- `unit-test/`：单元测试相关规格（测试模式）
- `skills/`：Skills 相关规格（Skill 系统、Skill 测试）
- `guides/`：跨层思考指南（代码重用、跨层数据流、跨平台）

### 使用规格文档

**开发前**：
```bash
# 使用 before-dev skill 加载相关规格
start
```

**开发中**：
- 参考相关 spec 文档中的规范和约定
- 遵循 Controller Patterns、Code Reuse 等指南

**开发后**：
```bash
# 使用 update-spec skill 更新规格
update-spec
```

## Workspace 目录说明

### 开发者工作区

每个开发者有独立的工作区目录：
```
workspace/{developer-name}/
├── journal.md        # 会话日志（自动轮转，2000 行/文件）
└── scratchpad.md     # 个人草稿
```

### 当前开发者

通过 `.trellis/.developer` 文件管理：
```ini
name=菲比啾比
initialized_at=2026-03-31T15:52:42.065833
```

## Skills 使用指南

本项目集成了以下 Trellis Skills 用于辅助开发：

| Skill | 用途 | 使用时机 |
|-------|------|----------|
| `start` | 初始化开发会话，加载工作流和项目上下文 | 开始新任务或恢复工作 |
| `before-dev` | 加载项目特定开发指南和规格 | 实现功能前 |
| `brainstorm` | 需求发现和方案讨论 | 需求不明确或方案不确定 |
| `check` | 验证代码质量 | 代码完成后 |
| `check-cross-layer` | 跨层验证 | 修改涉及多个层次 |
| `finish-work` | 提交前质量检查 | 准备提交代码前 |
| `improve-ut` | 改进单元测试覆盖 | 测试覆盖率不足时 |
| `update-spec` | 更新规格文档 | 实现或修复完成后 |
| `record-session` | 记录完成的工作 | 会话结束并提交后 |
| `break-loop` | Bug 分析和经验总结 | 调试完成后 |

## 配置说明

`config.yaml` 文件包含以下配置：

```yaml
# Session Recording
session_commit_message: "chore: record journal"  # 自动提交的消息
max_journal_lines: 2000                          # 日志文件最大行数

# Task Lifecycle Hooks (可选)
hooks:
  after_create:
    - "python3 .trellis/scripts/hooks/linear_sync.py create"
  after_start:
    - "python3 .trellis/scripts/hooks/linear_sync.py start"
  after_archive:
    - "python3 .trellis/scripts/hooks/linear_sync.py archive"
```

## 最佳实践

1. **使用 start skill**：每次开始工作时先运行 `start` skill
2. **阅读相关规格**：使用 `before-dev` skill 加载相关 spec
3. **记录关键决策**：使用 `update-spec` skill 将设计决策写入 spec
4. **验证代码质量**：提交前运行 `finish-work` skill
5. **记录完成的工作**：提交后运行 `record-session` skill

