/**
 * conversation.metadata.titleSource 状态机。
 *
 * 状态（按优先级递增）：
 *   default             会话创建时的占位标题（"New Conversation" 等）
 *   auto_first_message  由首条用户消息自动生成的标题
 *   auto_llm            由 LLM 摘要自动生成的标题
 *   manual              用户手动命名的标题（终态）
 *
 * 不变量：
 *   - manual 为终态：任何自动标题逻辑（default / auto_first_message / auto_llm）
 *     不得覆盖 manual 标题。
 *   - default / auto_first_message 可被更高优先级的来源升级。
 *   - 同级重写允许（幂等，例如用户再次手动改名、LLM 重新生成）。
 *   - 任何降级（rank 更小）一律拒绝。
 */

const TITLE_SOURCE_DEFAULT = 'default';
const TITLE_SOURCE_AUTO_FIRST_MESSAGE = 'auto_first_message';
const TITLE_SOURCE_AUTO_LLM = 'auto_llm';
const TITLE_SOURCE_MANUAL = 'manual';

const CONVERSATION_TITLE_SOURCES = [
  TITLE_SOURCE_DEFAULT,
  TITLE_SOURCE_AUTO_FIRST_MESSAGE,
  TITLE_SOURCE_AUTO_LLM,
  TITLE_SOURCE_MANUAL,
];

const TITLE_SOURCE_RANK: any = {
  [TITLE_SOURCE_DEFAULT]: 0,
  [TITLE_SOURCE_AUTO_FIRST_MESSAGE]: 1,
  [TITLE_SOURCE_AUTO_LLM]: 2,
  [TITLE_SOURCE_MANUAL]: 3,
};

function isConversationTitleSource(value: any) {
  return typeof value === 'string' && CONVERSATION_TITLE_SOURCES.includes(value);
}

/**
 * 归一化任意输入为合法 titleSource。缺失 / 非法值一律回落到 'default'
 * （兼容历史会话：metadata 中没有 titleSource 字段）。
 */
function normalizeConversationTitleSource(value: any) {
  return isConversationTitleSource(value) ? value : TITLE_SOURCE_DEFAULT;
}

/**
 * 从 conversation.metadata 对象中读取 titleSource（含归一化）。
 */
function readConversationTitleSource(metadata: any) {
  const source = metadata && typeof metadata === 'object' ? (metadata as any).titleSource : undefined;
  return normalizeConversationTitleSource(source);
}

/**
 * 状态机核心判定：来源为 `incoming` 的标题写入是否允许覆盖
 * 当前来源为 `current` 的标题。
 *
 * 规则：incoming 的 rank 必须 >= current 的 rank。
 *   - manual(3) 终态：自动来源 rank < 3，全部被拒绝；manual -> manual 允许。
 *   - default(0) / auto_first_message(1) / auto_llm(2) 可被同级或更高来源升级。
 */
function canApplyConversationTitleSource(current: any, incoming: any) {
  const currentRank = TITLE_SOURCE_RANK[normalizeConversationTitleSource(current)];
  const incomingRank = TITLE_SOURCE_RANK[normalizeConversationTitleSource(incoming)];
  return incomingRank >= currentRank;
}

/**
 * 计算一次标题写入后的下一状态。
 * 返回 { applied, titleSource }：
 *   - applied=false 表示写入被状态机拒绝（调用方应保留原标题），
 *     titleSource 保持 current 不变。
 */
function resolveConversationTitleTransition(current: any, incoming: any) {
  const normalizedCurrent = normalizeConversationTitleSource(current);
  const normalizedIncoming = normalizeConversationTitleSource(incoming);
  if (!canApplyConversationTitleSource(normalizedCurrent, normalizedIncoming)) {
    return { applied: false, titleSource: normalizedCurrent };
  }
  return { applied: true, titleSource: normalizedIncoming };
}

module.exports = {
  TITLE_SOURCE_DEFAULT,
  TITLE_SOURCE_AUTO_FIRST_MESSAGE,
  TITLE_SOURCE_AUTO_LLM,
  TITLE_SOURCE_MANUAL,
  CONVERSATION_TITLE_SOURCES,
  isConversationTitleSource,
  normalizeConversationTitleSource,
  readConversationTitleSource,
  canApplyConversationTitleSource,
  resolveConversationTitleTransition,
};
