# 改 CAFF 代码的流程（Claude Code 规划者视角）

流程以仓库的 `AGENTS.md` 和 `.agents/skills/caff-workflow/SKILL.md`（包括它的 `references/git-and-worktrees.md`、`checklists.md`、`environments.md`）为准，动手前先读。这里只补 Claude Code 特有的做法。

## 1. 澄清并确认

按 caff-workflow 的 grill-with-docs 规则：
- 事实自己查清楚，不要问用户。
- 把待定的决策编号列出来，每条附上推荐答案和取舍。
- 确认目标、非目标、约束和验收证据。
- 声明用 Direct、Goal 还是 DAG 模式，并说明理由。
- 拿到用户的明确确认之后，才能做第一个会改状态的动作，建分支也算。

## 2. 建 room 分支和 worktree

```bash
git -C <仓库根> fetch origin
git -C <仓库根> rev-parse develop origin/develop        # 两者不一致就停下来问用户
git -C <仓库根> check-ref-format --branch room/<id>-<slug>
git -C <仓库根> worktree add -b room/<id>-<slug> ../worktrees/room/<id>-<slug> <develop 的 SHA>
```

- `<id>` 取 CAFF 会话 ID 的前 8 位。Claude Code 会话没有 CAFF 会话 ID 时，用 Claude Code 会话 ID 的前 8 位，也就是 `~/.claude/projects/<项目目录>/` 下本会话 `.jsonl` 的文件名。
  - 同时开着几个会话时，最新的 `.jsonl` 不一定是当前会话。先在本会话里跑一条带独特字符串的命令，再用 `grep -l <那个字符串> *.jsonl` 确认。
  - 后台任务临时目录里的 ID 不能用，它可能和会话文件的 ID 不一样，比如会话是从 `/clear` 开始的时候。
- 先检查分支名和目标路径都还没被占用。

## 3. 装依赖

每个 worktree 单独执行 `npm ci`，不要共享或链接别的 worktree 的 `node_modules`（原因见 SKILL.md 的"命令坑"）。

## 4. 先红后绿

- 测试跑的是 `build/` 里的产物，所以改完代码要先 `npm run build`，再执行 `node tests/<area>/<name>.test.js`。
- 先改或新增断言，跑一遍确认失败（红），再改实现，跑到通过（绿）。按失败原因分类，别只数个数（见第 8 节）。
- 改 prompt 文字之前，先在 `server`、`tests`、`docs` 里 grep 原文，把所有出处一起改：代码、工具说明、工程契约文档、测试断言。

## 5. 检查

```bash
npm run typecheck
npm run test:fast       # 包含 check 和 build，要几分钟
git diff --check <base> <head>
```

- `test:smoke` 会用随机端口和临时 SQLite 起一个服务；`test:dag-execution` 不在 test:fast 里，改到 DAG 时单独跑。
- 测试里出现的 `127.0.0.1:3100` 都是 mock 掉的 fetch，不会真的打到运行中的实例。
- 日志写到系统临时目录，别写进 worktree。

## 6. 本地提交

```bash
git -c user.name=Claude -c user.email=claude@caff.local commit -F <消息文件>
```

- 仓库里的作者约定：GPT <gpt@caff.local>、GLM <glm@caff.local>、Kimi <kimi@caff.local>，Claude 用上面这个。身份写在命令里，不要依赖 `.git/config`，那里可能配着别的 agent。
- 提交信息用 conventional 格式，比如 `fix(goal): ...`，末尾加 Co-Authored-By 行。
- 只 add 本次改动涉及的文件。

## 7. 推送并开 PR（需要用户同意）

```bash
git push -u origin room/<id>-<slug>
gh pr create --base develop --head room/<id>-<slug> --title "<提交标题>" --body-file <正文文件>
gh pr checks <编号> --watch --interval 30   # CI 检查名是 unit
```

- PR 正文参照最近的 PR 来写，分这几节：Scope（写明 Candidate SHA 和 Baseline SHA）、Why、Validation、Independent review record（还没评审就写 Pending）、Limits / integration。最后附上 `.github/pull_request_template.md` 里的检查清单，没跑的项如实不勾。
- 正文先用 Write 工具写到临时文件，再通过 `--body-file` 传入。

## 8. 评审和合并

- 必须由非作者评审，作者不能评审或批准自己的改动。
- **模型族也要分开**（ADR 0002「Review」）。规划者评审实现者的工作时，两者来自不同模型族，这次评审才满足 no-self-review。来自同一模型族时（比如房间里的实现者也是 Claude），规划者的评审不算数，必须改由另一模型族的 agent 或用户评审。规划者自己写的改动，同样要由另一模型族的 agent 或用户评审。
- 交接说明用五段式：What / Why / Tradeoff / Open Questions / Next Action（见 caff-workflow 的 `checklists.md`）。
- 合并用 merge commit（`--no-ff` 语义），不要 squash，也不要 rebase，并且需要用户另外授权。

### 代 room 做独立评审

不碰 agent 的 worktree，也不往主仓库加 worktree 记录，全部在系统临时目录里做：

1. 克隆候选：`git clone --quiet --no-checkout <仓库根> <tmp>/repo`，再 `git -C <tmp>/repo checkout --quiet --detach <候选SHA>`。
2. 复跑检查：`npm ci` → `npm run typecheck` → `npm run test:fast` → `git diff --check <基线> <候选>`。作者声称跑过、但不在 test:fast 里的（`test:smoke`、`test:dag-execution` 等）单独复跑。耗时的命令放后台跑，日志写到 `<tmp>`。
3. 核实先红后绿：`git checkout <基线> -- <改过的实现文件>`，删掉新增的实现文件，保留新测试，`npm run build` 后单独跑新测试，应该失败。核完用 `git checkout <候选> -- .` 恢复。
   - **按失败原因分类，别只数个数。** 新测试给构造函数传了新参数时，基线上会成片报签名错误（比如多传了参数）。这种"红"证明不了行为断言能抓住缺陷。
   - 识别出来以后，在临时克隆的基线实现里临时让构造函数接受多余参数，再跑一次，确认真正失败的是行为断言，比如原因码、终态、退避序列。
4. 疑点用探针实测：在临时克隆的 `tests/` 下写探针测试，复用 `tests/helpers` 的夹具和 `createServerApp` 的合成 `executeConversationAgent`，实测结果再写进结论。
5. 用生产数据佐证：用临时克隆 `node_modules` 里的 better-sqlite3，以 `{ readonly: true, fileMustExist: true }` 打开实例 agent 目录里的 `pi-state.sqlite` 做只读统计（WAL 模式下不阻塞写入）。脚本放在 `<tmp>`，不放进克隆。
6. 结论按"阻塞 / 非阻塞"编号。
   - 规划者驱动的 Goal 里，里程碑评审和裁决暂停提案在委托范围内：先 dismiss owner 挂着的暂停提案，再 @owner 发结论，要求修完阻塞项、本地提交新 SHA 后停下，只复审修复部分。
   - 其他 room 的结论，先给用户过目再发。
   - 推送和开 PR 另行授权。

## 9. 让改动生效

合并到 develop 之后，生产实例要更新代码并重启才会生效，做法见 SKILL.md 的"部署生产实例"，重启是保留事项。按正式流程，应该先在 3200 验收实例验收，再走 release 发布到 main；走不走正式流程由用户决定。
