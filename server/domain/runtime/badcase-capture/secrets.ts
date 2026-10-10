// Badcase 采集的秘密哨兵与受控变量替换。
//
// 契约约束（docs/engineering/runtime/badcase-capture-replay.md §2.5/§6）：
// - 秘密必须先扫描、后落盘；命中哨兵的文件/文本不得先写入 CAS 再脱敏。
// - prompt 归档时把运行时凭据值替换为占位符，只记录变量名与出现次数，不记录值。

const SECRET_SENTINEL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/u,
  /\bghp_[A-Za-z0-9_]{8,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/u,
  /\b-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd)\s*[:=]\s*['"]?[^\s,'";]{6,}/iu,
];

// 采集中允许替换为占位符的运行时变量。清单之外的内容逐字节保留。
const CONTROLLED_REPLAY_VARIABLES = [
  'CAFF_CHAT_API_URL',
  'CAFF_CHAT_CALLBACK_TOKEN',
  'CAFF_CHAT_INVOCATION_ID',
  'CAFF_CHAT_CONVERSATION_ID',
  'CAFF_CHAT_TURN_ID',
  'CAFF_CHAT_TOOLS_PATH',
  'CAFF_CHAT_TOOLS_RELATIVE_PATH',
  'CAFF_BROWSER_CLI_PATH',
  'PLAYWRIGHT_CLI_SESSION',
  'PI_AGENT_SANDBOX_DIR',
  'PI_AGENT_PRIVATE_DIR',
];

function looksBinary(buffer: any) {
  if (!buffer || !buffer.length) {
    return false;
  }
  const probeLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < probeLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

// 返回命中的哨兵模式下标；未命中返回 -1。二进制内容跳过哨兵扫描（无法可靠匹配文本模式）。
export function findSecretSentinel(content: any) {
  if (!Buffer.isBuffer(content)) {
    return findSecretSentinel(Buffer.from(String(content || ''), 'utf8'));
  }
  if (looksBinary(content)) {
    return -1;
  }
  const text = content.toString('utf8');
  for (let index = 0; index < SECRET_SENTINEL_PATTERNS.length; index += 1) {
    if (SECRET_SENTINEL_PATTERNS[index].test(text)) {
      return index;
    }
  }
  return -1;
}

export function containsSecretSentinel(content: any) {
  return findSecretSentinel(content) !== -1;
}

// 把已知的运行时变量值替换为占位符。replacements: { VAR_NAME: 原值 }。
// 返回 { text, replacements: [{ name, count }], normalized }；不记录任何原值。
export function replaceControlledVariables(text: any, replacements: any) {
  let result = String(text || '');
  const records: any[] = [];
  const names = Object.keys(replacements && typeof replacements === 'object' ? replacements : {});
  for (const name of names) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName || !CONTROLLED_REPLAY_VARIABLES.includes(trimmedName)) {
      continue;
    }
    const value = String(replacements[name] || '');
    if (!value) {
      continue;
    }
    let count = 0;
    // split/join 做字面量替换，避免把值当作正则。
    const parts = result.split(value);
    if (parts.length > 1) {
      count = parts.length - 1;
      result = parts.join(`{{${trimmedName}}}`);
    }
    if (count > 0) {
      records.push({ name: trimmedName, count });
    }
  }
  return { text: result, replacements: records };
}

export function listControlledReplayVariables() {
  return CONTROLLED_REPLAY_VARIABLES.slice();
}
