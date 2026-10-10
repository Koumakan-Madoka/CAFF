// pi session 最小已验证子集校验器（契约 §2.4，GPT 复审 #3 第五轮设计）。
//
// 原则：维度清单制，未验证维度默认 incomplete。
// - 每个维度有具体验证依据才进 verifiedDimensions（依据级别：结构=语法形态，
//   链=历史引用可解析且语义位置正确，内容=字节良构）；
// - 本 session 实际需要但未验证的维度进 unverifiedDimensions → complete=false；
// - 结构性损坏（版本不符、未知类型、断链、非法字段、非法附件编码）→ ok=false，
//   材料不归档，禁止以未验证材料充当回放输入。
//
// 全部规则钉到固定 pi 版本（@earendil-works/pi-coding-agent 与 pi-ai 均 0.85.1，
// package-lock 固定；契约 §2.4 记录同一份依据）：
// - CURRENT_SESSION_VERSION = 3（session-manager.js）；v1/v2 会被 pi 加载时迁移改写，
//   归档原始字节不保真 → 拒绝。
// - SessionEntry 恰好 9 种非头类型（session-manager.d.ts L105）。
// - 存储消息 role：pi-ai Message 联合 {user, assistant, toolResult} 加上
//   pi-coding-agent messages.d.ts 的 CustomAgentMessages 模块增强 {bashExecution, custom}；
//   branchSummary/compactionSummary 是投影期生成类型（createBranchSummaryMessage 等），
//   禁止作为存储条目出现。
// - branch_summary.fromId 可以是字面量 "root"（session-manager.js branchWithSummary：
//   fromId = leafId ?? "root"）。
// - compaction.firstKeptEntryId 必须是当前叶路径上、位于该 compaction 之前的条目
//   （buildContextEntries 语义：找不到则 kept 条目被静默省略）。
// - 字段形状：pi-ai types.d.ts（AssistantMessage 需 api/provider/model/usage/stopReason；
//   ToolResultMessage 需 toolCallId/toolName/isError + content 块）与
//   pi-coding-agent messages.d.ts（BashExecutionMessage、CustomMessage）。
//
// 明确不宣称：不验证工具存在性、模型行为、图像像素有效性、扩展私有状态语义、
// bash 自由文本依赖。这些进入 unverifiedDimensions 并使 complete=false。

const path = require('node:path');

export const PI_VERSION_PIN = '0.85.1';
export const SUPPORTED_SESSION_VERSION = 3;

const KNOWN_ENTRY_TYPES = new Set([
  'message',
  'thinking_level_change',
  'model_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
]);

const KNOWN_MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult', 'bashExecution', 'custom']);
const PROJECTION_ONLY_ROLES = new Set(['branchSummary', 'compactionSummary']);
const IMAGE_MIME_WHITELIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// 已知文件工具的 path 实参可分析；其余工具（含 bash）依赖不可静态分析。
const KNOWN_FILE_TOOLS = new Set(['read', 'write', 'edit']);

const BASE64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isStrictBase64(value: any) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    return false;
  }
  if (!BASE64_STRICT.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value;
}

function validateImageBlock(block: any) {
  if (typeof block.data !== 'string' || !block.data) {
    return { reject: 'image_missing_data' };
  }
  if (typeof block.mimeType !== 'string' || !IMAGE_MIME_WHITELIST.has(block.mimeType)) {
    return { reject: 'image_mimetype_unverified' };
  }
  if (!isStrictBase64(block.data)) {
    return { reject: 'session_attachment_malformed' };
  }
  // 编码形态良构 ≠ 像素有效/附件依赖完整（GPT 复审 #3）：诚实降级维度。
  return { unverified: 'image_content_unverified' };
}

// 内容块逐字段校验（按 role 限定合法块类型，依据 pi-ai types.d.ts 各消息接口）。
function validateContentBlocks(blocks: any[], role: any, pushReject: any, pushUnverified: any) {
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      pushReject('block_not_object');
      continue;
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        pushReject('text_missing_text');
      }
      continue;
    }
    if (block.type === 'thinking') {
      if (role !== 'assistant') {
        pushReject('thinking_not_allowed_for_role');
      } else if (typeof block.thinking !== 'string') {
        pushReject('thinking_missing_thinking');
      }
      continue;
    }
    if (block.type === 'toolCall') {
      if (role !== 'assistant') {
        pushReject('toolcall_not_allowed_for_role');
        continue;
      }
      if (typeof block.id !== 'string' || !block.id) {
        pushReject('toolcall_missing_id');
      }
      if (typeof block.name !== 'string' || !block.name) {
        pushReject('toolcall_missing_name');
      }
      if (!block.arguments || typeof block.arguments !== 'object' || Array.isArray(block.arguments)) {
        pushReject('toolcall_missing_arguments');
      }
      continue;
    }
    if (block.type === 'image') {
      if (role === 'assistant') {
        pushReject('image_not_allowed_for_role');
        continue;
      }
      const image = validateImageBlock(block);
      if (image.reject) {
        pushReject(image.reject);
      } else if (image.unverified) {
        pushUnverified(image.unverified);
      }
      continue;
    }
    pushReject(`unverified_block_type:${String(block && block.type)}`);
  }
}

function validateToolCallDependencies(toolCall: any, sessionCwd: any, authorizedRoot: any, pushUnverified: any) {
  const name = String(toolCall && toolCall.name || '');
  if (!KNOWN_FILE_TOOLS.has(name)) {
    // bash 自由文本与未知工具的依赖不可静态分析（W2 不冒充，W4 环境模板职责）。
    pushUnverified(`unanalyzable_tool_dependencies:${name || 'unknown'}`);
    return;
  }
  const args = toolCall.arguments && typeof toolCall.arguments === 'object' ? toolCall.arguments : {};
  const rawPath = typeof args.path === 'string' ? args.path : '';
  if (!rawPath) {
    pushUnverified(`unanalyzable_tool_dependencies:${name}`);
    return;
  }
  const root = String(authorizedRoot || '').trim();
  const cwd = String(sessionCwd || '').trim() || root;
  const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
  if (!root) {
    pushUnverified('tool_path_scope_unverifiable');
    return;
  }
  const relative = path.relative(root, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    // 界内：材料在授权范围内（历史工具实参不要求当前仍存在——GPT 复审边界 3）。
    return;
  }
  pushUnverified(`out_of_scope_path_dependency:${name}`);
}

export function validateSessionV2(text: any, options: any = {}) {
  const verified = new Set<string>();
  const unverified = new Set<string>();
  const pushUnverified = (dimension: string) => { unverified.add(dimension); };
  const finish = (ok: boolean, reason: string, lineCount: number) => ({
    ok,
    reason,
    lineCount,
    verifiedDimensions: Array.from(verified).sort(),
    unverifiedDimensions: Array.from(unverified).sort(),
  });

  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return finish(false, 'session_empty', 0);
  }

  const entries: any[] = [];
  const seenIds = new Set<string>();
  const parentById = new Map<string, string | null>();
  let sessionCwd = '';

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    let entry: any;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      return finish(false, `session_invalid_jsonl:line_${lineNo}`, lines.length);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return finish(false, `session_non_object_entry:line_${lineNo}`, lines.length);
    }

    if (index === 0) {
      if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id) {
        return finish(false, 'session_header_invalid', lines.length);
      }
      if (entry.version === undefined || entry.version === null) {
        return finish(false, 'session_header_version_missing', lines.length);
      }
      if (Number(entry.version) !== SUPPORTED_SESSION_VERSION) {
        return finish(false, 'session_unsupported_version', lines.length);
      }
      sessionCwd = typeof entry.cwd === 'string' ? entry.cwd : '';
      seenIds.add(entry.id);
      parentById.set(entry.id, null);
      entries.push(entry);
      verified.add('session_header_version');
      continue;
    }

    const entryType = entry.type;
    if (typeof entryType !== 'string' || !KNOWN_ENTRY_TYPES.has(entryType)) {
      // 未知类型 = 固定 pi 版本不会写出的条目（格式演进/手工编辑）→ 拒绝归档，
      // 不按“可能是未来格式”放行（GPT 复审 #3：默认拒绝未验证维度）。
      return finish(false, `session_unverified_entry_type:line_${lineNo}:${String(entryType)}`, lines.length);
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      return finish(false, `session_entry_id_missing:line_${lineNo}`, lines.length);
    }
    if (seenIds.has(entry.id)) {
      return finish(false, `session_duplicate_entry_id:line_${lineNo}`, lines.length);
    }
    const parentId = entry.parentId === null || entry.parentId === undefined ? null : String(entry.parentId);
    if (parentId !== null && !seenIds.has(parentId)) {
      // 悬空引用会被 pi getTree 提升为根 = 畸形历史。
      return finish(false, `session_chain_broken:line_${lineNo}`, lines.length);
    }

    // 当前条目加入前的祖先路径（不含本行、不含 session 头）：compaction/branch/tool
    // 链校验的基准。buildContextEntries 的叶路径由消息类条目构成；firstKeptEntryId
    // 指向 session 头不等于合法历史引用（GPT 复审 #3 探针）。
    const headerId = entries[0] && entries[0].id;
    const ancestorPath = new Set<string>();
    {
      let cursor = parentId;
      while (cursor !== null && cursor !== headerId && parentById.has(cursor)) {
        ancestorPath.add(cursor);
        cursor = parentById.get(cursor) ?? null;
      }
    }

    if (entryType === 'message') {
      const message = entry.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || typeof message.role !== 'string' || !message.role) {
        return finish(false, `session_invalid_message:line_${lineNo}`, lines.length);
      }
      if (PROJECTION_ONLY_ROLES.has(message.role)) {
        // 投影期生成类型不得作为存储条目出现（pi 只会投影生成，不会写入 session 文件）。
        return finish(false, `session_unverified_message_role:line_${lineNo}:${message.role}`, lines.length);
      }
      if (!KNOWN_MESSAGE_ROLES.has(message.role)) {
        return finish(false, `session_unverified_message_role:line_${lineNo}:${message.role}`, lines.length);
      }

      const rejectReasons: string[] = [];
      const pushReject = (detail: string) => { rejectReasons.push(detail); };
      const role = message.role;

      if (role === 'assistant') {
        for (const field of ['api', 'provider', 'model', 'stopReason']) {
          if (typeof message[field] !== 'string' || !message[field]) {
            pushReject(`assistant_missing_${field}`);
          }
        }
        if (!message.usage || typeof message.usage !== 'object' || Array.isArray(message.usage)) {
          pushReject('assistant_missing_usage');
        }
      }
      if (role === 'toolResult') {
        if (typeof message.toolCallId !== 'string' || !message.toolCallId) {
          pushReject('toolresult_missing_toolCallId');
        }
        if (typeof message.toolName !== 'string' || !message.toolName) {
          pushReject('toolresult_missing_toolName');
        }
        if (typeof message.isError !== 'boolean') {
          pushReject('toolresult_missing_isError');
        }
      }
      if (role === 'bashExecution') {
        if (typeof message.command !== 'string') {
          pushReject('bashexecution_missing_command');
        }
        if (typeof message.output !== 'string') {
          pushReject('bashexecution_missing_output');
        }
        if (typeof message.cancelled !== 'boolean' || typeof message.truncated !== 'boolean') {
          pushReject('bashexecution_missing_flags');
        }
        // bash 自由文本的依赖不可静态分析（结构合法也要诚实降级）。
        pushUnverified('unanalyzable_tool_dependencies:bashExecution');
      }
      if (role === 'custom') {
        if (typeof message.customType !== 'string' || !message.customType) {
          pushReject('custom_missing_customType');
        }
        if (typeof message.display !== 'boolean') {
          pushReject('custom_missing_display');
        }
      }

      // content：string（user/bashExecution 外仅 custom 合法）或块数组。
      if (role === 'bashExecution') {
        // 无 content 块。
      } else if (typeof message.content === 'string') {
        if (role === 'assistant' || role === 'toolResult') {
          pushReject('string_content_not_allowed_for_role');
        }
      } else if (Array.isArray(message.content)) {
        const allowed: Record<string, Set<string>> = {
          user: new Set(['text', 'image']),
          assistant: new Set(['text', 'thinking', 'toolCall']),
          toolResult: new Set(['text', 'image']),
          custom: new Set(['text', 'image']),
        };
        for (const block of message.content) {
          const blockType = block && block.type;
          if (!allowed[role] || !allowed[role].has(blockType)) {
            pushReject(`unverified_block_type:${String(blockType)}`);
            continue;
          }
          validateContentBlocks([block], role, pushReject, pushUnverified);
        }
      } else {
        pushReject('content_invalid');
      }

      if (rejectReasons.length > 0) {
        return finish(false, `session_invalid_content_block:line_${lineNo}:${rejectReasons[0]}`, lines.length);
      }

      // tool 链（链级依据）：toolResult.toolCallId 必须引用祖先路径上前序 assistant 的 toolCall。
      if (role === 'toolResult') {
        let resolved = false;
        for (const prior of entries) {
          if (prior.type !== 'message' || !ancestorPath.has(prior.id)) {
            continue;
          }
          const priorMessage = prior.message;
          if (priorMessage && priorMessage.role === 'assistant' && Array.isArray(priorMessage.content)) {
            for (const block of priorMessage.content) {
              if (block && block.type === 'toolCall' && block.id === message.toolCallId) {
                resolved = true;
                break;
              }
            }
          }
          if (resolved) {
            break;
          }
        }
        if (!resolved) {
          return finish(false, `session_tool_chain_broken:line_${lineNo}`, lines.length);
        }
        verified.add('tool_chain');
      }

      // assistant toolCall 的文件依赖范围（结构级白名单，无 pi 依据——诚实标注）。
      if (role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block && block.type === 'toolCall') {
            validateToolCallDependencies(block, sessionCwd, options.authorizedRoot, pushUnverified);
          }
        }
      }
      verified.add('message_structure');
    }

    if (entryType === 'custom_message') {
      if (typeof entry.customType !== 'string' || !entry.customType) {
        return finish(false, `session_invalid_custom_message:line_${lineNo}`, lines.length);
      }
      if (typeof entry.display !== 'boolean') {
        return finish(false, `session_invalid_custom_message:line_${lineNo}`, lines.length);
      }
      if (entry.content === null || entry.content === undefined) {
        // pi 类型化 API 不会写出 null content（CustomMessageEntry.content 必填）；
        // 出现即手工编辑/损坏（GPT 复审 #3 探针）。
        return finish(false, `session_invalid_custom_message:line_${lineNo}`, lines.length);
      }
      const rejectReasons: string[] = [];
      if (typeof entry.content === 'string') {
        // 合法形状（CustomMessageEntry.content: string | blocks）。
      } else if (Array.isArray(entry.content)) {
        validateContentBlocks(entry.content, 'custom', (detail: string) => { rejectReasons.push(detail); }, pushUnverified);
      } else {
        rejectReasons.push('content_invalid');
      }
      if (rejectReasons.length > 0) {
        return finish(false, `session_invalid_content_block:line_${lineNo}:${rejectReasons[0]}`, lines.length);
      }
      verified.add('message_structure');
    }

    if (entryType === 'model_change') {
      if (typeof entry.provider !== 'string' || !entry.provider
        || typeof entry.modelId !== 'string' || !entry.modelId) {
        // ModelChangeEntry 两个字段均必填（session-manager.d.ts）；缺即损坏（GPT 复审 #3）。
        return finish(false, `session_model_change_incomplete:line_${lineNo}`, lines.length);
      }
      verified.add('model_pinning');
    }

    if (entryType === 'compaction') {
      if (typeof entry.summary !== 'string' || !entry.summary) {
        return finish(false, `session_compaction_incomplete:line_${lineNo}`, lines.length);
      }
      if (typeof entry.firstKeptEntryId !== 'string' || !entry.firstKeptEntryId) {
        return finish(false, `session_compaction_ref_missing:line_${lineNo}`, lines.length);
      }
      // 链级依据（buildContextEntries）：firstKeptEntryId 必须在当前叶路径上且位于
      // 本 compaction 之前；指向 session 头/自身/未来条目/其他分支 → 拒绝。
      if (!ancestorPath.has(entry.firstKeptEntryId)) {
        return finish(false, `session_compaction_ref_broken:line_${lineNo}`, lines.length);
      }
      verified.add('compaction_chain');
    }

    if (entryType === 'branch_summary') {
      if (typeof entry.summary !== 'string' || !entry.summary) {
        return finish(false, `session_branch_summary_incomplete:line_${lineNo}`, lines.length);
      }
      // fromId 可以是字面量 "root"（branchWithSummary: leafId ?? "root"）。
      const fromId = String(entry.fromId === null || entry.fromId === undefined ? '' : entry.fromId);
      if (!fromId) {
        return finish(false, `session_branch_summary_incomplete:line_${lineNo}`, lines.length);
      }
      if (fromId !== 'root' && !seenIds.has(fromId)) {
        return finish(false, `session_branch_ref_broken:line_${lineNo}`, lines.length);
      }
      verified.add('branch_chain');
    }

    if (entryType === 'custom') {
      if (typeof entry.customType !== 'string' || !entry.customType) {
        return finish(false, `session_invalid_custom_entry:line_${lineNo}`, lines.length);
      }
      // CustomEntry.data 是扩展私有状态，无通用验证依据 → 诚实降级（GPT 复审边界 2）。
      pushUnverified(`extension_state_unverified:${entry.customType}`);
    }

    seenIds.add(entry.id);
    parentById.set(entry.id, parentId);
    entries.push(entry);
  }

  verified.add('entry_type_whitelist');
  verified.add('parent_chain');
  return finish(true, '', lines.length);
}
