# WikiSkill：Windows 操作方入口

适用于 Windows 原生 Node（本次验证 v24.13.1）、明确指定的 WSL Debian 与本机 Docker。行为及不支持范围见 [采集/回放契约](badcase-capture-replay.md)。这是操作说明，不是正式评测的采纳结论。2026-11-05 新实验的二值断言、逐题模型、校准目录和独立计划见[评分 v2 契约](wikiskill-scoring.md)；下列字面规则命令仍为兼容入口，不能据此声称使用了 AI 裁判。

## 1. 准备干净 checkout 与隔离目录

1. 按已经授权的固定 SHA 创建本地 clone，`git checkout --detach <SHA>`，核对 `git status --porcelain` 为空。不要在生产 checkout 执行；无需推送。
2. 在 clone 中执行 `npm ci --include=dev --no-audit --no-fund`、`npm run build`。不要复制 Windows/Linux 另一端的 `node_modules`。安装使用受信依赖及操作方批准的代理，不携带生产集成凭据。
3. 在 checkout **外**准备本实例的 agent 目录、SQLite、临时目录、HOME、日志和无 Key 的 JSON 配置。新环境默认没有用例；已有数据只能来自明确获准的副本，不能为演示连接生产库。正式搬迁须使用已验证的[离线迁移命令](wikiskill-data-migration.md)，不能仅复制当前快照而遗漏历史现场。
4. 服务端口选 3268；先验证没有未知占用。重启前核对原实例 PID、来源、数据库、无活动 turn，再停已证明属于本实例的进程。不按端口猜测杀进程。
5. 不复制 `.env.local`、`auth.json` 或整个生产 agent 目录。正常服务不必持有 GPT access；独立评测命令按下面的显式路径只读宿主 access。不在 JSON、日志或命令行写任何 Key 原值。

## 2. 页面运行时配置与正常服务启动

`wiki-runtime.json` 是操作方私有配置，不提交。填写实际固定镜像身份；本地构建的 rg13 镜像还须包含契约中的 `localBuild`，不能填伪造 digest。

```json
{
  "image": {
    "imageId": "sha256:<64位实际image ID>",
    "repositoryDigest": "node@sha256:<64位实际base digest>",
    "architecture": "amd64",
    "nodeVersion": "v24.21.0",
    "pythonVersion": "Python 3.11.2",
    "localBuild": "wikiskill-rg13-v1"
  },
  "dockerBackend": { "kind": "windows-wsl-v1", "distribution": "Debian" },
  "credentialDir": "E:/approved-host/.pi-sandbox"
}
```

`credentialDir` 中 `models.json` 的 DeepSeek 官方配置须已获准读取；模型固定 `deepseek/deepseek-v4-flash`，网络固定经宿主 17890。Key 不进入 WSL/容器；不自动选发行版、拉镜像、换凭据或直连回退。

在隔离 HOME/TEMP、没有生产凭据/飞书环境变量、没有继承生产副作用配置的 shell 中，从 clone 执行（以下为 Git Bash，路径换成实际绝对路径）：

```sh
export CHAT_APP_HOST=127.0.0.1 CHAT_APP_PORT=3268
export PI_CODING_AGENT_DIR='E:/isolated-wiki/agent'
export PI_SQLITE_PATH='E:/isolated-wiki/chat.sqlite'
export CAFF_BADCASE_WIKI_RUNTIME_CONFIG='E:/isolated-wiki/wiki-runtime.json'
export CAFF_PLANNER_TERMINAL=false TYPESAFE_ENABLED=false
node scripts/start-app.js > 'E:/isolated-wiki/server.log' 2>&1
```

也可用 `npm start`（相同入口，另执行 ensure-build）。无需 `.tmp` 启动脚本、供应方注入或 `GIT_CONFIG_*` 全局设置。默认 uploads 位于这个 clone 的 build 目录，与生产隔离。若要在聊天中采集 GPT，还需另行配置已授权的角色/采集及 D4 宿主传输；上面的页面启动不代表新聊天 GPT 已就绪。

打开 `http://127.0.0.1:3268/api/bootstrap`，核对数据库、agentDir、端口；核对 health 的飞书未配置、planner 已禁用、无活动 turn。不要把独立端口当作全部隔离证据。

## 3. 页面预分类与归纳

打开 `http://127.0.0.1:3268/wikiskill.html`：

- 有待预分类用例时，知识库“待你处理”或用例分区的 **预分类并定组** 调用一次真实模型，按现有 approved 模式预分类、冻结组别。点击前核对待处理范围，点击后等待结果；刷新核对实际归类与组别，不自动重试。门槛/测试归类仍须人工确认。
- 没有待预分类、有 pending 训练用例时，同位置显示 **用模型归纳新用例**；只产生建议/草稿，不自动批准准则，不让门槛/测试题进入归纳。
- 空队列时按钮禁用；这不是启动故障。不要修改冻结组别或把正常回复标为 badcase 来凑演示。
- 凭据/网络/额度失败停止检查，不能改成合成供应方却声称真实模型成功。
- 模型输出校验失败时，默认在当前checkout的git忽略私有目录 `.tmp/private-wikiskill-diagnostics/` 保存脱敏后的原HTTP200响应正文与精确字段/规则；只本机诊断，不附到证据、截图、Wiki记录、HTTP或公开消息，也不提交/外发。扫描所选宿主credentialDir的静态Key/access与内存环境已知值（包括JSON转义/base64）和秘密哨兵；没有数据库访问/refresh使用。若日志不可写或已知值不可读，保留原校验失败、不给未脱敏日志落盘，只报告固定不可用事件。目录0700/文件0600，Windows实际隔离仍依赖本机ACL，同OS用户可读取，不是技术沙箱。同一原因先红后绿最多人工修两次，第三次仍422停止并报告字段与规则，不自动重试。成功不保存原文。

## 4. 准备运行时及仓库依赖（首次/缓存未命中时）

镜像必须已按契约在本地准备。`runtime.json` 只含上面的 `image` 和 `dockerBackend`：

```sh
node scripts/badcase-capture/cache-runtime-dependencies.cjs 'E:/isolated-wiki/runtime.json' 'E:/isolated-wiki/runtime-cache'
node scripts/badcase-capture/cache-replay-dependencies.cjs 'E:/isolated-wiki/comparison.json' 'E:/isolated-wiki/repository-cache'
```

第一个命令返回的 `dependencyRoot` 填入 comparison。第二个配置是下一节 `comparison` 子对象本身，**不是**外层页面配置。缓存命中仍核验身份/字节；不把旧镜像的安装回执直接挪用。Windows 需要可验证的 WSL NAT 网关；特殊/mirrored 网络不自动配置防火墙。

## 5. 一条受信命令启动，页面只读观察

外层 `evaluation.json` 恰含 `globalRoot/sourceWorktree/comparison`：

```json
{
  "globalRoot": "E:/isolated-wiki/agent/badcase-global",
  "sourceWorktree": "E:/clean-checkout",
  "comparison": {
    "request": {
      "captureRoot": "E:/approved-isolated-source/agent/badcase-capture",
      "association": {
        "projectId": "<source project>", "conversationId": "<source room>",
        "messageId": "<source message>", "turnId": "<source turn>",
        "agentId": "role-family-gpt", "taskId": "<source task>",
        "checkpointId": "<sealed checkpoint>", "runId": 1
      },
      "flagId": "<durable annotation ID>"
    },
    "repoRoot": "E:/clean-checkout",
    "dependencyRoot": "E:/isolated-wiki/runtime-cache/<returned identity>/root",
    "image": { "imageId": "sha256:<actual>", "repositoryDigest": "node@sha256:<actual>", "architecture": "amd64", "nodeVersion": "v24.21.0", "pythonVersion": "Python 3.11.2", "localBuild": "wikiskill-rg13-v1" },
    "dockerBackend": { "kind": "windows-wsl-v1", "distribution": "Debian" },
    "modelProfile": "openai-codex/gpt-6.1-sol",
    "keySource": "caff-codex-access",
    "codexAuthFile": "E:/approved-host/.pi-sandbox/auth.json",
    "knownKeySources": { "sandboxRoot": "E:/approved-host/.pi-sandbox", "jevSource": "pi-state.sqlite:turn-time-breakdown-jev" },
    "repository": { "sourceRoot": "E:/approved-source-clone", "head": "<recorded full HEAD>", "refState": { "head": null, "refs": ["refs/heads/develop"], "symbolicRefs": {} } },
    "dependencies": { "kind": "npm-ci-linux-v1", "cacheRoot": "E:/isolated-wiki/repository-cache" },
    "variants": ["original"], "repeats": 3, "timeoutMs": 2700000,
    "rules": { "kind": "read-only-files-v1", "readPaths": ["README.md"], "absentPaths": [], "requiredReplyFragments": ["<user-confirmed literal>"] }
  }
}
```

关联、HEAD/ref、原规则取用户批准的封存记录，不能猜测。`sourceRoot` 是原封存工作根，`repoRoot/sourceWorktree` 是当前干净的工具 checkout，两者用途不同。knownKeySources 的 SQLite 单行只读权限须另获批准，不因示例出现路径就自动授权读取。示例不是对新规则、模型消耗或任何正式门槛执行的批准。

```sh
node scripts/badcase-capture/run-wiki-evaluation.cjs --config 'E:/isolated-wiki/evaluation.json' --plan
node scripts/badcase-capture/run-wiki-evaluation.cjs --config 'E:/isolated-wiki/evaluation.json' --run --confirmed --expected-plan '<planHash>' --output 'E:/isolated-wiki/new-run.jsonl'
```

先检查 JSON 的 `supported/preparedOnly` 与模型/xhigh/材料信息；plan 不调用模型。确认当前计划后，第二行就是启动评测的一条命令，输出文件必须不存在。页面 **评测记录** 每5秒更新当前轮次、完成数、字面通过数、已知 token 和状态；无网页启动/重试接口。进度滞后只提示，不擅自续跑。结果与原始 JSONL 的 execution ID 对应。

**原版三次观察不产生采纳结论**；人工观察不能被占位规则的 pass/fail 替代。本**单例**入口不是正式多题门槛/测试；正式评测使用下节独立命令。两者都不混合独立执行、不修改生产提示词；只有用户明确采纳正式结果才建立评测基线。

## 6. 正式生产门槛／测试（D15）

以下是 legacy 字面规则配置。v2 须额外固定 `experiment` 及逐题 `rubricHash`，禁止 `rulesRevision/topicExemption`，并由受信宿主注入逐题已冻结裁判；裸 CLI 不会自动读取 Key、创建裁判或运行评分。断言编辑器须配置 `CAFF_WIKISKILL_JUDGES_CONFIG` 的绝对 JSON 文件路径，校准目录和相邻冻结文件均不含 Key；无目录时没有可选打分模型，不能冻结。细节与限制以上述评分v2契约为准，页面仍不启动回放。

使用同一个已构建checkout的 `compare-wiki-batch.cjs`，不是上一节的单例外层JSON。生产配置包含：

- `globalRoot/sourceWorktree/candidateId/repoRoot/dependencyRoot/image`：页面对应的集合、已确认全局系统提示词候选、工具checkout及固定Linux分发/镜像。
- `modelProfile:"openai-codex/gpt-6.1-sol"`、`keySource:"caff-codex-access"`、`codexAuthFile/knownKeySources/dockerBackend`：与单例相同；固定 xhigh、Fast关闭、原生SSE，凭据仅在Windows宿主内存。
- `repeats:10`、`timeoutMs:2700000`、`evaluation:{"kind":"wikiskill-gate-v1","targetEntryId":"<approved entry ID>"}`。组别从D15冻结数据读取，不能填旧代理模式的gate/test列表。
- `cases`：保留用户批准的题目，每项含 `sourceCaseId/category`（`reproduction/probe/control`）。真实标记题另填逐题 `repository/dependencies`；样例防误伤题显式填已准备的 `replayVersionId`，不继承真实仓库恢复。只有获批规则修订才填 `rulesRevision:"snapshot-head-exemption-v1"` 或 `topicExemption:{patterns,taskHash,reason}`；不能手写放行SHA或任意规则。

```sh
node scripts/badcase-capture/compare-wiki-batch.cjs --config 'E:/isolated-wiki/batch.json' --plan
node scripts/badcase-capture/compare-wiki-batch.cjs --config 'E:/isolated-wiki/batch.json' --run --confirmed --expected-plan '<new planHash>' --output 'E:/isolated-wiki/new-batch.jsonl'
```

执行前检查全部题目材料、GPT来源、已确认归类、规则/豁免、候选diff和experienceHash。draft可只读生成preview，但 `candidateConfirmationRequired:true` 时不可运行；确认候选后重新生成计划，取得**独立的用户开跑批准**才执行第二行。迁移或配置变化也须新计划/新批准，不能复用旧hash。

每题原版/候选交替，各10次有效；每题两版共享最多5次环境替补，当前执行器串行，不超过3容器并发上限。每题最多25次尝试，环境错误另列、不改变有效分母；缺清理回执、证据漂移、凭据过期/额度错误立即停批。门槛仅在目标复现题单侧Fisher p<0.05且防误伤损失≤max(1,总次数×5%)时接受；接受才运行测试，测试单独报告。非GPT来源只报告，不计入GPT结论。页面每5秒显示阶段/题目/版本/次数、环境错误及完成结果；没有网页启动接口。

**门槛接受不是采纳。** 以下为上一 Goal 的历史字面规则 M4，不是本轮评分v2：门槛#19为0/10→6/10（p=0.0054），#16双方10/10；测试#20双方0/10，#10/#14双方10/10。#20开头结论率3/10→8/10，但题目本身讨论P1/P2/P3，两版全部命中冻结禁用规则。只能说修好了#19这一类，不能说模式1整体变好；候选bc807f8a未采纳、基线不变。规则B是在看过作废轮0/4–0/4后修订，旧规则/结果保留、排除、不拼接；正式轮两次网络错误已清理并替补，分母不变。

评测保存后自动产生经验**草稿**，审核后才进入模式页两栏。候选固定读取已审经验，但不会自动改写准则。模式1经验v1已审；第二轮候选050be1fb在当时仅确认/准备计划。此后获批的本轮评分v2已完成唯一D8重跑：门槛接受，#20两版0/10，按D7不采纳；#10仅4/7次有效、整批incomplete，不能称为完整防误伤验证。#20注明“已看过一次的测试题”；旧字面主题编号豁免只属历史新规则，不用于v2。详见评分v2契约及Goal证据，没有第三批或上线重跑授权。

## 7. 保存证据并停止

记录固定 SHA、干净状态、安装/build 命令、服务 PID/启动日志、隔离路径与健康状态；截图应包括预分类前后、归纳建议、评测运行中和结束。保存 CLI plan/JSONL 与页面执行 ID。日志/截图/JSONL 保存在忽略或私有目录，不提交含原始现场的数据。扫描已获准的已知秘密，不能打印值。

停止当前已证明归属的前台服务（Ctrl+C / SIGTERM）；核对监听消失、容器清理及源数据未变。不清理他人目录或遗留未知进程，不推送、不迁移生产、不部署。

### 2026-11-03 实测边界

代码 `26b73a50` 的新本地 clone 独立执行 npm ci/build，按上面的正常入口在 3268 先后运行两份历史快照副本（rev25 的待预分类④；rev5 的13条待归纳训练题）。未改原快照、原封存或冻结分组，也未连接3100。Edge真实点击预分类成功：DeepSeek建议模式4、门槛组；无人工归类确认。真实 GPT/xhigh 原版三次命令成功，页面实测执行中→3/3完成；占位字面规则0/3只用于显示验证，不作为行为评分或采纳依据。

早期真实归纳两次422未保留结果，具体字段与供应方用量仍记未知，不追认。另一次获准诊断发现非stop截断及symptoms数组/字符串不符，已先红后绿明确字段类型、预算提到32768；这不代表已解释未捕获的两次422。原始操作与截图在忽略目录 `.tmp/wikiskill-production-m3/clean-clone/`，不是生产迁移验收。

新增默认私有日志后，`89660051` 在同一干净clone、3268、rev5的13条训练副本中真实页面归纳，精确拒绝 `results / must_cover_each_input_once`（完整stop输出仅12条），零发布、未重试。先红后绿仅给提示词增加末尾精确有序ID/数量清单，不放宽覆盖或字段、不补写结果。`b44e02f8` 修后仅一次真实页面点击HTTP200：37.591秒，DeepSeek一次HTTP200、126802已知token，副本rev5→6，保存13条待审核建议，最新版本共10条草稿（含原有5条）；容器断网/无凭据/无挂载、已清理。页面可选择 `wiki-6` 查看新草稿，不自动审核或合并，不改正式存储。失败原文只在clone本机私有目录，验收证据只保存字段/数量等安全元数据与成功页面/回执，见 `.tmp/wikiskill-production-m3/private-logging/`。新失败原因只修1次即通过；M3最终固定SHA `bb876b56` 已经规划者独立评审通过。M4/M5/M6的真实生产批量、经验回流和副本迁移边界见契约与各自Goal证据；不沿用这些早期记录替代S1双平台最终全量。发布顺序见[发布审批步骤](wikiskill-release.md)，本操作说明不授权部署。
