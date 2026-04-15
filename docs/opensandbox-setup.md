# OpenSandbox Skill Test 设置指南

OpenSandbox 提供隔离的 Docker 容器环境，用于在 CAFF 中安全运行 Skill 测试用例。本文档描述如何配置和验证 OpenSandbox 集成。

> 如果你使用 `npm install --omit=optional` 进行最小安装，请先补装依赖：`npm install opensandbox`（或在下文用 `CAFF_SKILL_TEST_OPENSANDBOX_SDK_PATH` 指向本地 SDK）。

## Prerequisites

- CAFF 核心服务已正常运行（`/api/health` 返回 `core.ready: true`）
- [Docker](https://www.docker.com/) 已安装并可运行
- Docker 镜像中需要 Node.js 20+（默认使用 `node:20-bookworm`）
- （可选）本地 OpenSandbox 源码用于开发调试

## Setup Steps

### 1. 启动 OpenSandbox Lifecycle Server

如果你使用本地 OpenSandbox 源码：

1. 在 `OpenSandbox/server` 目录下启动 lifecycle server。
2. 把 `CAFF_SKILL_TEST_OPENSANDBOX_API_URL` 指向本地地址。

```bash
# 在 OpenSandbox 源码目录
cd OpenSandbox/server
# 按 OpenSandbox 文档启动 lifecycle server
```

### 2. 配置环境变量

在 `.env.local` 中添加以下变量：

| Variable | Default | Description |
|---|---|---|
| `CHAT_APP_ADVERTISE_URL` | — | 供 sandbox / 外部环境回连本机 CAFF 时使用的可达 base URL |
| `CAFF_SKILL_TEST_OPENSANDBOX_CHAT_API_URL` | — | 仅给 OpenSandbox skill-test 直连 bridge 使用的显式覆盖 URL |
| `CAFF_SKILL_TEST_OPENSANDBOX_API_URL` | — | OpenSandbox lifecycle API 地址；本地部署通常是 `http://127.0.0.1:8080` |
| `CAFF_SKILL_TEST_OPENSANDBOX_SDK_PATH` | — | 官方 OpenSandbox JS SDK `dist/index.js` 本地路径 |
| `CAFF_SKILL_TEST_OPENSANDBOX_IMAGE` | `node:20-bookworm` | skill-test sandbox 默认镜像；需要内置 Node |
| `CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_RUNTIME_DIR` | — | 可选：使用预烘焙 runtime 资产目录（容器内路径） |
| `CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_PROJECT_DIR` | — | 可选：使用预烘焙 CAFF 源码模板目录（容器内路径） |
| `CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC` | `300` | OpenSandbox sandbox TTL 秒数 |
| `CAFF_SKILL_TEST_OPENSANDBOX_USE_SERVER_PROXY` | `true` | 是否通过 lifecycle server proxy 访问 sandbox execd |

### 3. 推荐配置

推荐把 `CHAT_APP_HOST` 设成 `0.0.0.0`，再把 `CHAT_APP_ADVERTISE_URL` 设成 sandbox 能访问到的地址。

若只想给 skill-test sandbox 单独覆写，设置 `CAFF_SKILL_TEST_OPENSANDBOX_CHAT_API_URL`。

在 Windows + WSL 上，优先使用 `http://localhost:8080`，避免把地址写死成会漂移的 WSL `172.x.x.x`。

如果本地 Full 模式在上传隔离目录或执行期间超过默认 5 分钟 TTL，把 `CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC` 调大后重启 CAFF。

### 4. 预烘焙镜像（高级）

如果 Full 模式经常卡在"正在准备 sandbox runner…"，可以用预烘焙 runtime 镜像加速：

```bash
# 构建 runtime 镜像
npm run opensandbox:build-runtime-image
```

然后在 `.env.local` 中设置：

```
CAFF_SKILL_TEST_OPENSANDBOX_IMAGE=caff-skill-test-runtime:local
CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_RUNTIME_DIR=/opt/caff-skill-test/runtime
```

如果你想让 sandbox case 里有一份更仿真的 CAFF 源码 checkout：

```bash
# 构建 CAFF 源码镜像
npm run opensandbox:build-caff-image
```

然后在 `.env.local` 中设置：

```
CAFF_SKILL_TEST_OPENSANDBOX_IMAGE=caff-skill-test-caff:local
CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_RUNTIME_DIR=/opt/caff-skill-test/runtime
CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_PROJECT_DIR=/opt/caff-skill-test/project
```

运行时仍会复制到每个 case 的隔离项目目录，并覆盖 case 级 `.trellis`，不会让多个 case 共用同一个可写源码目录。

## Verification

1. **检查健康状态**：
   ```bash
   curl http://127.0.0.1:3100/api/health
   ```
   确认返回值中 `optional.openSandbox.available` 为 `true`。

2. **在 UI 运行测试用例**：打开 `http://127.0.0.1:3100/eval-cases.html`，进入 Skill 测试面板，运行一个 `ready` 状态的测试用例，确认 sandbox 能正常创建和销毁。

## Troubleshooting

### Sandbox 超时 / TTL 不够

- 默认 TTL 是 300 秒（5 分钟）。在 `.env.local` 中设置 `CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC=3600` 后重启 CAFF。

### WSL IP 漂移

- 在 Windows + WSL 环境下，WSL 的 `172.x.x.x` 地址可能会在重启后漂移。
- 解决方案：使用 `localhost` 或 `host.docker.internal` 代替 WSL IP。

### Docker 镜像构建失败

- 确认 Docker 正在运行：`docker ps`。
- 确认网络可以拉取基础镜像（`node:20-bookworm`）。
- 检查 Docker 磁盘空间是否充足：`docker system df`。

### Lifecycle server 不可达

- 确认 `CAFF_SKILL_TEST_OPENSANDBOX_API_URL` 指向正确的地址。
- 在本地部署时通常为 `http://127.0.0.1:8080`，Windows + WSL 常用 `http://localhost:8080`。
- 检查 lifecycle server 是否已启动。

## 相关文档

- [Windows 自启动](windows-local-stack.md) — Windows 登录后自动恢复 WSL + Docker + OpenSandbox + CAFF 全栈
- [Local Chat UI](local-chat-ui.md) — 基础本地聊天 UI 说明
