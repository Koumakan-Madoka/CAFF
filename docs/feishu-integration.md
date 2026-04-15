# 飞书集成指南

将 CAFF 接入飞书后，私聊和普通群聊的文本消息会自动路由到 CAFF 对话，已完成的 Agent 回复也会推送回飞书。

> 如果你使用 `npm install --omit=optional` 进行最小安装，且需要 **Long connection** 模式，请先安装：`npm install @larksuiteoapi/node-sdk`。

## Prerequisites

- 一个可用的飞书开放平台自建应用
- CAFF 核心服务已正常运行（`/api/health` 返回 `core.ready: true`）
- （Webhook 模式）一个公网可达的 HTTPS 地址
- （Long connection 模式）无需公网地址

## Setup Steps

### 1. 创建飞书自建应用

1. 登录 [飞书开放平台](https://open.feishu.cn/)，创建一个自建应用。
2. 在应用能力中启用 **Bot** 能力。

### 2. 选择入站模式

- **Webhook 模式**：需要公网 HTTPS 地址。在事件订阅中填写 `https://<your-public-host>/api/integrations/feishu/webhook`，并设置 `FEISHU_VERIFICATION_TOKEN`。
- **Long connection 模式**：不需要公网地址。在应用后台切换到 long connection，并设置 `FEISHU_CONNECTION_MODE=long-connection`。

### 3. 订阅事件

在飞书应用后台订阅事件 `im.message.receive_v1`。

### 4. 授予权限

授予接收 IM 文本消息和发送 Bot 文本消息所需的权限。

### 5. 配置环境变量

在 `.env.local` 中添加以下变量：

| Variable | Default | Description |
|---|---|---|
| `FEISHU_APP_ID` | — | 飞书 app id |
| `FEISHU_APP_SECRET` | — | 飞书 app secret |
| `FEISHU_VERIFICATION_TOKEN` | — | webhook 模式下的校验 token |
| `FEISHU_BOT_OPEN_ID` | — | 获取 bot info 失败时的可选回退值 |
| `FEISHU_CONNECTION_MODE` | `webhook` | 飞书入站模式：`webhook` 或 `long-connection` |
| `FEISHU_LONG_CONNECTION_LOGGER_LEVEL` | `info` | 官方 SDK long connection 日志级别 |

### 6. 关闭事件加密

当前 MVP 不支持加密 webhook payload。请确保飞书应用后台的事件加密处于**关闭**状态，否则加密 payload 会被拒绝。

### 7. 启动 CAFF 并验证

配置好环境变量后启动 CAFF（`npm run start:dev`），然后通过私聊或普通群聊文本验证消息收发。

## Verification

1. **检查健康状态**：
   ```bash
   curl http://127.0.0.1:3100/api/health
   ```
   确认返回值中 `optional.feishu.configured` 为 `true`。

2. **发送测试消息**：在飞书中向 Bot 发送一条私聊文本消息，确认 CAFF 聊天界面中出现对应消息。

3. **检查回复**：确认 Agent 完成回复后，飞书中能收到回复文本。

## Troubleshooting

### Webhook 不通

- 确认公网地址可达：`curl https://<your-public-host>/api/integrations/feishu/webhook`。
- 检查 `FEISHU_VERIFICATION_TOKEN` 是否与飞书应用后台一致。
- 确认事件加密已关闭。

### Long connection 断连

- 检查 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 是否正确。
- 查看 CAFF 终端日志中是否有 `@larksuiteoapi/node-sdk` WSClient 报错。
- 设置 `FEISHU_LONG_CONNECTION_LOGGER_LEVEL=debug` 获取更详细日志。

### Bot info 获取失败

- 如果租户无法使用 `GET /open-apis/bot/v3/info`，手动设置 `FEISHU_BOT_OPEN_ID`。

### 消息发送成功但飞书收不到

- 确认应用已发布（至少发布到开发测试版本）。
- 确认 Bot 有发送消息的权限。
- 确认 CAFF 的 Agent 回复已完成（出站只会推送已完成的 assistant 文本回复）。

## Limitations

- 当前 MVP 仅支持**文本消息**，不支持富文本、图片、文件等其他消息类型。
- 不支持加密 webhook payload。
- 出站范围：仅推送已完成的 assistant 文本回复，不推送工具调用结果或中间状态。
- 群聊中继续沿用房间内的 mention 路由语义。
