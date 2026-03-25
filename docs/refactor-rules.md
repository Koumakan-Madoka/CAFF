# Refactor Rules

日期：2026-03-24

## 目标

这份规则用于约束 M0 之后的继续重构，避免新功能再次直接堆回总入口文件。

## 后端规则

1. `app-server.js` 只保留启动、依赖组装、关闭逻辑和顶层错误兜底。
2. HTTP 请求解析、响应拼装、静态文件服务、SSE 这类基础设施不得继续写回 `app-server.js`。
3. 新增 API 时，优先新增 controller 或 service，不要继续扩展大段 `if/else`。
4. 业务流程代码不能直接依赖 `http.ServerResponse`。
5. Repository 只负责数据读写，不负责 HTTP 和页面语义。

## 前端规则

1. 页面通用工具必须放进 `public/shared/`，不得在多个页面脚本复制。
2. `public/app.js` 负责聊天页组装，不再新增通用工具实现。
3. `public/personas.js`、`public/skills.js` 只能保留页面专属逻辑。
4. 新的 UI 子区域优先拆成独立模块，而不是继续往单文件追加数百行。

## 提交规则

1. 优先做小步迁移，保持页面和 API 可运行。
2. 每次迁移后都要保留至少一条自动化验证路径。
3. 删除 legacy 逻辑前，先确认新实现已完全接管调用路径。
