---
feature_ids: [F005]
related_features: [F002, F003, F004]
topics: [chat, image, multimodal, content-blocks, capability, routing, upload, storage, provider]
doc_kind: spec
created: 2026-08-09
---

# F005: Image Input and Multimodal Message Routing

> **Status**: in-progress (Phase A/B merged; Phase C implemented, awaiting review/merge) | **Owner**: @opus/布偶猫 (kickoff lead) | **Priority**: P1

## Why

CAFF 聊天目前只支持纯文本消息：`chat_messages.content` 是单一 TEXT，发送接口只接收 `{ content, clientRequestId }`，没有任何图片输入、内容块或多模态能力判定的契约。CAFF 原始改造愿景（`thread_msiputnz4yxhs6j3`）明确要求"支持图片输入"，且多模态路由不能靠硬编码模型名猜——必须在 capability registry 层回答"这个模型能不能读图"，再决定把图片送给谁。

价值终点：operator 在聊天里选一张图、预览、随文本发出，带图消息在刷新/历史回放/继续会话后依然完整；路由层依据 CAFF 自己的 capability registry 判断目标模型是否支持图片输入，支持的 provider adapter 收到结构化 image 内容，不支持的模型在发送前或路由处被明确阻断——任何路径都不得静默丢图。

## Current State / 现状基线

Baseline: `origin/main@3c51a8b` (2026-08-08)。
- `chat_messages` 表只有 `content TEXT NOT NULL`，`metadata_json TEXT` 已承接 F003 的 `clientRequestId`、上下文快照等扩展，但**没有 content-block 或图片契约**（`storage/sqlite/migrations.ts:284-300`；`storage/chat/message.repository.ts` 全部按 string 读写）。
- 前端 composer 只发 `{ content, clientRequestId }` 到 `POST /api/conversations/:id/messages`（`public/app.js:4375-4378`；`server/api/conversations-controller.ts:1017-1020`）；输入区只有 textarea（`public/index.html:96-113`），无 file input/预览/拖拽。
- 消息投影：`turn-orchestrator` → `routing-executor` 把消息组装成 `promptMessages`（`prompt-visibility.ts`），`agent-executor.ts:1239-1240` 用 `buildAgentTurnPromptSections`/`formatAgentTurnPromptSections` 拼成**纯字符串 prompt**，经 `startRun(provider, model, prompt, ...)`（`agent-executor.ts:1456`）进入 `pi-sdk-host.mjs` 的 `session.prompt(prompt)`（`pi-sdk-host.mjs:225`）。整条链目前只消费字符串。
- PI runtime 已能解析 assistant 侧的 content-block 数组（`lib/pi-runtime.ts:174-205` 的 `extractAssistantText` / `assistantMessageHasPendingToolUse`），说明 SDK 事件流是结构化的，但 **user prompt 输入仍是单字符串**，无 image 入口。
- models domain（F004）：`model-provider-config.ts` 的运行时契约只有 `id/name/api/baseUrl/family/reasoning`，**无 modalities/vision/capability 字段**；vendored `assets/model-catalog.json` 里有 `modalities: { input: [...], output: [...] }`，但按 F004 明确属于 catalog metadata，**不得静默升级为 runtime 能力**。
- 无 `/uploads/` 静态服务、无 multipart 解析、无图片上传校验、无图片存储（仓库里仅头像 data URL 校验先例：`lib/chat-app-store.ts:222` 限制 png/jpeg/webp/gif）。

## What

### Phase A: 统一 content-block 契约 + 受控图片上传存储

**文本单一真相源（canonical）**：`content`（TEXT 列）是消息文本的唯一真相源。`metadata_json.contentBlocks` 里的 `{ type: 'text', text }` 是**写入时的派生视图**，不是第二真相源：

- **写入派生**：服务端落库时由 `content` 派生 text block（`contentBlocks = [{type:'text', text: content}, ...imageBlocks]`），客户端**只提交 `content` + `imageIds`**，不得直接提交 text block。
- **冲突拒绝**：客户端请求中若携带 `contentBlocks` 或与 `content` 冲突的 text 内容，服务端返回 400（结构化错误 `TEXT_BLOCK_FROM_CLIENT_REJECTED`），拒绝落库。
- **读取规则**：FTS 搜索、摘要 digest、历史解析一律只读 `content`；`contentBlocks` 仅供渲染结构与图片引用。`content` 与 text block 永不并行歧义。
- **image-only 消息（P1-3 定案）**：`content.trim() || imageIds.length > 0` 为合法消息。纯图消息允许空 `content`，此时**不生成 text block**（`contentBlocks` 只有 image blocks），`content` 落库为空字符串。前后端空文本校验同步放宽（现 `public/app.js:4319-4321`、`turn-orchestrator.ts:1405-1407` 的"Message content is required"改为"content 为空时必须有 imageIds"）。

- 定义最小 content-block 契约：消息在现有 `content` 纯文本之上，经 `metadata_json.contentBlocks` 携带可选结构化块，首版只含 `{ type: 'text', text }`（服务端派生）与 `{ type: 'image', imageId, url, alt? }`（url 由服务端投影，见下）。`content` 保持兼容，历史消息、FTS 搜索、摘要 digest 不破坏。
- **受控 opaque 引用（SSRF 面为零）**：上传端点按 **batch 契约（P1-2 定案）**返回 `{ images: [{ imageId }] }`（有序 opaque id 数组，与请求 file 顺序一致；不返回持久 url——首版 UI 用 objectURL 预览，无需提前持有持久 URL）。客户端**只提交 `imageIds: string[]`（opaque id）**，服务端在落库时校验归属/存在/状态后投影出 `/uploads/...` URL 写入 contentBlocks。客户端无法提交任意 URL/路径——`/uploads/` 静态路由只接受服务端生成的受控文件名，无符号路径解析，无远程抓取。
- 新增受控图片上传端点：MIME 白名单（png/jpeg/webp/gif）、**magic-byte 校验（不信任浏览器 MIME）**、**结构头解析校验（签名/尺寸头/像素，见 P1-5——只承诺结构头解析成功，不承诺完整解码）**、单文件大小上限、每次张数上限、文件名消毒防路径穿越；图片存到 upload 目录并通过静态路由暴露。
- **图片生命周期（P1-2/P1-3 定案：最小 `image_uploads` registry 表，非重型附件系统）**：新增 `image_uploads` SQLite 表作为图片状态的**持久化真相源**。完整 schema 与状态机见下（P1-3 补 client_request_id 约束，R4 补 batch identity/integrity，R5 修正可执行 schema 与 lifecycle 去 broken）。
- **`image_uploads` registry schema（P1-3 定案 + R4 补 batch identity/integrity + R5 补 crash-consistent 提交协议与可执行 schema）**：
  - **批级 `image_upload_batches` 表（R4 P1-2 新增，R5 补 lease/check/postcondition，R6 补 fenced lease + conversation FK，R7 P1-3 补 consumption truth，batch completion truth）**：`batch_id` PK、`conversation_id` NOT NULL **REFERENCES `chat_conversations(id)`**（R6 P1-2 明确 FK：会话删除必须先 purge 本表行，不能依赖 CASCADE 碰运气）、`client_request_id` NOT NULL、`request_fingerprint` NOT NULL、`expected_count` NOT NULL、`status` NOT NULL（`pending | complete | rejected`）、`lease_token`（nullable，R6 P1-1：fenced lease 随机令牌，CAS 条件 UPDATE 取唯一所有权）、`lease_expires_at`（nullable，R5 P2-1 + R6 P1-1：pending recovery lease 有效期）、`rejected_reason`（nullable，R5 P2-1 + R7 P2-1：rejected 终态语义，必填于 rejected 转移）、`consumed_at`（nullable，**R7 P1-3：batch 整批消费时间戳**）、`created_at` NOT NULL、`completed_at`（nullable）。**唯一约束** `UNIQUE(conversation_id, client_request_id)`——batch identity 的持久化真相源。**可执行 invariants（R5 P2-1 + R6 P1-1 + R7 P1-1/P1-3/P2-1）**：CHECK `1 <= expected_count <= MAX_IMAGES_PER_UPLOAD`；`complete` ⟺ `completed_at IS NOT NULL`（置 complete 时同一 transaction 写 completed_at）；complete 时 child row count = `expected_count` 且 slots 连续 `0..expected_count-1`（后置条件，attach 前校验）；`pending` 行带 `lease_token` + `lease_expires_at`（fenced reservation lease，R6 P1-1），**所有权以 CAS 条件 UPDATE 取得唯一 `lease_token` 为准**（resume/takeover 必须持有效 token，非 owner 不得继续文件管线，见提交协议）；`rejected` 必有 `rejected_reason` 且为终态（**R7 P2-1：只有确定性校验失败进入 rejected——见「失败分类与 rejected 执行路径」；TTL GC 清理，不转其他状态**）。**整批消费/整批 GC 模型（R7 P1-3）**：batch 是**消费单元**——`attach` 一次消费该 batch **全部 child rows**（消息引用某 batch 的任意子集 → 拒绝，见 attach 单事务）；**整批 GC**——未消费的 complete batch 与其全部 child rows 在同一 TTL 事件整体清理（不逐 child GC，杜绝"batch complete 而 child 被单个 GC"的 canonical 悬空）；`consumed_at` 在 batch 最后一次 child 全部 attached 时写入。**不变量：batch 生命周期在 complete/rejected 之后只有整批转移（整批消费或整批 GC），不存在"部分 child attached、部分 child GC"的混合态**——这消除了 batch canonical 与 child TTL 的冲突（R7 P1-3 定案，替代 R5 的"child 各自 TTL"语义）。
  - **`request_fingerprint`（R4 P1-1 + R5 P1-1/P2-3 修订：服务端权威）**：**由服务端对实际接收并校验后的 multipart bytes 计算**的确定性摘要 = `hash(ordered [normalized_mime, size_bytes, file_content_hash] per file, count)`（R5 P1-1：客户端 digest 最多是 hint，服务端必须基于实际 bytes 重算/核对，不同 payload 不能伪造同 fingerprint）。**filename 明确为非语义字段**（R5 P2-3：仅持久化展示用途，不参与 fingerprint；同字节同 key 同 filename 变体视为同 payload，展示 metadata 以服务端实际持久化值为准）。**同 `(conversation_id, client_request_id)` 重试时**：fingerprint 一致 → 返回 canonical `{ images }`（幂等）；**fingerprint 不一致（payload 已变）→ 409 `UPLOAD_IDEMPOTENCY_CONFLICT`**，服务端返回既有批次与差异说明，前端必须换新 key 重新上传。任何 strip 变更（增删图、改顺序、换文件）都要求新 `client_request_id`。
  - **图级 `image_uploads` 列（R5 P1-2 修订）**：`image_id` PK、`batch_id` NOT NULL REFERENCES `image_upload_batches(batch_id)`、`status` NOT NULL、`slot` NOT NULL（batch 内 0-based 位置）、`file_name`、`stored_path` NOT NULL、`mime_type`、`width`、`height`、`size_bytes`、`attached_message_id`（nullable）REFERENCES `chat_messages(id) ON DELETE RESTRICT`、`attached_at`（nullable）、`integrity_status` NOT NULL DEFAULT 'ok'（R4 P1-5：`ok | missing_file`）、`integrity_error`（nullable，R4 P1-5）、`created_at`、`ttl_expires_at`（nullable）。
  - **唯一约束（R5 P1-2 修正）**：`UNIQUE(batch_id, slot)`——同一次上传批次的每张图占据固定槽位（`conversation_id`/`client_request_id` 归属经 batch FK 提供，**不在 child 表冗余**，消除漂移；R5 P1-2 修正 R4 无效约束 `UNIQUE(conversation_id, client_request_id, slot)`）。
  - **`client_request_id` 语义**：**上传请求 id**，由前端**在首次上传尝试前生成**（选择第一张图、进入 strip 时即生成，不是点击发送时——P1-2 修正现 `app.js:4363` 的时机），同一批次的全部图片共享，跨"结果未知"重试复用。发送消息用的是**另一个消息级 `clientRequestId`**（现有 F003 机制）。
  - **生命周期状态机（R5 P1-2 修正：只留 `staged | attached | recycled`，完整性统一走 `integrity_status`；R7 P1-3 整批消费语义）**：`staged`（上传完成，未关联消息）→ `attached`（消息落库时原子 UPDATE，写入 `attached_message_id`/`attached_at`）；`recycled`（消息删除后由 attached 转入，可由 GC 释放）。**R7 P1-3：child 的 `staged→attached` 只能整批发生**——attach 一次消费 batch 全部 child（消息引用该 batch 任意子集 → 拒绝），因此同一 batch 的 child 要么全部 `staged`（未消费）要么全部 `attached`（已消费，同一条消息）要么全部 `recycled`（消息删除后），不存在"同 batch 内部分 attached 部分 staged"的混合态。**删除 `broken` 状态**（R5 P1-2：`broken` 与 `integrity_status='missing_file'` 是同一事实的双重表达，属双真相源）——文件缺失一律以 `integrity_status='missing_file'` 表达，不设独立 lifecycle 状态。
  - **转移约束（R4 P2-2 + R5 P1-2 补可执行 SQL invariants）**：
    - `status` CHECK 枚举 `staged|attached|recycled`；`integrity_status` CHECK 枚举 `ok|missing_file`；`slot` CHECK `0 <= slot < MAX_IMAGES_PER_UPLOAD`。
    - **完整性 invariants（R5 P2-1）**：`integrity_status='ok'` ⟺ `integrity_error IS NULL`；`integrity_status='missing_file'` → `integrity_error IS NOT NULL`；**任何 status 下**文件缺失都用 `integrity_status='missing_file'`（R5 P1-2 修正：不再有 `broken` 状态，staged/recycled 缺文件同样落 integrity 标记，由 GC 清理，不设 lifecycle 分支）。
    - `attached` 后置条件：`attached_message_id` 与 `attached_at` 均 NOT NULL；`staged`/`recycled` 时二者均 NULL（UPDATE 语句强制）。
    - `recycled` 后置条件：`ttl_expires_at` NOT NULL（由 attached→recycled 转移时写入 `now()`）。
    - 仅 `staged` 可 → `attached`；仅 `attached` 可 → `recycled`（转移时**清空** `attached_message_id`/`attached_at`，回收语义 = 从消息生命周期分离）；`attached` 行文件缺失时 `integrity_status='missing_file'` + `integrity_error`（**保留 attached 状态与消息关联**，R4 P1-5——不再依赖"仅记录告警"）。
    - `recycled`/超 TTL 的 `staged`/`integrity_status='missing_file'` 的非 attached 行由 GC 删文件 + 删行；`attached` 不允许被直接删除（必须先转 `recycled`，`attached_message_id ON DELETE RESTRICT` 强制）。**R7 P1-3 整批 GC 修正**：未消费（`consumed_at IS NULL`）的 `complete`/`rejected` batch 与其全部 child rows **整体 GC**（同一 TTL 事件，batch 行 + child 行 + 文件一起清，不逐 child——见幂等矩阵与「整批消费/整批 GC 模型」）；已消费 batch 的 child 随消息删除转 `recycled` 后按各自 TTL 释放，batch 行在**最后一个 child 被 GC 后**同步清理（R5 P2-1）。
  - DB 是真相源，文件与 DB 通过 `stored_path` 关联；启动时 DB/文件 reconciliation（DB 有引用但文件缺失 → 置 `integrity_status='missing_file'` + `integrity_error` 持久化（attached 保留消息关联，非 attached 由 GC 清理）；文件存在但无 DB 行 → **先查 `image_upload_batches`：若该 batch 仍 `pending`（rename 后 DB complete 前崩溃的中间态）→ 按「pending final-dir 验证」处理（齐全 → fenced commit 补 complete；不齐 → 清 final 目录保留 pending），不得直接当孤儿删除**；确认无对应 batch 行 → 孤儿回收）。
- **batch 提交协议（R5 P1-1 + R6 P1-1 + R7 P1-1/P1-2 修正：crash-consistent 可恢复协议 + fenced lease + filesystem fencing，替代 R4 "all-or-nothing 单次 DB commit"）**：`complete` 必须严格等价于"全部最终文件已就绪 + 全部 image rows 完整"。协议顺序：
  1. **pending reservation（带 fenced lease）**：服务端对**实际 multipart bytes** 计算 `request_fingerprint` + 校验 `expected_count`（以实际 multipart 数量为准），持久化 `pending` 行（`(conversation_id, client_request_id)` UNIQUE + fingerprint + expected_count + **随机 `lease_token`** + `lease_expires_at`）——reservation 即取得该 batch 的**唯一 lease**；
  2. **全量预检**（magic-byte/像素/大小/张数/文件名）后写 **token/attempt 隔离临时目录**（R7 P1-1：`<uploads>/.tmp/<batch_id>/<lease_token>/...`，目录以 `batch_id + lease_token` 双键隔离）——不同 lease 的 worker 写**各自**的 attempt 目录，stale worker 只能清理"自己 token"的产物，**不得触碰当前 owner 或他人 attempt 的文件**（杜绝 `.tmp/<batch_id>` 单目录下跨 token 共用导致误删/混写）；
  3. **同文件系统原子 rename** 整个 batch 目录到 final（`<uploads>/<batch_id>/`，rename 原子性在**同一文件系统**内成立；R7 P1-2：rename 到 final 后、DB complete 前的崩溃恢复见下方「pending final-dir 验证」）；
  4. **最终 SQLite transaction（fenced commit）**：校验 `expected_count`/children（slot 连续 `0..count-1`）/final paths 后插 image rows（`staged`）+ 条件 UPDATE 置 batch `complete` + `completed_at`——**必须带 `WHERE batch_id=? AND status='pending' AND lease_token=<caller>`**；**影响行数 0 = 已被 fencing（stale worker 超时后被他人 takeover 仍试图 commit）→ 整个 SQLite transaction 立即 ROLLBACK（R7 P1-1：已插入的 child rows 一并撤销，不留半批次），随后清理自己的 token attempt 目录，不得把非 owner 状态当 complete 提交**；
  5. **response 只认 `complete`**（batch 行 + row_count + slots + final files 全满足才返回 `{ images: [{ imageId }] }`）。
  同 key 命中 **pending 行**（R6 P1-1 fenced lease 三分支）：
  - **同进程 in-flight**（同一 key 请求已在处理中）：共享/等待既有 promise，不启动第二条文件管线；
  - **lease 有效但非 owner**（其他 worker 持 token）：**不得 resume**——返回结构化 `UPLOAD_IN_PROGRESS`（含 retryAfter），不启动第二条文件管线；客户端稍后重试，届时 lease 可能已过期；
  - **lease 过期**：CAS 条件 UPDATE 抢占（`UPDATE ... SET lease_token=<新随机>, lease_expires_at=<now+TTL> WHERE batch_id=? AND status='pending' AND lease_expires_at < now`）；影响行数 1 → 取得唯一 lease 成为 owner，reconcile 既有 temp/final 产物（能继续则继续原协议，否则清掉重跑全流程）；影响行数 0 → 已被他人抢占，回到非 owner 分支。
  **pending final-dir 验证（R7 P1-2：rename 后 / DB complete 前的崩溃恢复）**：若 crash 发生在步骤 3 与步骤 4 之间（final 目录已 rename 就位、DB 仍是 pending、无 child row），启动 reconciliation **不得**把它当孤儿删除——先验证 final 目录完整性（文件齐全 = `expected_count` 张 + slots 连续 + 全 magic-byte 校验通过）：**齐全 → 以当前持有 lease 的 owner 身份补执行步骤 4 的 fenced commit**（同一 transaction 插 child rows + 条件 UPDATE complete，`WHERE lease_token=<caller>`）；**不齐（缺文件/校验失败）→ 清掉 final 目录并保留 pending 行**（同 key 重试走 pending 分支，不得留孤儿文件）。测试补「rename 后 DB complete 前 crash → 重启 → 齐全补 complete / 不齐清理保 pending」。
  **失败分类与 rejected 执行路径（R7 P2-1）**：`rejected` 只由**确定性校验失败**进入——magic-byte/像素/大小/张数/文件名/expected_count 校验不通过（在步骤 2 之前判定），同一 transaction 置 `rejected` + `rejected_reason`（终态，TTL GC 清理）；**可重试失败**（存储 IO、rename、DB 事务、进程 crash）一律保持 `pending`（带 lease），不转 rejected。同 key 重试：`rejected` batch → 返回既有 `rejected_reason`（结构化，前端展示人话原因，需换 payload/新 key）；`pending` batch → 走上述 pending 分支。UI 侧：batch 任一文件校验失败 → 整批 rejected（原子），前端该 batch 全部卡片标 `rejected` 并展示原因（与 §Phase C 图片项状态机一致），不产生"部分卡片成功"的悬空态。
  任何一步失败：pending 行保留（带 lease_token/lease_expires_at），临时目录按 token 隔离回收（只清自己 attempt）；**绝不把非 complete 的 batch 当 canonical 返回**。补测试（R5 crash 点 + R6 concurrency + R7）：pending reservation 后、temp 写入中、目录 rename 后/DB complete 前（含 R7 final-dir 验证）、complete 后/response 前 + **concurrent duplicate（同 key 同时到达）、lease expiry takeover、stale worker late-complete（超时后仍 commit → 影响行数 0 → 事务回滚 + 清自己 attempt）、complete 后 canonical retry、不同 lease 写不同 attempt 目录互不干扰（P1-1）、校验失败进 rejected 且同 key 重试返回原因（P2-1）、pending final-dir 恢复（P1-2）**。
- **幂等矩阵（P1-2/P1-3 修正 + R4 补 batch identity，两阶段分别幂等）**：
  | 场景 | 行为 |
  |------|------|
  | **上传阶段**：同 `(conversation_id, client_request_id)` + **同 `request_fingerprint`** 重试（首传响应丢失 / network-unknown） | **canonical result**：返回既有 `complete` 批次的 `{ images: [{ imageId }] }`，不重复写行不重复存文件 |
  | **上传阶段**：同 `(conversation_id, client_request_id)` 但 **fingerprint 不同（payload 已变）** | **409 `UPLOAD_IDEMPOTENCY_CONFLICT`**（R4 P1-1），返回既有批次与差异说明；前端必须换新 key 重新上传 |
  | 上传 batch 为 `pending`（中途失败/崩溃） | **无 canonical 可返回**；同 key 重试：**同进程 in-flight → 等待既有 promise**；lease 有效但非 owner → 结构化 `UPLOAD_IN_PROGRESS` + retryAfter（不启动第二条文件管线）；lease 过期 → CAS 条件 UPDATE 抢占取新 `lease_token` 成为唯一 owner 后 reconcile/重跑全流程（**不得当空批次直接重跑 INSERT**，R5 P1-1 + R6 P1-1 fenced lease） |
  | **消息阶段**：同消息 `clientRequestId` + 同 imageIds 重试（消息落库后） | **canonical result**：返回既有消息，imageId 复用已 attached，不重复消费 |
  | 不同 `client_request_id` / 不同消息 key 引用已 attached 的 imageId | **明确拒绝**（400 `IMAGE_ALREADY_ATTACHED`），不静默复用 |
  | imageId 不存在 / 非本会话 / `integrity_status='missing_file'` | 400 结构化错误 |
  | `staged` 超过 TTL（24h） | **整批 GC（R7 P1-3）**：未消费的 `complete` batch（`consumed_at IS NULL`）与其全部 child rows + 文件在同一 TTL 事件整体清理；**不逐 child GC**（child 单独 GC 会破坏 batch canonical：batch complete 要求 child count = expected_count，逐 child 删会让 complete batch 指向缺失 child，且 batch 又因含 attached sibling 不能删——整批消费/整批 GC 消除该冲突） |
  | **消息删除（P1-3 选定一种）** | 其 `attached` 图片行（该 batch 全部 child，R7 P1-3 整批 attach）→ `recycled`（原子 UPDATE，`ttl_expires_at = now()`），GC 按 TTL 释放文件 + 行；batch 行在最后一个 child GC 后清理；不做"转 staged 复用"分支 |
  | **会话删除（R6 P1-2）** | **立即 purge**：同一 SQLite transaction 内先删该会话**全部 `image_uploads` 行**（`staged`/`attached`/`recycled` 全删，不转 recycled）→ 再删全部 `image_upload_batches` 行（`conversation_id` FK 已明确）→ 最后 `DELETE conversation`（CASCADE 删 messages 等；此时 `image_uploads` 行已删，`attached_message_id ON DELETE RESTRICT` 不再阻断）；DB commit 后 best-effort 删除对应 batch 目录；**文件删除失败不回滚已完成的 DB 删除**，由启动 reconciliation 清孤儿。测试：带 attached/staged/recycled 图的会话删除成功、无 FK 错误、registry/batch 无残留、目录删除失败后 reconciliation 收敛、现有 DELETE conversation 行为不回归 |
  | **attached 行文件缺失（R4 P1-5 + R5 P1-4）** | reconciliation/运行期读文件失败置 `integrity_status='missing_file'` + `integrity_error`，**保留 attached 状态与消息关联**；历史 UI 显示降级占位；任何 invocation 读该图必须结构化失败（`IMAGE_CONTENT_UNAVAILABLE`，R5 P1-4，见 AC-B2），不得剥图继续 |
- **attach 单事务（P1-3 定案 + R7 P1-3 整批消费）**：`message INSERT` 与所有 image 行条件 UPDATE（`staged`→`attached`，校验 `conversation_id` 归属、`status='staged'`、`attached_message_id IS NULL`、**影响行数 = imageIds 去重后数量，且必须等于该 batch 全部 `staged` child 数（整批）**）在**同一个 SQLite transaction** 内；任一行不满足则整体回滚，不产生半条消息或部分 attached。**R7 P1-3：消息引用的 imageIds 必须构成完整 batch 消费**——引用某 batch 的**任意子集** → 400 `IMAGE_PARTIAL_BATCH_ATTACH_REJECTED`（前端须整批引用，或对剩余 child 走该 batch 的整批消费语义；不允许部分 attach 造成"batch complete 而 child 部分 missing"的悬空 canonical）。
- 图片持久化随消息原子性：上传文件与消息落库通过幂等流程关联，刷新/历史回放/继续会话后图片仍存在；孤儿上传文件不阻塞消息写入。
- 失败路径明确：上传校验失败、存储失败、imageId 校验失败（不存在/非本会话/已 attached 且非同 key）时返回结构化错误，前端展示人话原因，不静默丢图。

### Phase B: Capability registry 与多模态路由判定

- **能力是 model-level，且以 PI runtime canonical `model.input` 为单一真相源（P1-1 R3 定案）**：capability 位钉死为 **`providers[id].models[i].input?: Array<'text' | 'image'>`**——与 PI runtime 0.80.10 一致（`@earendil-works/pi-ai` `transform-messages.js` 用 `model.input.includes('image')` 判定，不包含时把 image 降级成 `"(image omitted: model does not support images)"`；CAFF 的 `pi-model-config-validator.mjs` 已把 models.json 交给 pinned PI `ModelRuntime.create` 校验，`input` 字段可直接被 runtime 消费）。**不引入并行布尔位** `supportsImageInput`：自定义 `supportsImageInput: true` 会被 Pi 模型合成忽略，造成 CAFF preflight 放行、PI 层静默剥图，直接违反 AC-B3。运行时可读视图 = `input.includes('image')`。
  - **catalog import 投影**：`modalities.input` 仅在显式 import/save 模型时投影为 `input`（`modalities.input.includes('image')` → `input: ['text','image']`），运行时判定以 models.json 显式值为准。
  - **未知/缺失一律 fail closed**：`input` 缺失或未含 `'image'` → 判定为不支持图片（CAFF 校验端默认 `input: ['text']`，与 PI 一致）。
- **capability 可执行契约（P1-1 R3）**：`input` 必须可被 operator 读写——provider-editor 模型级新增 capability 控件（**checkbox 编辑 `'image'` membership**：勾选 → `input` 含 `'image'`；取消 → 移除），normalize 时接受 `Array<'text'|'image'>`（非规范值拒绝：非数组、含非 text/image 元素）；API 投影把 `input` 纳入 provider 回读 payload；手工编辑的模型默认 `input: ['text']`，operator 可显式勾选图片能力。**parity 回归测试**：CAFF capability 判定与 PI `model.input.includes('image')` 必须一致（含静默降级回归测试——`input` 不含 image 的模型，images 不得被送进 `session.prompt`）。
- **阻断语义定案（P1-1 R2 修正位置 + R3 扩展）**：真实链路是 controller **同步**调用 `submitConversationMessage` → `store.createMessage`（同步落库）→ 异步 drain（`turn-orchestrator.ts:1420-1445`）。因此 capability preflight 必须发生在 **`store.createMessage` 之前**（controller 同步段内），而不是 routing 异步段——否则 HTTP 已 200 且消息已落库。具体规则：
  - **initial targets 的 all 规则**：preflight 解析初始 target-set（与 `resolveInitialSpeakerQueue` 同源：@mention 命中的所有 agents，无 mention 则第一个 agent，`routing-executor.ts:95-102`），**所有 initial target 的模型必须都支持图片输入**（任一不支持 → 422 `MODEL_NO_IMAGE_INPUT`，消息不落库、不进入 runtime、图片保持 staged 可复用）。首版采用 all 规则（图片进共享 user 消息，所有 initial agents 都会收到；不能为某个 agent 剥图）。多 agent mixed-capability 场景下，operator 可移除图片或换用全 vision 的 target-set 重发。
  - **handoff/side-dispatch 的 per-invocation 阻断（P1-4 R3 扩展 + R4 钉死失败持久化）**：后续 handoff 或 side-dispatch 到不支持图片的模型时，该 invocation 输出结构化 block `MODEL_NO_IMAGE_INPUT`（附人话 reason），**不剥图继续、不静默丢弃**——图片仍在该用户消息里，只是该 invocation 明确声明不可读图。**执行路径（R4 P1-4 钉死，沿 `agent-executor.ts:1302-1313,1947-1980` 的 assistant placeholder/failed 契约）**：invocation 仍创建 assistant placeholder → capability 判定后**直接写 `status='failed'`** + `MODEL_NO_IMAGE_INPUT`/reason + `metadata_json.invocationBlocks` → 计入 `failedReplies` → **断言 `startRun` 未被调用**；queue 仅继续其他 agent。**持久化/UI carrier**：block 写入该 invocation 的 assistant 消息 `metadata_json.invocationBlocks`，UI 以 trace pill / inline note 展示（文案为「本次调用已阻断：模型不支持读取历史图片」，**不得写"已跳过图片上下文"**）；**queue 继续**：该 invocation 失败不终止 turn，其余 agent 正常执行；turn failure 按现有计数逻辑计入（`failedReplies`）。
  - **多模态 prompt 单一投影（R4 P1-3 定案，替代原 `collectPromptImages`）**：每个 invocation 组装 prompt 时，由**一个投影函数**同时产出文本与图片：**先选定与文本完全相同的 message window**（与 `agent-prompt.ts:205` 的 `.slice(-MAX_HISTORY_MESSAGES)` 同一窗口），**在文本中插入确定性 image marker**（如 `[image:<messageOrdinal>:<imageOrdinal>]`，随 `formatHistory` 同一份历史展开），**images 按 marker 出现顺序排列**。不单独对全部 `promptMessages` 收集图片——避免文本 prompt 中不存在的更老图片被孤立传入（现 `prompt-visibility.ts:20-41` 不裁剪，与 `agent-prompt.ts:205` 的 `.slice(-24)` 是两条不同窗口，R4 实锤为 P1-3 根因）。
  - **per-invocation 图片预算（R4 P1-3 + R5 P1-4 修订：单一 fail-closed 契约）**：定义 `MAX_IMAGES_PER_INVOCATION` 与 `MAX_IMAGE_PROMPT_BYTES`（base64 总量上限，依据 provider/IPC 边界自决，实现侧定具体数值）。**超限一律显式 fail-closed**：结构化 block `IMAGE_PROMPT_BUDGET_EXCEEDED`（附人话原因），**不允许"显式截断"分支**（R5 P1-4 删除"或显式截断"——截断 = 带不完整图片继续调用，与 fail-closed 语义矛盾；AC-B2/Risk 已钉死 fail-closed，spec 与其保持一致）——不得静默丢图。可见图片集合（历史带图消息 + 当前 imageIds）以 `input.includes('image')` 对该 invocation 逐次判定——不仅看当前请求是否带图，后续纯文本 turn 但可见历史含图时，非 vision target 也要 per-invocation block，不允许历史图被静默剥掉（见 AC-B3 扩展）。补「第 25 条含图消息不被孤立传入」「多条消息多图锚点顺序」「预算超限 fail-closed」测试。
  - 422 为**预写入**（不入队、无 blocked 状态机、无半条消息）；时间线不出现 blocked 消息。
- provider adapter（PI SDK host 侧）：把结构化 image block 翻译成 PI 可消费的输入——具体形态已在 Design Gate 后经 spike 验证（见 Open Questions / Decision Packet D1）。

### Phase C: 聊天 UI 输入与展示

- composer 增加图片选择入口：文件选择 + 预览 + 移除，随文本一起发送（**image-only 允许**：strip 有图时无文本也可发送）；不支持的图片类型/超限在 UI 层即时提示。
- **图片项状态机（R4 P2-1 定案：`pending_validation → ready | rejected`）**：选择/粘贴进入 strip 时每张图为 `pending_validation`（本地 objectURL 可预览，但**未拿到服务端 imageId 前发送按钮禁用**）；服务端上传成功 → `ready`（持有 imageId，可随消息发送）；失败 → `rejected`（标记错误 + 移除，提示原因）。文件必须有明确状态，不允许"有歧义既不放行也不拦截"的悬空态。
- 消息时间线渲染 image block：历史消息回放、SSE 增量、refresh 后均显示图片；展示失败有降级提示而非空白；**attached 行 `integrity_status='missing_file'` 时历史 UI 显示降级占位（不剥图、不空白）**（R4 P1-5）。

## User Journey

### Primary Journey: 发送一张图片并让多模态模型理解

- **Scope unit**: 一次带图片的聊天消息发送。
- **Actor**: operator。
- **Entry**: 在当前聊天室的 composer 中点击图片入口并选择一张本地图片。
- **Flow**:
  1. 图片在输入区即时预览，operator 可移除后重新选择，并输入随图文字。
  2. 发送后，带图消息立即以 optimistic 形态出现在时间线（含图片缩略图）。
  3. 目标 Agent 的模型支持图片输入时，图片随消息进入模型上下文，Agent 可描述/分析图片内容。
  4. 目标模型不支持图片输入时，服务端返回 422 `MODEL_NO_IMAGE_INPUT`，消息不落库、图片保持 staged 可复用，operator 看到人话原因可移除图片或换支持图片的模型重发，绝不静默丢图。
  5. 刷新页面或回到该会话继续聊天，图片仍在原消息位置完整显示。
- **Success evidence**: 上传/存储/渲染/能力判定/runtime 传输各层测试 + desktop/375px 浏览器证据。

### Supporting Journey: 多模态能力一目了然

- **Scope unit**: provider 配置页面。
- **Actor**: operator。
- **Flow**: operator 在 provider 配置中能看到并可编辑所选模型是否支持图片输入（**编辑 PI canonical `input` 数组的 `'image'` membership**，provider-editor 模型级 checkbox；catalog 仅 import 时投影默认值），不支持的模型不被展示为可读图能力。
- **Evidence**: provider-editor 截图（含模型级 capability 控件）+ capability 判定测试 + **PI parity 回归测试**。

## 需求点 Checklist

| ID | 需求点（operator 转述/愿景） | AC | 验证方式 |
|----|---------------------------|----|---------|
| R1 | 聊天输入区能选图、预览、移除并随文本发送 | AC-C1 | UI 测试 + browser 证据 |
| R2 | 图片随消息持久化，刷新/回放/续会话仍存在 | AC-A2, AC-A3 | storage/restart 测试 + 截图 |
| R3 | 路由层按 capability 判定目标模型是否支持图片 | AC-B1, AC-B2 | capability/路由测试 |
| R4 | 不支持的模型必须明确阻断，不得静默丢图 | AC-B3 | 阻断路径测试 |
| R5 | 上传安全受控（MIME/大小/张数/路径穿越/SSRF） | AC-A1 | 安全校验测试 |

### 覆盖检查
- [x] 每个需求点都能映射到至少一条 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（Design Gate）

## Acceptance Criteria

### Phase A: Content-block 契约 + 上传存储

- [ ] AC-A1: 图片上传端点拒绝白名单外 MIME（magic-byte 校验，不信任浏览器 MIME）、超限文件（大小/像素）、超张数、路径穿越文件名；`/uploads/` 只服务受控目录，无符号路径/远程抓取（SSRF 面为零——客户端只提交 opaque imageId，服务端投影 URL）。**P1-5 安全策略定案**：上传接受 = **结构头解析成功**（magic-byte 签名 + 尺寸头 + 像素上限 + animated GIF 探测），**不承诺完整图片可解码**（有限 dependency-free header parser 无法证明解码性；删"解码失败拒绝"承诺）；**前端预检只是 UX，服务端始终权威，前端预检不作为安全边界**。**精确上限**：`MAX_IMAGE_BYTES = 10 * 1024 * 1024 = 10_485_760`（P2-1 精确字节值）、`MAX_IMAGES_PER_UPLOAD=5`、`MAX_IMAGE_WIDTH=4096`、`MAX_IMAGE_HEIGHT=4096`、`MAX_IMAGE_PIXELS=16_000_000`；**GIF 策略**：animated GIF 拒绝（`ANIMATED_GIF_REJECTED`），static GIF 按首帧尺寸校验；**attach-time 再校验**：消息 attach 时对 `imageIds` 去重并校验 distinct 数量 ≤ `MAX_IMAGES_PER_MESSAGE=5`（多 upload 请求无法绕过）。**常量真相源**：服务端 `lib/image-constants.ts` 为单一真相源，经 `GET /api/image-upload/config` 以 JSON 暴露给前端（前端启动时 fetch，不 import TS——classic defer scripts 无 bundler）；**config 拉取失败 = fail closed**：禁用附件入口/展示原因，禁止硬编码 fallback（P2-1）。**依赖策略**：magic-byte/尺寸解析采用 dependency-free 有限解析器（png/jpeg/webp/gif 头解析），若需新增 direct dependency 先回指挥中心走依赖授权。验证：校验矩阵测试 + 静态路由测试 + imageId 投影测试 + config parity 测试 + config fail-closed 测试。
- [x] AC-A2: 带图消息以 `contentBlocks`（text 由 content 派生 + image 含 imageId/url）持久化，`content` 是唯一文本真相源且兼容不受破坏；客户端提交 text block/URL 返回 400；FTS 搜索、摘要 digest、历史消息解析不回归；**image-only 消息**（空 content + imageIds）可持久化且不生成空 text block。验证：message repository + 搜索/摘要测试 + 冲突拒绝测试 + image-only 测试。
- [ ] AC-A3: 刷新页面与进程重启后，图片引用仍可从静态路由访问且消息可完整回放。验证：restart fixture + 浏览器回放证据。
- [ ] AC-A4: 上传/存储/引用失败时返回结构化错误并展示人话原因，消息写入与图片上传通过幂等流程关联，不产生半个消息或孤儿阻断；**两阶段幂等矩阵（P1-2 R3 + R4 batch identity + R5 服务端 fingerprint + R6 fenced lease + R7 filesystem fencing/P1-3 整批消费）**：上传阶段同 `(conversation_id, client_request_id)` + 同 `request_fingerprint` 重试（响应丢失/network-unknown）返回 canonical complete batch；**同 key 异 payload → 409 `UPLOAD_IDEMPOTENCY_CONFLICT`**；`request_fingerprint` **由服务端对实际校验后的 multipart bytes 计算**（客户端 digest 仅 hint，服务端重算/核对，R5 P1-1）；batch `pending`（中途失败/崩溃）无 canonical、同 key 重试：**同进程 in-flight → 等待既有 promise、lease 有效但非 owner → `UPLOAD_IN_PROGRESS` + retryAfter、lease 过期 → CAS 条件 UPDATE 抢占取新 `lease_token` 成为唯一 owner 后 reconcile/重跑**（**不得当空批次重跑 INSERT**，R5 P1-1 + R6 P1-1 fenced lease）；**R7 P1-1 filesystem fencing**：temp 目录以 `batch_id + lease_token` 双键隔离（`.tmp/<batch_id>/<lease_token>/`），stale worker 只清自己 attempt；fenced commit 影响行数 0 → 整个 transaction ROLLBACK（已插 child rows 一并撤销）+ 清自己 attempt；**R7 P2-1 失败分类**：确定性校验失败（magic-byte/像素/大小/张数/文件名/expected_count）→ `rejected` + reason 终态，同 key 重试返回既有 reason（换 payload 须新 key）；存储/DB/crash → 保持 `pending` 走 pending 分支；消息阶段同消息 `clientRequestId` 重试返回 canonical result、不同 key 引用已 attached imageId 拒绝；`client_request_id` 在**首次上传前**由前端生成并跨重试复用；**attach 单事务（R7 P1-3 整批消费）**：message INSERT + 所有 image 行条件 UPDATE（staged→attached，含 ownership/status/row-count 校验，**影响行数 = 该 batch 全部 staged child 数，引用任意子集 → 400 `IMAGE_PARTIAL_BATCH_ATTACH_REJECTED`**）同一 SQLite transaction，任一行失败整体回滚；**batch 可恢复提交协议（R5 P1-1 + R6 P1-1 + R7 P1-2）**：pending reservation（带随机 `lease_token`）→ 全量预检 → token 隔离 temp 目录 → 同文件系统原子 rename batch 目录到 final → 最终 SQLite transaction（校验 expected_count/children/final paths 后插 image rows + **条件 UPDATE 置 complete，`WHERE status='pending' AND lease_token=<caller>`**）→ response 只认 complete（batch + row_count + slots + files 全满足）；**rename 后/DB complete 前 crash → 启动 reconciliation 验证 final 目录（齐全 → fenced commit 补 complete；不齐 → 清 final 目录保留 pending）**；**R7 P1-3 整批 GC**：未消费 complete batch（`consumed_at IS NULL`）TTL 到期 → batch 行 + 全部 child 行 + 文件整体清理，**不逐 child GC**；已消费 batch 的 child 随消息删除转 recycled 后按各自 TTL 释放，batch 行在最后一个 child GC 后清理。**会话删除（R6 P1-2）**：同一 transaction 内先 purge 该会话全部 image rows + batch rows 再删 conversation（不依赖 CASCADE 碰运气），DB commit 后 best-effort 删 batch dirs、失败由 reconciliation 清孤儿。验证：错误路径测试 + 两阶段幂等矩阵测试（含丢响应重试 + 同 key 异 payload 冲突 + crash 点测试：pending reservation 后/temp 写入中/rename 后 DB complete 前（含 R7 final-dir 验证）/complete 后 response 前 + **R6 concurrency：concurrent duplicate / lease expiry takeover / stale worker late-complete / complete 后 canonical retry** + **R7：不同 lease 写不同 attempt 目录互不干扰、校验失败进 rejected 且同 key 重试返回原因、整批消费（部分 attach → 400）、未消费 batch 整批 GC、消费后 child 逐 TTL + batch 行最后清理**）+ attach 事务原子性测试 + registry reconciliation 测试 + batch 可恢复提交协议测试 + **会话删除测试（带 attached/staged/recycled 图删除成功、无 FK 错误、registry/batch 无残留、目录删除失败后 reconciliation 收敛、DELETE conversation 不回归，R6 P1-2）**。

### Phase B: Capability registry + 路由

- [x] AC-B1: capability 位为 model-level 且**以 PI runtime canonical `providers[id].models[i].input: Array<'text'|'image'>` 为单一真相源**（P1-1 R3；弃 `supportsImageInput` 布尔——PI 层不认识它，会造成 preflight 放行 + PI 静默剥图）；catalog `modalities.input` 仅在显式 import/save 时投影为 `input`，models.json 显式值优先，未知模型 fail closed 为不支持图片；`input` 可经 provider-editor 模型级控件读写（checkbox 编辑 `'image'` membership；normalize 只接受合法数组；回读保留）。**parity 回归测试**：CAFF 判定与 PI `model.input.includes('image')` 一致 + 静默降级回归测试（`input` 不含 image 的模型，images 不得进 `session.prompt`）。验证：model-level 判定矩阵 + 投影/优先级测试 + capability 读写测试 + parity/静默降级测试。
- [x] AC-B2: **同步 preflight 在 `store.createMessage` 之前**（controller 同步段）识别 imageIds；**initial targets 任一模型不支持图片 → 预写入 422**（`MODEL_NO_IMAGE_INPUT`），消息不落库、不进入 runtime、图片保持 staged 可复用；**多模态 prompt 单一投影（R4 P1-3）**：每次 invocation 由单一投影函数产出 `{ text, images }`——文本与图片**同一 message window**（与 `agent-prompt.ts:205` `.slice(-MAX_HISTORY_MESSAGES)` 对齐），文本中插入确定性 image marker、images 按 marker 顺序排列；per-invocation 图片数量/字节预算超限一律 fail-closed（结构化 block `IMAGE_PROMPT_BUDGET_EXCEEDED`，**无显式截断分支**，R5 P1-4）；后续纯文本 turn 可见历史含图时同样判定，非 vision target 输出 per-invocation 结构化 block（**R4 P1-4 钉死：assistant placeholder 直接写 `status='failed'` + block code/reason + `metadata_json.invocationBlocks` + 计入 failedReplies + 断言 startRun 未调用**；queue 继续）；**attached 行 `integrity_status='missing_file'` 或运行期读文件失败 → invocation 结构化 block `IMAGE_CONTENT_UNAVAILABLE`**（R5 P1-4：复用同一 assistant `status='failed'` + invocationBlocks + failedReplies + startRun 未调用 + queue 继续失败路径，不剥图）。验证：路由阻断测试 + 消息不入队断言 + staged 复用断言 + preflight 位置断言（createMessage 前）+ handoff block 测试 + **"图片消息后刷新/重启再发纯文本"测试 + 多图顺序测试 + "第 25 条含图消息不被孤立传入"测试 + 预算超限 fail-closed 测试（`IMAGE_PROMPT_BUDGET_EXCEEDED`）+ missing-file invocation 测试（`IMAGE_CONTENT_UNAVAILABLE`，restart reconciliation 后纯文本 invocation）+ startRun 未调用断言**。
- [x] AC-B3: 任何路径都不得静默丢图：不支持的模型不剥图继续，失败必带明确原因；**PI runtime 的静默降级被 preflight + per-invocation 判定双保险挡住**（`input` 不含 image 的模型 images 永不进 `session.prompt`）。验证：全路径断言测试（grep 无静默过滤）+ parity 静默降级回归测试。
- [x] AC-B4 (P2-3): F003 notify/request 两入口收到带图消息 → 结构化 reject `IMAGE_DELIVERY_NOT_SUPPORTED` + 人话原因，消息与图片不剥离不降级。验证：notify/request 两路径 reject 测试。

### Phase C: UI 输入与展示
- [x] AC-C1: composer 支持选图 + 预览 + 移除 + 随文本发送；非法图片在 UI 层即时提示；**图片项状态机 `pending_validation → ready | rejected`**（未拿 imageId 前发送禁用，失败标记错误+移除）；上传失败区分 retryable（network unknown / HTTP 202 `UPLOAD_IN_PROGRESS` / 408/429/5xx，同 key 重试）与 deterministic reject（validation/conflict/响应数量不匹配，须变更 strip 换 key）；**发送条件钉死（R5 P1-3）**：`hasPayload = content.trim().length > 0 || strip.length > 0`；`canSend = hasPayload && strip.every(item => item.status === 'ready')`——存在 `pending_validation`/`rejected` 项时禁用发送，strip 为空时纯文本照常。图片消息 POST 由 `(conversation, caption, ordered imageIds)` 签名持有消息级 `clientRequestId`，未知结果重试复用；发送期间冻结 caption/附件，失败恢复原 caption，SSE/history 命中同 key 则以持久化消息为真相并清 strip。验证：UI/集成测试 + desktop/mobile 证据。
- [x] AC-C2: 消息时间线渲染图片，历史回放/SSE 增量/刷新后一致；展示失败有降级提示而非空白（**attached `integrity_status='missing_file'` 显示降级占位**）；瞬时 load error 提供显式重试与新标签打开，不依赖 timeline 重渲染恢复。验证：browser 证据 + 渲染测试。

## Dependencies

- **Evolved from**: F002（PI SDK host 运行时方言边界，image 输入投影依赖其 prompt 契约）。
- **Related**: F004（capability registry 从 catalog modalities 投影）；F003（跨聊天室 delivery 复用 content-block 契约时需同步支持图片）。
- **Blocked by**: None for implementation. Design Gate decisions D1-D3 and UI OQ4/5 are resolved; Phase C is awaiting code review and merge.

## Architecture

```text
composer (file input + preview + remove; image-only allowed when strip non-empty; clientRequestId for upload generated BEFORE first upload; per-image pending_validation -> ready | rejected)
  -> GET /api/image-upload/config (constants: mime/size/pixel/count whitelist, JSON, single truth lib/image-constants.ts; fetch failure -> fail closed, disable attachment entry)
  -> POST /api/conversations/:id/images (multipart batch, magic-byte MIME/size/pixel/count/filename guard; dependency-free header parser; client_request_id; expected_count = actual multipart count)
     -> recoverable commit protocol (R5 + R6 fenced lease + R7): server computes request_fingerprint from actual validated bytes -> persist pending reservation (UNIQUE(conversation_id, client_request_id), random lease_token + lease_expires_at)
        -> full prevalidate -> TOKEN-isolated temp dir (.tmp/<batch_id>/<lease_token>/, P1-1) -> same-fs atomic rename batch dir to final -> FINAL SQLite transaction (validate expected_count/children/final paths -> insert image rows staged + batch complete + completed_at, WHERE status='pending' AND lease_token=<caller>; 0 affected -> whole transaction ROLLBACK + clean own attempt) -> response { images: [{ imageId }] } (ordered) ONLY when complete
        -> pending hit (R7 fenced lease 3-way): in-flight -> await promise; lease valid non-owner -> UPLOAD_IN_PROGRESS + retryAfter (NO resume); lease expired -> CAS takeover new token then reconcile/rerun. Rename-then-crash -> startup validates final dir (complete via fenced commit OR clean + keep pending). Never return non-complete batch as canonical
        -> deterministic validation failure -> rejected + reason terminal (retry returns reason); storage/db/crash -> pending kept
        -> same key + same fingerprint -> canonical complete batch; same key + diff fingerprint -> 409 UPLOAD_IDEMPOTENCY_CONFLICT
        -> whole-batch consume: message must reference ALL staged children of a batch (partial -> 400 IMAGE_PARTIAL_BATCH_ATTACH_REJECTED); unconsumed complete batch -> whole-batch GC at TTL; consumed batch child GC per-TTL after message delete, batch row cleaned after last child
  -> controlled upload store (/uploads/, opaque server-generated filename) + image_upload_batches (UNIQUE(conversation_id, client_request_id), status pending|complete|rejected, CHECK expected_count 1..MAX, complete iff completed_at NOT NULL, rejected_reason) + image_uploads registry (staged, UNIQUE(batch_id, slot), integrity_status ok|missing_file, integrity_error, batch_id FK, attached_message_id FK ON DELETE RESTRICT)
  -> message { content: text (canonical, may be ''), imageIds: opaque[] }  // client never submits url/text-block
  -> SYNC capability preflight (BEFORE store.createMessage): resolve initial targets (mention-set or first agent);
     imageIds present + any target model.input lacks 'image' -> 422 MODEL_NO_IMAGE_INPUT (no persistence, images stay staged)
  -> store.createMessage (validate imageId ownership/state + distinct-count<=5 -> SINGLE transaction: message INSERT + conditional image rows staged->attached -> project url
     -> metadata.contentBlocks [{type:text(derived, omitted when content empty)}, {type:image,imageId,url}])
  -> async drain -> routing (per-invocation multimodal projection: SAME window as text .slice(-MAX_HISTORY_MESSAGES) -> { text, images } with deterministic markers; budget MAX_IMAGES_PER_INVOCATION/MAX_IMAGE_PROMPT_BYTES; handoff/side-dispatch to non-vision model
     -> assistant placeholder status='failed' + per-invocation MODEL_NO_IMAGE_INPUT / IMAGE_PROMPT_BUDGET_EXCEEDED / IMAGE_CONTENT_UNAVAILABLE block persisted to metadata_json.invocationBlocks + UI carrier, no stripping, startRun never called, queue continues)
  -> agent-executor prompt projection (images) -> pi-sdk-host session.prompt(prompt, { images }) -> model (PI runtime gate: model.input.includes('image'); images never passed when input lacks image)
```

Architecture cell: `server/domain/conversation (messages) + server/domain/models (capability) + server/http (upload static) + public/chat (composer/timeline)`

Map delta: update required

Why: F004 的 models cell 只覆盖 provider 配置；本 Feature 首次把"能力判定"写进 models domain 契约，并在 conversation/messages 引入 content-block 与受控上传——需要更新 `server/domain/models` 与消息存储的归属边界说明，不新增并行 Store/Router。

## Eval / Tracking Contract

- **Primary users + activation**: 聊天 operator；activation 是首次选择图片并发送，或配置 provider 时查看图片能力。
- **Friction metric**: 带图消息中被阻断（不支持模型）或展示失败的占比；上传被拒次数，按原因聚类。
- **Regression fixtures**: content-block 持久化 fixture；restart 图片可达 fixture；capability 判定矩阵 fixture；阻断（不剥图）fixture；UI 选图/预览/移除 fixture。
- **Sunset signal**: 当 catalog/runtime 两侧 capability 判定冗余（所有目标模型统一支持图片）时移除 registry 分支；替换方案必须保留不剥图保证与上传安全。

## Risk

| 风险 | 缓解 |
|------|------|
| 静默丢图或剥图继续 | 全路径断言：阻断必带原因，无静默过滤 |
| content-block 破坏历史消息/FTS/摘要 | content 保持兼容，contentBlocks 只做增量扩展 |
| 上传面开放攻击（路径穿越/SSRF/炸弹） | 受控目录、opaque imageId 投影（客户端不提交 URL）、magic-byte MIME、大小/像素/张数限制、无符号解析、无远程抓取 |
| PI 不支持结构化 image 输入 | Design Gate spike 已定案：SDK 0.80.10 原生支持 `images` 参数（见 OQ1）；不剥图 fail closed |
| capability 误判（CAFF 声明与 PI runtime 不符） | 单一真相源 `model.input`（与 PI 0.80.10 一致）+ catalog 仅 import 投影默认 + parity 回归测试（CAFF 判定 == `model.input.includes('image')`），未知 fail closed |
| preflight 放错层（落库后才阻断） | capability preflight 在 `store.createMessage` 之前的同步段（AC-B2 位置断言测试） |
| PI 层静默降级剥图（`input` 不含 image 仍传图） | preflight + per-invocation 判定双保险：`input` 不含 image 的模型 images 永不进 `session.prompt`（AC-B3 parity 静默降级回归测试） |
| prompt 历史图片被静默剥掉（later-invocation） | 多模态 prompt **单一投影**（文本与图片同一 message window）+ 确定性 marker + per-invocation block 持久化 carrier（AC-B2）；R4 P1-3 钉死两窗口同源 |
| 图片窗口 ≠ 文本窗口（更老图片被孤立传入） | 单一投影函数先选 window 再产出 `{text, images}`，marker 嵌入文本；补「第 25 条含图消息不被孤立传入」测试（R4 P1-3） |
| 图片 prompt 预算无界（base64/IPC 超限） | `MAX_IMAGES_PER_INVOCATION` + `MAX_IMAGE_PROMPT_BYTES` 预算，超限一律 fail-closed `IMAGE_PROMPT_BUDGET_EXCEEDED`（无显式截断分支，R4 P1-3 + R5 P1-4） |
| attached 文件缺失无法表达（读文件必失败） | `integrity_status='missing_file'` + `integrity_error` 持久化，保留 attached 与消息关联；历史 UI 降级占位、invocation 结构化失败 `IMAGE_CONTENT_UNAVAILABLE` 不剥图（R4 P1-5 + R5 P1-4） |
| image_uploads registry 与文件漂移 | DB 为真相源，启动 reconciliation + integrity_status 标记 + 孤儿回收；非 attached 缺文件由 GC 清理（AC-A4 reconciliation 测试；R5 P1-2 弃 broken 双真相源） |
| 上传幂等键 canonical 到错误图片（payload 已变） | `request_fingerprint`（服务端对实际 bytes 计算，count + ordered file hashes）+ 同 key 异 payload → 409 `UPLOAD_IDEMPOTENCY_CONFLICT`（R4 P1-1 + R5 P1-1） |
| batch 半批次 / crash 无法区分完整性 | `image_upload_batches` completion truth（complete ⟺ completed_at + child count = expected_count）+ **可恢复提交协议**（pending reservation → token 隔离 temp → 原子 rename → 最终 DB complete → response 只认 complete）+ crash 点测试 + **pending final-dir 验证**（rename 后 DB complete 前 crash：齐全 → fenced commit 补 complete，不齐 → 清 final 保 pending）（R4 P1-2 + R5 P1-1 + R7 P1-2） |
| 并发同 key duplicate 同时 finalization / stale worker late-complete | **fenced lease**：batch 随机 `lease_token` + CAS 条件 UPDATE 取唯一所有权；非 owner 不得 resume（`UPLOAD_IN_PROGRESS` + retryAfter / in-flight promise）；最终 complete 带 `WHERE lease_token=<caller>`，stale worker 影响行数 0 → **整事务 ROLLBACK + 清自己 attempt**（R6 P1-1 + R7 P1-1 + concurrency 测试） |
| 跨 lease 临时文件误删/混写（`.tmp/<batch_id>` 单目录共用） | **token/attempt 隔离 temp 目录**（`.tmp/<batch_id>/<lease_token>/`），stale worker 只清自己 token 的产物；不同 lease 写不同 attempt 目录（R7 P1-1 + 隔离测试） |
| batch canonical 与 child TTL 冲突（部分 attach + 逐 child GC → complete batch 指向缺失 child） | **整批消费/整批 GC 模型**：attach 必须消费 batch 全部 child（部分 → 400 `IMAGE_PARTIAL_BATCH_ATTACH_REJECTED`）；未消费 complete batch 整批 GC（batch + child + 文件同事件）；已消费 batch 的 child 随消息删除转 recycled 后逐 TTL 释放，batch 行最后清理（R7 P1-3 + 整批消费/GC 测试） |
| rejected 无执行路径（校验失败与可重试失败混为一谈） | **失败分类**：确定性校验失败 → `rejected` + reason 终态（同 key 重试返回原因，换 payload 须新 key）；存储/DB/crash → 保持 `pending` 走 fenced lease 恢复（R7 P2-1 + 失败分类测试） |
| 会话删除被 `attached_message_id ON DELETE RESTRICT` 阻断 | **显式会话删除 purge**：同一 transaction 内先删该会话全部 image rows + batch rows 再删 conversation（`conversation_id` FK 明确）；DB commit 后 best-effort 删 batch dirs、失败由 reconciliation 清孤儿（R6 P1-2 + 回归测试） |
| 多 Agent mixed-capability 会话 | initial targets all 规则（任一不支持 → 422）+ handoff/side-dispatch per-invocation block，不剥图 |

## Open Questions

1. **PI SDK host 如何接收 image 输入**：`session.prompt(prompt)` 是字符串。图片应走 prompt 内路径 hint（模型有工具可读 uploads 目录）、SDK media 参数（若 0.80.10 暴露）、还是消息 content-block 直传？需 spike 验证——决定 adapter 实现形态。**✅ 已定案（D1 spike，2026-08-09 @opus）**：`@earendil-works/pi-coding-agent@0.80.10` 的 `PromptOptions` 声明 `images?: ImageContent[]`（`dist/core/agent-session.d.ts:130-141`），`ImageContent = { type: 'image', data: base64, mimeType }`（`pi-ai/dist/types.d.ts:239-243`）；`session.prompt(prompt, { images })` 直传结构化 image，一等公民。A 路径 hint 降级为 Non-goal。实现透传路径见 Decision Packet D1。
2. **Capability 落库形态**：**✅ 已定案（Design Gate Review R2 + R3，2026-08-09 @opus）**——能力位是 **model-level**，**以 PI runtime canonical `providers[id].models[i].input: Array<'text'|'image'>` 为单一真相源**（P1-1 R3：弃 `supportsImageInput` 布尔，避免与 PI `model.input` 双真相源导致静默剥图），并定义可执行读写契约（provider-editor 模型级 checkbox 编辑 `'image'` membership、normalize/回读保留、catalog import 仅投影默认、未知 fail closed）。**parity 回归测试**保证 CAFF 判定与 PI `model.input.includes('image')` 一致。技术决策，不需要 operator 拍板（D2 收敛）。
3. **上传与发送时序**：**✅ 已定案（Design Gate Review R2 + R3 + R4 + R5 + R6 + R7，2026-08-09 @opus）**——两阶段（先 upload 拿 opaque imageId → 消息引用 imageId，服务端投影 URL），上传按 **batch 契约**返回 `{ images: [{ imageId }] }`（有序，P1-2）。**图片状态以 `image_upload_batches` + `image_uploads` registry 表为持久化真相源**（P1-2/P1-3 + R4 + R5 + R6 + R7）：batch 唯一 `UNIQUE(conversation_id, client_request_id)` + `conversation_id` FK（R6 P1-2）+ `request_fingerprint`（**服务端对实际 bytes 计算**，count + ordered file hashes，同 key 异 payload → 409，R5 P1-1）+ `status` completion truth（complete ⟺ completed_at + child count = expected_count）+ **可恢复提交协议 + fenced lease + filesystem fencing**（pending reservation 带随机 `lease_token` → token 隔离 temp（`.tmp/<batch_id>/<lease_token>/`，R7 P1-1）→ 原子 rename → 最终 DB complete 带 `WHERE lease_token=<caller>`（影响 0 行 → 整事务回滚）→ response 只认 complete；非 owner 不得 resume、过期 CAS takeover，rename 后 crash → pending final-dir 验证，R5 P1-1 + R6 P1-1 + R7 P1-1/P1-2）；**整批消费/整批 GC**（R7 P1-3：attach 消费 batch 全部 child，部分 → 400；未消费 batch 整批 GC；已消费 child 随消息删除逐 TTL 释放）；**失败分类**（R7 P2-1：确定性校验失败 → rejected 终态，存储/crash → pending 保持）；图级状态机 `staged → attached → recycled` + `integrity_status`（missing_file，R4 P1-5），唯一 `UNIQUE(batch_id, slot)`（R5 P1-2 修正），`attached_message_id` FK `ON DELETE RESTRICT`，attach 单事务（message INSERT + 条件 UPDATE 同一 transaction），**会话删除 = 同一 transaction 内先 purge image rows + batch rows 再删 conversation（R6 P1-2）**，TTL GC（整批/逐 child 语义见 R7 P1-3）、消息删除转 recycled、启动 reconciliation。技术决策，不再升级 operator（D3 收敛）。
4. **UI 首版范围**：文件选择是否与拖拽/粘贴同 Phase 交付，还是拖拽/粘贴延后？**✅ UI Gate 已收敛（2026-08-09 @烁烁）**：选图主入口 + 粘贴同 Phase、拖拽延后。
5. **跨聊天室 delivery**：**✅ 已定案（Design Gate Review，2026-08-09 @opus）**——F005 首版**不支持** F003 图片 delivery：若 F003 notify/request 路径收到带图消息，返回结构化 reject（`IMAGE_DELIVERY_NOT_SUPPORTED` + 人话原因），显式 Non-goal，禁止静默剥图。见 Non-goals。

## Non-goals

- 图片生成、图片编辑、任意文件附件、OCR fallback、视频/音频上传。
- **F003 跨聊天室图片 delivery 首版不支持**：notify/request 收到带图消息 → 结构化 reject（`IMAGE_DELIVERY_NOT_SUPPORTED`），不静默剥图（OQ5 定案；executable AC 见 AC-B4）。
- 不用 data URI 把图片塞进消息体（防 DB 膨胀）。
- 不按模型名硬编码 vision 白名单；不把 provider 差异泄漏到 UI/store。
- 首版不连 Redis 6399、不用生产用户数据；所有测试用隔离存储。
