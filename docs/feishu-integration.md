---
feature_ids: [CAFF-FEISHU-INTEGRATION, CAFF-ORPHAN-PR-RECONCILIATION]
topics: [feishu, webhook, long-connection, setup]
doc_kind: guide
created: 2026-08-04
---

# 飞书集成指南

CAFF 可以把飞书私聊和普通群聊文本路由到本地 conversation，并把已完成的 Agent 文本回复发回原聊天。

## 选择入站模式

| 模式 | 公网地址 | 额外 SDK | 入口 |
|---|---:|---:|---|
| Webhook | 需要 HTTPS | 不需要 | `POST /api/integrations/feishu/webhook` |
| Long connection | 不需要 | `@larksuiteoapi/node-sdk` | 官方 SDK `WSClient` |

最小核心/webhook 安装可以使用：

```bash
npm install --omit=optional
```

如果之后启用 long connection，再安装 SDK：

```bash
npm install @larksuiteoapi/node-sdk
```

## 前置条件

- 一个飞书开放平台自建应用，并启用 Bot 能力；
- CAFF 已启动，`GET /api/health` 返回 `core.ready: true`；
- 至少一个默认聊天角色可运行时，`chat.ready` 为 `true`；该字段只验证本地角色/模型目录解析，不代表远端 provider 已探活；
- webhook 模式需要公网可达的 HTTPS 地址。

## 配置

在 `.env.local` 中设置：

| Variable | Default | Description |
|---|---|---|
| `FEISHU_APP_ID` | - | 飞书 app id |
| `FEISHU_APP_SECRET` | - | 飞书 app secret |
| `FEISHU_VERIFICATION_TOKEN` | - | webhook 校验 token |
| `FEISHU_BOT_OPEN_ID` | - | bot info 查询失败时的可选回退值 |
| `FEISHU_CONNECTION_MODE` | `webhook` | `webhook` 或 `long-connection` |
| `FEISHU_LONG_CONNECTION_LOGGER_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |

## 飞书后台设置

1. 创建自建应用并启用 Bot。
2. 订阅 `im.message.receive_v1`。
3. 授予接收 IM 文本与发送 Bot 文本消息所需权限。
4. Webhook 模式把事件订阅地址设为 `https://<public-host>/api/integrations/feishu/webhook`，并配置同一 `FEISHU_VERIFICATION_TOKEN`。
5. Long connection 模式在飞书后台选择长连接，并把 `FEISHU_CONNECTION_MODE` 设为 `long-connection`。
6. 当前实现不支持加密 webhook payload，必须关闭事件加密。
7. 发布应用或发布到开发测试版本。

## 验证

1. 请求 `curl http://127.0.0.1:3100/api/health`。
2. 确认 `optional.feishu.configured` 为 `true`。
3. Long connection 模式还应确认 `optional.feishu.longConnectionSdkAvailable` 为 `true`。
4. 在飞书向 Bot 发送文本，确认 CAFF 中出现对应消息。
5. 等 Agent 完成回复，确认飞书收到带 Agent 名称前缀的文本。

## 故障排查

### Webhook 请求失败

- 确认公网 HTTPS 地址可达；
- 确认 verification token 与飞书后台一致；
- 确认事件加密已关闭；
- 确认订阅的是 `im.message.receive_v1`。

### Long connection 没有启动

- 检查健康接口中的 `longConnectionSdkAvailable`；
- 如果使用过 `--omit=optional`，安装 `@larksuiteoapi/node-sdk`；
- 检查 app id / secret；
- 把 `FEISHU_LONG_CONNECTION_LOGGER_LEVEL` 临时设为 `debug` 查看官方 SDK 日志。

### Agent 回复没有回到飞书

- 确认 Bot 有发送消息权限且应用已发布；
- 如果 bot info 查询不可用，设置 `FEISHU_BOT_OPEN_ID`；
- 出站只发送已完成的 assistant 文本，不发送工具调用中间状态。

## 当前限制

- 只处理文本消息，不支持富文本、图片和文件；
- 不支持加密 webhook payload；
- 群聊继续使用 CAFF 房间内的 mention 路由语义。
