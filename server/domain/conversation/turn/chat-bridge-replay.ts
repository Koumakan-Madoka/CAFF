export type ChatBridgeReplay = {
  visibility: 'public' | 'private';
  content: string;
  recipients: string[];
  mode: string;
  handoff: boolean;
  noHandoff: boolean;
  sourceBlock: string;
};

function extractBashCodeBlocks(text: any) {
  const source = String(text || '');
  const blocks: string[] = [];
  const codeFenceRegex = /```(?:bash|sh|shell)\s*([\s\S]*?)```/giu;
  let match;

  while ((match = codeFenceRegex.exec(source)) !== null) {
    blocks.push(String(match[1] || '').trim());
  }

  return blocks;
}

function parseChatBridgeReplayFromBashBlock(block: any): ChatBridgeReplay | null {
  const source = String(block || '').trim();

  if (!source) {
    return null;
  }

  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredocMatch = line.match(
      /^\s*cat\s+<<\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))\s*\|\s*(.+)$/iu,
    );

    if (!heredocMatch) {
      continue;
    }

    const delimiter = String(heredocMatch[1] || heredocMatch[2] || heredocMatch[3] || '').trim();
    const commandLine = String(heredocMatch[4] || '').trim();

    if (!delimiter || !commandLine) {
      continue;
    }

    if (!/--content-stdin\b/iu.test(commandLine)) {
      continue;
    }

    const isSendPublic = /\bsend-public\b/iu.test(commandLine);
    const isSendPrivate = /\bsend-private\b/iu.test(commandLine);

    if (!isSendPublic && !isSendPrivate) {
      continue;
    }

    const contentLines: string[] = [];
    let foundTerminator = false;

    for (let j = index + 1; j < lines.length; j += 1) {
      if (String(lines[j] || '').trimEnd() === delimiter) {
        foundTerminator = true;
        break;
      }

      contentLines.push(lines[j]);
    }

    if (!foundTerminator) {
      continue;
    }

    const content = contentLines.join('\n').trim();

    if (!content) {
      continue;
    }

    const recipients: string[] = [];
    const toRegex = /(?:^|\s)--to\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/giu;

    if (isSendPrivate) {
      let toMatch;
      while ((toMatch = toRegex.exec(commandLine)) !== null) {
        const value = String(toMatch[1] || toMatch[2] || toMatch[3] || '').trim();
        if (value) {
          recipients.push(value);
        }
      }
    }

    let mode = 'replace';

    if (isSendPublic) {
      const modeMatch = commandLine.match(/(?:^|\s)--mode\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/iu);
      if (modeMatch) {
        const candidate = String(modeMatch[1] || modeMatch[2] || modeMatch[3] || '').trim();
        if (candidate) {
          mode = candidate;
        }
      }
    }

    const handoff = /\s--handoff\b/iu.test(commandLine) || /\s--trigger-reply\b/iu.test(commandLine);
    const noHandoff = /\s--no-handoff\b/iu.test(commandLine) || /\s--silent\b/iu.test(commandLine);

    return {
      visibility: isSendPrivate ? 'private' : 'public',
      content,
      recipients,
      mode,
      handoff,
      noHandoff,
      sourceBlock: source,
    };
  }

  return null;
}

export function extractChatBridgeReplaysFromText(text: any) {
  const blocks = extractBashCodeBlocks(text);
  const replays: ChatBridgeReplay[] = [];

  for (const block of blocks) {
    const replay = parseChatBridgeReplayFromBashBlock(block);

    if (replay) {
      replays.push(replay);
    }
  }

  return replays;
}

export function pickChatBridgeReplay(
  replays: ChatBridgeReplay[],
  options: { privateOnly?: boolean } = {},
): ChatBridgeReplay | null {
  const candidates = (Array.isArray(replays) ? replays : []).filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  const filtered = options.privateOnly ? candidates.filter((replay) => replay.visibility === 'private') : candidates;

  if (filtered.length === 0) {
    return null;
  }

  const publicReplays = filtered.filter((replay) => replay.visibility === 'public');
  if (publicReplays.length > 0) {
    return publicReplays[publicReplays.length - 1];
  }

  const selfNotes = filtered.filter((replay) => replay.visibility === 'private' && replay.recipients.length === 0);
  if (selfNotes.length > 0) {
    return selfNotes[selfNotes.length - 1];
  }

  return filtered[filtered.length - 1];
}

