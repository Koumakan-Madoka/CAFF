# Windows Local Stack Autostart

适用场景：Windows 宿主机运行 CAFF，`Docker` 与 `opensandbox-local` 跑在 `WSL Debian` 里，希望开机后登录一次就把整条本地链路自动拉起来。

## 提供的脚本

- `scripts/windows/run-caff-stack.ps1`
  - 隐藏运行的守护脚本
  - 保活 `WSL`，并在 `Debian` 里执行 `systemctl restart docker opensandbox-local; exec sleep infinity`
  - 轮询 `OpenSandbox` 健康检查，必要时自动重启 `docker` / `opensandbox-local`
  - 轮询本地 `CAFF`，必要时自动执行仓库根目录下的 `npm run start`
- `scripts/windows/register-caff-stack-task.ps1`
  - 为当前 Windows 用户注册计划任务 `CAFF Local Stack`
  - 触发时机是“登录时”
  - 可选 `-RunNow` 立即启动，可选 `-Force` 覆盖已有任务

## 一次性安装

在仓库根目录打开 PowerShell，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-caff-stack-task.ps1 -RunNow -Force
```

如果你的发行版名字不是 `Debian`，加上 `-WslDistro`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-caff-stack-task.ps1 -WslDistro Ubuntu-22.04 -RunNow -Force
```

## 它会如何工作

1. Windows 登录后，计划任务启动隐藏的 `PowerShell` 守护脚本
2. 守护脚本检查是否已有 `WSL` keepalive 进程；没有就拉起一个新的
3. 守护脚本用 `.env.local` 里的 `CAFF_SKILL_TEST_OPENSANDBOX_API_URL` 计算健康检查地址；如果你配置成 `http://localhost:8080/api` 或 `http://localhost:8080/api/v1`，它也会自动回退到 `http://localhost:8080/health`
4. 如果 OpenSandbox 不健康，就在 `WSL` 里重启 `docker` 和 `opensandbox-local`
5. 守护脚本读取 `.env.local` 里的 `CHAT_APP_PORT`，默认 `3100`；像 `CHAT_APP_PORT="3100"` 这种带引号的 dotenv 写法也能正常解析，然后探测 `http://localhost:<port>/`
6. 如果 CAFF 没起来，就在仓库根目录执行 `npm run start`

## 验证

- 任务是否存在：

```powershell
Get-ScheduledTask -TaskName 'CAFF Local Stack' | Format-List TaskName,State,Author,Description
```

- OpenSandbox 健康检查：

```powershell
curl http://localhost:8080/health
```

- CAFF 本地入口：

```powershell
curl http://localhost:3100/
```

- 查看日志：

```powershell
Get-Content "$env:LOCALAPPDATA\caff\logs\stack-supervisor.log" -Tail 50
Get-Content "$env:LOCALAPPDATA\caff\logs\caff-server.log" -Tail 50
```

## 移除任务

```powershell
Unregister-ScheduledTask -TaskName 'CAFF Local Stack' -Confirm:$false
```

## 备注

- 这套脚本默认使用 `localhost:8080`，在 Windows + WSL 端口转发环境里通常比 `127.0.0.1:8080` 更稳
- 本地 Full 模式 skill-test 可能超过 OpenSandbox 默认 5 分钟 TTL；在 `.env.local` 设置 `CAFF_SKILL_TEST_OPENSANDBOX_TIMEOUT_SEC=3600` 后重启 CAFF 可避免中途自动删容器
- 计划任务按“当前登录用户”注册；如果机器重启后没人登录，任务不会提前启动
- `run-caff-stack.ps1` 会持续运行并负责拉起子进程，所以计划任务保持 `Running` 状态是正常的
