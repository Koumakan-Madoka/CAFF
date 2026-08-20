# 重新设计左侧扁平树形对话列表

## Goal

将左侧对话列表从“树控件列 + 独立卡片 + 两个悬浮按钮”重构为对齐一致、空间高效且可访问的扁平树形列表，让父节点与叶子节点共享整行视觉边界，并清晰表达层级与可操作性。

## Confirmed design

- 使用类似 VS Code / Linear 的扁平树形列表：整行承担 hover、focus-within 和 active 背景，不再绘制独立卡片边界。
- 使用紧凑的内部树引导槽：父节点显示展开/折叠箭头，叶子显示端点；嵌套行显示低对比度连接线。
- 保留标题 + 类型/Agent 数两行信息，标题和元信息在 280px 窄栏中优雅省略。
- 将“重命名 / 派生子会话”合并到单个省略号菜单；视觉图标紧凑，但交互目标保持至少 44px。
- 失败、排队、处理中等现有状态徽标语义不变。

## Requirements

1. 父行和叶子行的整行 hover/active 边界对齐；同一深度标题基线一致，不再因是否有子节点改变内容起点。
2. 层级继续由 `depth` 表达；父行保留原有折叠状态和 `aria-expanded`，叶子端点不伪装成可交互控件。
3. 整行主按钮保持原生 `button.conversation-item`，可用键盘切换会话。
4. 每个非重命名行只暴露一个 overflow trigger；菜单内只读展示当前可用操作：重命名始终可用，派生仅在未达深度限制时出现，并保留项目未绑定时的 disabled 语义及原因。
5. overflow trigger、菜单项、展开按钮、重命名表单按钮的点击/触摸目标均至少 44px；菜单使用正确的 `aria-haspopup`、`aria-expanded`、`role=menu/menuitem`，支持 Escape、外部点击和焦点退出收起。
6. 打开菜单、开始重命名、重渲染或切换折叠时不得遗留幽灵菜单；执行重命名或派生后菜单关闭。
7. depth-limit 行继续显示“已达最大层级”提示，但不显示不可执行的派生菜单项。
8. 不改排序、会话树构建、折叠数据、后端/API 契约、状态派生或会话生命周期。

## UI contract

- DOM row remains semantic `ul > li`; the primary navigation target remains `button.conversation-item`.
- Tree guide is decorative except the parent toggle. Toggle and row action menu are siblings of the primary item so nested buttons are never created.
- Row indentation is `depth × compact-indent`; a fixed guide slot exists inside every row, with either a parent toggle or a decorative leaf marker, so parent/leaf title baselines align at equal depth.
- The row action menu is anchored to the row end and overlays outside normal text flow; idle layout reserves only one compact action region.
- Only one row menu may be open at a time.

## Validation matrix

| Case | Expected |
| --- | --- |
| root parent and root leaf | full-row backgrounds align; title baselines align; parent arrow vs leaf endpoint |
| nested parent/leaf | depth indentation and faint continuation/branch guides remain legible without consuming a 44px blank column |
| collapsed parent | `aria-expanded=false`, descendants hidden, row/menu geometry unchanged |
| 280px + long title/meta | title and participant metadata ellipsize; status pill and menu remain reachable |
| failed/live/busy state | existing status label/tone and busy badge remain unchanged |
| pointer/keyboard/touch | row, toggle, trigger and menu items remain operable with >=44px targets |
| open menu then Escape/outside click | menu closes and focus returns/remains safely reachable |
| spawn unavailable because project unbound | menu item remains disabled with explanatory title |
| depth-limit row | rename remains available; spawn item absent; depth hint remains visible |
| inline rename | prefilled form, save/cancel, focus/select behavior remain intact |

## Acceptance criteria

- [ ] Red regression tests first fail against the current card/two-action implementation.
- [ ] DOM tests cover aligned guide slots, menu ARIA/contents, depth limit, disabled spawn, one-open-menu behavior and rename flow.
- [ ] CSS/source tests lock flat full-row states, compact indentation/tree guides, ellipsis and >=44px interaction targets.
- [ ] Existing tree order, fold, status and rename suites remain green.
- [ ] `npm run check`, `npm run typecheck`, `npm run build`, targeted UI tests and `git diff --check` pass.
- [ ] Independent review finds no blocking accessibility, interaction or state-semantic regression.
- [ ] Isolated 3212 preview is manually accepted at narrow and ordinary sidebar widths.

## Non-goals

- No backend, storage or API changes.
- No change to conversation sorting, collapse persistence, tree depth limit or status semantics.
- No drag/drop, pinning, unread counts or context-menu framework.
- No redesign of the sidebar shell, new-room dialog, message timeline or drawer.
