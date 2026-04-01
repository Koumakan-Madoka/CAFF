# PRD：验证 Trellis 上下文注入

## 目标

- 确认在 CAFF 中激活项目后，每次 turn 的 prompt 会包含 Trellis（任务状态 / PRD / workflow）信息。

## 验收标准

- agent 的回复能引用本 PRD 中的目标与验收标准来回答问题（不需要输出原始 prompt）。
- 删除 `.trellis` 或清空 active project 后，Trellis 上下文不再注入。

## 备注

- 这是示例任务，你可以随时替换 `.trellis/.current-task` 指向其他任务目录。

