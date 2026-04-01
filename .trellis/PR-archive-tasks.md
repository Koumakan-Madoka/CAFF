# PR: Archive Completed Trellis Tasks

## Summary

将三个已完成的 Trellis 任务归档到 `.trellis/tasks/archive/2026-04/`，清理任务目录。

## Changes

### 归档任务

| 任务 | 原路径 | 归档路径 | 状态 |
|------|--------|----------|------|
| demo | `.trellis/tasks/demo/` | `.trellis/tasks/archive/2026-04/demo/` | ✅ 已完成 |
| werewolf | `.trellis/tasks/werewolf/` | `.trellis/tasks/archive/2026-04/werewolf/` | ✅ 已完成 |
| 03-31-pi-trellis-hardening | `.trellis/tasks/03-31-pi-trellis-hardening/` | `.trellis/tasks/archive/2026-04/03-31-pi-trellis-hardening/` | ✅ 已完成 |

### 附带变更
- `package-lock.json` license 字段从 `ISC` 更正为 `MIT`

## Task Details

1. **demo** — Trellis 上下文注入验证任务，验证了 context 注入功能正常工作
2. **werewolf** — 狼人杀游戏玩法实现，包括游戏逻辑、服务层、API、Skill 文件
3. **03-31-pi-trellis-hardening** — pi-trellis 加固任务，runtime doc 与测试覆盖已验证到位

## Verification

- 三个任务的 implement.jsonl 均标记为完成
- 归档前确认所有代码变更已合入主分支
- 归档后 `.trellis/tasks/` 目录已清空

## Branch

`chore/archive-completed-tasks` → `feat/dynamic-skill-loading`

## Commit

`308b04a` — chore: archive completed trellis tasks (demo, werewolf, pi-trellis-hardening)
