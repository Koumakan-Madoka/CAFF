# Workflow

本目录用于为 CAFF 提供 Trellis 上下文（任务 / PRD / 工作流），在“激活项目”存在时会注入到每次 turn 的 prompt 中。

## 快速开始

1. 选择当前任务：编辑 `.trellis/.current-task`，填入任务名（例如 `demo`）。
2. 写 PRD：在 `.trellis/tasks/<task>/prd.md` 描述目标、范围、验收标准。
3. 标记任务 READY：在 `.trellis/tasks/<task>/implement.jsonl` / `check.jsonl` / `spec.jsonl` 至少写入一行内容。
4. 规格索引（可选）：在 `.trellis/spec/**/index.md` 添加索引文件，注入时会列出这些路径提示。

