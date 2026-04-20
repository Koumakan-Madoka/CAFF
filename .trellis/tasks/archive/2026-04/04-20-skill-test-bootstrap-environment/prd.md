# PRD: 04-20-skill-test-bootstrap-environment

## Goal
- 为 `skill-test` 增加可选的 `preflight -> bootstrap -> verify -> run` 执行链路，让外部 skill 或环境敏感 skill 的“缺环境”问题可诊断、可修复、可复现。
- 保持默认 `host-loop + sandbox-tools` 架构不变，所有安装、校验与命令副作用都约束在 sandbox case world 中。
- 将环境安装经验沉淀到测试专用文档或结构化结果里，而不是污染 `SKILL.md` 主体提示词。

## Problem Statement
- 当前 `skill-test` 可以测试已被 registry 发现的 skill，但对外部 skill 的可测性上限，主要受运行时能力与依赖环境约束。
- 很多失败并不是 skill 逻辑本身有问题，而是因为缺少 CLI、包、运行时、浏览器、路径配置或基础网络前置条件。
- 这些环境失败现在与普通执行失败混在一起，既不利于诊断，也不利于把安装经验稳定沉淀为后续可复用的测试资产。
- 如果没有结构化的环境阶段，agent 只能在正式 case 中边失败边猜，结果既慢，也难以复盘，更难形成稳定的 regression 资产。

## Scope
- In scope:
- 在 skill-test case / run 层引入可选的环境准备阶段：`preflight`、`bootstrap`、`verify`。
- 支持为 skill 或 test case 声明 prerequisites、bootstrap steps、verification commands。
- 在隔离 sandbox 内执行环境安装与验证，并保留结构化执行证据。
- 为 run 结果增加环境类失败分类，例如 `env_missing`、`env_install_failed`、`env_verify_failed`、`runtime_unsupported`。
- 为环境经验提供稳定落点，例如 `TESTING.md`、结构化 patch 建议、或 run artifact 中的环境章节。
- 明确 runtime capability 差集；对 GUI、系统服务、管理员权限、硬件设备、真实账号密钥等无法在当前 runtime 提供的能力，直接标记 unsupported，而不是继续无限安装尝试。
- 让环境阶段与现有 `skill_test_run_event`、tool trace、evaluation persistence 兼容，避免生成另一套平行结果系统。
- Out of scope:
- 自动改写 `SKILL.md` 主体。
- 完整解决任意 GUI / 浏览器自动化 / 系统级服务 / 物理设备的高保真运行时支持。
- 扩展“任意来源 external skill 导入”这条发现链路本身；本任务聚焦于 skill 已接入后的环境准备与测试能力。
- 首期构建覆盖所有包管理器、所有平台、所有依赖类型的通用环境缓存平台。
- 首期自动把 environment patch 直接提交回第三方 skill 仓库。

## Requirements
- 默认 skill-test 行为保持不变；只有显式启用时才进入环境准备链路。
- `preflight` 需要在执行真实 skill case 之前给出清晰的缺失项、已满足项、以及不可满足项。
- `bootstrap` 仅允许在隔离 sandbox 中执行，且遵守现有工具、超时、egress 与资源限制。
- `verify` 需要提供可复查的 smoke evidence，确认环境已具备最低可运行条件。
- 结果展示与持久化需要把“环境失败”和“skill 逻辑失败”分离，避免误导评测结论。
- 文档沉淀必须优先落在测试专用位置，不污染 prompt 主体；对只读或外部 skill，至少产出可人工确认的 patch / 建议文本。
- 环境声明与 runtime 能力声明都必须可结构化比较，避免 agent 对明显不支持的能力进行盲目安装尝试。
- 环境链路失败时，run detail 仍要保留完整 trace、stdout/stderr 摘要、以及阶段级 status，便于回归对比。

## User Scenarios
### 1. 外部 skill 缺少 CLI / 包依赖
- 用户导入一个依赖 `uv`、`python` 或特定 npm CLI 的 skill。
- `preflight` 检查出缺失项。
- `bootstrap` 在 sandbox 内执行安装步骤。
- `verify` 用 smoke command 确认命令可用后，再进入正式 case。
- run 结果把这次安装过程沉淀为 `TESTING.md` patch 建议或环境章节。

### 2. runtime 能力天然不支持
- skill 依赖 GUI、系统服务、管理员权限、物理设备或真实账号登录。
- `preflight` 发现依赖与 runtime capability 无交集。
- run 直接标记 `runtime_unsupported`，并给出已知限制，不进入无限安装重试。

### 3. skill 逻辑本身失败
- 环境阶段通过，但正式 `run` 没达到期望步骤或目标。
- run 结果明确记为 `skill_failed`，避免把逻辑问题误归因到环境。

## Proposed Model
### 总体执行模型
```text
load case + env config
  -> preflight
  -> if unsupported: stop (runtime_unsupported)
  -> if missing and bootstrap disabled: stop (env_missing)
  -> bootstrap
  -> if install failed: stop (env_install_failed)
  -> verify
  -> if verify failed: stop (env_verify_failed)
  -> execute skill case
  -> classify final outcome
```

### 配置来源与优先级
环境计划按以下优先级合并：
1. run request 显式传入的临时 override
2. test case 持久化的 `environmentConfig`
3. skill 目录中的 `TESTING.md` 结构化章节或派生 metadata
4. 系统默认 policy

首期不要求四层都同时存在；最小实现允许先支持 `test case + run request` 两层，再为 `TESTING.md` 预留落点。

### 能力差集模型
- `skill requirements`: skill / case 声明自己需要的运行能力与依赖。
- `runtime capabilities`: sandbox 当前可提供的能力矩阵，例如 `bash`、可写文件系统、有限网络、允许的包管理器、是否支持 GUI。
- `capability diff`: 比较二者差集，提前输出：
  - `satisfied`
  - `missing_but_installable`
  - `unsupported`

这个差集是 `preflight` 的核心输出，也决定后续是否允许进入 `bootstrap`。

## API 草案
### Case create / update 扩展字段
在现有 test case schema 上新增可选 `environmentConfig`：

```json
{
  "environmentConfig": {
    "enabled": true,
    "policy": "optional",
    "requirements": [
      {
        "id": "python",
        "kind": "command",
        "name": "python",
        "versionHint": ">=3.10",
        "required": true,
        "installable": true
      }
    ],
    "bootstrap": {
      "commands": [
        "python -m pip install -r requirements.txt"
      ],
      "shell": "bash",
      "timeoutSec": 900
    },
    "verify": {
      "commands": [
        "python --version",
        "python -c \"import pkgutil; print('ok')\""
      ]
    },
    "docs": {
      "mode": "suggest-patch",
      "target": "TESTING.md"
    }
  }
}
```

约束：
- `environmentConfig` 整体可选；不存在时保持当前默认行为。
- `policy` 首期仅支持：`optional | required`。
- `bootstrap.commands`、`verify.commands` 都必须是显式数组，不接受隐式多行大字符串。
- `requirements[].kind` 首期建议限制为：`command | package | env | capability | service`。
- schema 校验失败时，沿用现有 `issues[] + caseSchemaStatus` 包装，不新增另一套错误信封。

### Run request 扩展字段
在现有 `POST /api/skills/:skillId/test-cases/:caseId/run` 请求体上新增：

```json
{
  "provider": "...",
  "model": "...",
  "promptVersion": "...",
  "agentId": "...",
  "agentName": "...",
  "isolation": {
    "mode": "isolated",
    "trellisMode": "none",
    "egressMode": "record",
    "publishGate": false
  },
  "environment": {
    "enabled": true,
    "mode": "case-default",
    "allowBootstrap": true,
    "persistAdvice": true,
    "override": {
      "requirements": [],
      "bootstrap": { "commands": [] },
      "verify": { "commands": [] }
    }
  }
}
```

语义：
- `environment.enabled = false`：完全跳过环境阶段。
- `mode = case-default`：使用 case 上保存的 `environmentConfig`。
- `allowBootstrap = false`：只做 `preflight` / `verify` 前置判断，不做安装。
- `persistAdvice = true`：允许产出 `TESTING.md` patch 建议或 run artifact 文档片段，但不自动回写主 skill。
- `override`：仅对本次 run 生效，不回写 case。

### Run-all 语义
- `POST /api/skills/:skillId/test-cases/run-all` 可复用同样的 `environment` 配置，但默认只对 `ready` case 生效。
- `run-all` 必须在响应与 SSE 中保留 case 级别环境阶段状态，避免批量执行时只看到最终 pass/fail。

## Data / Schema 草案
### `skill_test_cases`
新增：
- `environment_config_json TEXT NOT NULL DEFAULT '{}'`

说明：
- 作为 case 的环境计划真值来源。
- 继续沿用 JSON 存储风格，与 `expected_steps_json`、`evaluation_rubric_json` 一致。

### `skill_test_runs`
优先复用 `evaluation_json` 承载详细环境结果，不急着拆多列；首期只补少量投影字段：
- `environment_status TEXT DEFAULT ''`
- `environment_phase TEXT DEFAULT ''`

`evaluation_json.environment` 结构建议：

```json
{
  "status": "passed | env_missing | env_install_failed | env_verify_failed | runtime_unsupported | skipped",
  "phase": "preflight | bootstrap | verify | skipped | completed",
  "requirements": {
    "satisfied": [],
    "missing": [],
    "unsupported": []
  },
  "bootstrap": {
    "attempted": true,
    "commands": [],
    "results": []
  },
  "verify": {
    "attempted": true,
    "commands": [],
    "results": []
  },
  "advice": {
    "target": "TESTING.md",
    "mode": "suggest-patch",
    "patch": "...",
    "summary": "..."
  }
}
```

说明：
- 详细证据放 `evaluation_json.environment`，保持 run detail 一处读取。
- `environment_status` / `environment_phase` 仅作为 summary / filter / regression 的轻量投影。
- 不单独再建一张 environment runs 表，避免把一个 case run 拆成两套生命周期。

## Failure Taxonomy
新增或明确以下结果分类：
- `env_missing`: 检查到缺失项，但当前 run 禁止安装或没有可执行安装计划。
- `env_install_failed`: 已进入 `bootstrap`，但安装命令失败、超时或被策略拒绝。
- `env_verify_failed`: 安装后 smoke verification 未通过。
- `runtime_unsupported`: 所需能力不在当前 runtime capability 矩阵内，例如 GUI、管理员权限、系统服务、硬件、真实账号登录。
- `skill_failed`: 环境阶段通过，但正式 case 未满足 trigger / execution 预期。
- `passed`: 环境阶段与正式 case 都通过。

要求：
- 这些分类既要进入最终 run detail，也要进入 summary / regression 统计。
- 环境失败不能再被折叠进普通 `error_message` 文本，必须有结构化字段。

## 执行流草案
### 1. Case 预检
- 读取 test case 现有 schema。
- 归一化 `environmentConfig`。
- 若 case schema 或 environment schema 非法，直接返回统一 `issues[]`。

### 2. Preflight
- 计算 requirements 与 runtime capability 差集。
- 对 `command` 类 requirement 执行轻量探测，例如 `which` / `--version` / 自定义 probe command。
- 生成结构化结果：`satisfied[]`、`missing[]`、`unsupported[]`。
- 若存在 `unsupported[]`，直接标记 `runtime_unsupported` 并结束。
- 若存在 `missing[]` 且 `allowBootstrap = false`，直接标记 `env_missing` 并结束。

### 3. Bootstrap
- 仅在 sandbox case world 中执行 `bootstrap.commands`。
- 复用现有 `bash` 桥接、tool trace 与 isolation evidence；不要为环境阶段引入新的宿主机执行旁路。
- 每条命令都保留 stdout/stderr 摘要、exit code、超时与策略拒绝信息。
- 若命令失败，分类为 `env_install_failed`。

### 4. Verify
- 依次执行 `verify.commands`。
- 若 smoke command 未通过，则标记 `env_verify_failed`。
- 通过后才进入正式 skill run。

### 5. Skill Run
- 正式 case 继续沿用当前 dynamic/full evaluation 逻辑。
- 最终结果将环境阶段与 skill 阶段汇总到同一条 `skill_test_runs` 记录中。

### 6. Advice / Docs Sink
- 根据本次 run 的环境结果生成建议文本或 patch。
- 默认只生成建议，不自动写回 skill 目录。
- 如果后续允许人工确认回写，优先目标为 `TESTING.md`，而不是 `SKILL.md`。

## 文档沉淀草案
推荐新增测试专用文档 `TESTING.md`，并约定以下章节：
- `## Prerequisites`
- `## Bootstrap`
- `## Verification`
- `## Known Limits`

原则：
- `SKILL.md` 继续只承载 prompt / behavior instructions。
- `TESTING.md` 承载环境依赖、安装经验和测试限制。
- 对第三方或只读 skill，系统至少输出 patch 建议到 run artifact，由人决定是否回写。

## UI / 结果呈现建议
- case 编辑页在 advanced 区域暴露 `environmentConfig`，默认折叠。
- run detail 增加独立 `Environment` 区块，展示：
  - 差集结果
  - bootstrap 命令与结果
  - verify 证据
  - advice / patch 建议
- summary / regression 至少按 `environment_status` 聚合，区分“环境问题”和“skill 逻辑问题”。

## Rollout 建议
### Phase 1
- 支持 case / run 上的 `environmentConfig`
- 接入 `preflight -> bootstrap -> verify`
- 结果持久化到 `evaluation_json.environment`
- 基础失败分类上线

### Phase 2
- 为 `TESTING.md` 生成结构化 patch 建议
- UI 显示环境结果卡片
- summary / regression 增加环境维度统计

### Phase 3
- 引入 `restore-then-verify` 的环境缓存，优先减少重复 `bootstrap`
- 缓存 artifact 落在 host 侧项目级目录，restore / verify / 后续副作用仍保持 sandbox case world 语义
- cache key 至少覆盖 `skillId + planHash + worldHash`，其中 `planHash` 包含 requirements/bootstrap/verify/TESTING.md 来源，`worldHash` 包含 driver/image/platform 等 runtime 维度
- 详见 `./phase-3-environment-cache.md`

## Acceptance Criteria
- [x] run 请求可选启用环境准备阶段，且未启用时继续沿用现有 skill-test 默认链路。
- [x] skill-test 能在 run 结果中明确区分 `env_missing`、`env_install_failed`、`env_verify_failed`、`runtime_unsupported` 与普通 `skill_failed`。
- [x] 环境安装、校验与文件副作用仅发生在 sandbox case world，不污染 host 工作区。
- [x] 失败结果包含结构化缺失项、安装尝试记录与验证证据，便于复盘与回归。
- [x] 系统能为 skill 输出测试专用环境文档落点或 patch 建议，且不会自动污染 `SKILL.md` 主体。
- [x] 对当前 runtime 明确不支持的依赖类型，系统会 fail fast 并给出 unsupported 原因，而不是反复重试安装。
- [x] 环境阶段与现有 live event、tool trace、run detail、summary / regression 链路兼容，不引入割裂的第二套结果展示。

## Open Questions
- 环境声明的最小 schema 放在 skill metadata、test case schema，还是单独的 testing manifest 中。
- `TESTING.md` 是否需要 machine-readable frontmatter，还是先用结构化 Markdown + 运行时解析。
- bootstrap 命令是否完全由 case 自带，还是允许 agent 在 preflight 结果基础上生成候选安装计划。
- `environment_status` 是否要进入单独列做高效筛选，还是先完全依赖 `evaluation_json` 投影。
- `run-all` 下环境阶段失败是否要支持“后续 case 继续跑”与“遇到 unsupported 立即终止”两种策略。
- 环境缓存是否只复用同一个 skill 的安装层，还是允许跨 skill 共享基础镜像能力。