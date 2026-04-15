# PRD: 04-15-caff-install-path-minimization

## Goal
让“只想跑核心本地聊天 UI”的用户可以用更小的 `npm install` 路径启动 CAFF；可选集成（Feishu long-connection、OpenSandbox skill-test SDK）不再强制安装。

## Context
- `04-15-caff-deployability-newcomer-friendliness` 评审产出的 **P3** 改进项：install-path minimization。
- 当前 `package.json` 把 `opensandbox` 与 `@larksuiteoapi/node-sdk` 放在 root `dependencies`，最小用户也会被迫安装。
- 代码侧已做了“缺包不 crash”的动态加载：
  - Feishu long-connection：`server/domain/integrations/feishu/feishu-long-connection.ts` 用 `try/catch require()`。
  - OpenSandbox：`server/domain/skill-test/open-sandbox-factory.ts` 用动态 `import()`，失败走 compat fallback。

## Scope

### In scope
1) `package.json`
- `opensandbox`、`@larksuiteoapi/node-sdk` → `optionalDependencies`
- `dependencies` 仅保留核心运行所需依赖（当前是 `better-sqlite3`）
- 现有 `overrides` / lockfile 策略保持不变（装了 optional 时仍生效）

2) Docs
- `README.md` Quick Start 明确两条安装方式：
  - 完整安装：`npm install`
  - 最小安装：`npm install --omit=optional`
- `docs/feishu-integration.md`、`docs/opensandbox-setup.md` 顶部补充提示：如果使用了 `--omit=optional`，需要额外安装对应 optional 包。

3) Verification
- `npm ci --omit=optional` 环境：`npm run typecheck`、`npm run build`、`npm run start` 均可运行
- `/api/health`：
  - `core.ready: true`
  - optional 集成状态能反映“未安装 / 未配置”（不要求为 true，但必须不报错且可区分）

### Out of scope
- “激进方案”：从默认安装中彻底移除 optional 包（breaking change，留待后续评估）
- UI/集成逻辑大改（除非发现缺少 graceful error）
- 引入 pnpm/yarn 等新的包管理约束

## Acceptance Criteria
- [x] `package.json` 完成 `optionalDependencies` 调整，`npm install` 仍能装全量并正常启动
- [x] `npm install --omit=optional`（或 `npm ci --omit=optional`）后核心功能可启动，不因缺少 optional 包崩溃
- [x] `npm run typecheck` 在 omit optional 环境通过
- [x] `/api/health` 正常返回，并能显示 optional 集成不可用/未配置状态
- [x] `README.md` + lane docs 写清楚最小/完整安装路径与“补装 optional”指引

## Notes
- npm 默认会尝试安装 `optionalDependencies`；“最小 lane”必须显式使用 `--omit=optional`。
- Windows / WSL 侧如涉及 Docker/OpenSandbox，可交叉引用 `docs/windows-local-stack.md`。
