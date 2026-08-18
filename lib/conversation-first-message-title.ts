/**
 * 首条用户消息自动生成会话标题（auto_first_message）。
 *
 * 规则：
 *   - 去除换行：所有换行符（\r\n / \n / \r）折叠为普通空格
 *   - 折叠连续空白：任意连续 Unicode 空白折叠为单个空格，并 trim 首尾
 *   - 超长截断：按 Unicode 码点（code point，emoji 安全）截取前
 *     AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS 个字符，超出部分以单个省略号 '…' 收尾
 *   - 归一化后为空（空消息 / 纯空白）返回 null，调用方不得触发标题写入
 */

const AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS = 40;
const AUTO_FIRST_MESSAGE_TITLE_ELLIPSIS = '…';

/**
 * 归一化首条用户消息文本：去换行 + 折叠连续空白 + trim。
 * @param {*} content 原始消息内容
 * @returns {string} 归一化后的单行文本（可能为空串）
 */
function normalizeFirstMessageTitleText(content: any) {
  return String(content == null ? '' : content)
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 从首条用户消息内容派生会话标题。
 * @param {*} content 原始消息内容
 * @returns {string|null} 派生标题；空消息 / 纯空白消息返回 null（不触发）
 */
function deriveTitleFromFirstMessage(content: any) {
  const normalized = normalizeFirstMessageTitleText(content);

  if (!normalized) {
    return null;
  }

  // Array.from 按码点切分，避免截断 emoji / 代理对
  const chars = Array.from(normalized);

  if (chars.length <= AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS) {
    return normalized;
  }

  return chars.slice(0, AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS).join('') + AUTO_FIRST_MESSAGE_TITLE_ELLIPSIS;
}

module.exports = {
  AUTO_FIRST_MESSAGE_TITLE_MAX_CHARS,
  AUTO_FIRST_MESSAGE_TITLE_ELLIPSIS,
  normalizeFirstMessageTitleText,
  deriveTitleFromFirstMessage,
};
