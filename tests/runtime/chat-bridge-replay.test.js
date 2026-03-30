const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractChatBridgeReplaysFromText,
  pickChatBridgeReplay,
} = require('../../build/server/domain/conversation/turn/chat-bridge-replay');

test('chat bridge replay extracts multiple heredoc commands from a single bash block', () => {
  const text = `
\`\`\`bash
cat <<'EOF' | node "$CAFF_CHAT_TOOLS_PATH" send-private --content-stdin
first
EOF

cat <<'EOF' | node "$CAFF_CHAT_TOOLS_PATH" send-private --content-stdin
second
EOF
\`\`\`
`;

  const replays = extractChatBridgeReplaysFromText(text);

  assert.equal(replays.length, 2);
  assert.equal(replays[0].visibility, 'private');
  assert.equal(replays[0].content, 'first');
  assert.equal(replays[1].content, 'second');
  assert.equal(pickChatBridgeReplay(replays).content, 'second');
});

test('chat bridge replay can prefer private replays when requested', () => {
  const text = `
\`\`\`bash
cat <<'EOF' | node "$CAFF_CHAT_TOOLS_PATH" send-public --content-stdin --mode append
public
EOF
cat <<'EOF' | node "$CAFF_CHAT_TOOLS_PATH" send-private --content-stdin --to agent-1
private
EOF
\`\`\`
`;

  const replays = extractChatBridgeReplaysFromText(text);

  assert.equal(replays.length, 2);
  assert.equal(pickChatBridgeReplay(replays).visibility, 'public');
  assert.equal(pickChatBridgeReplay(replays, { privateOnly: true }).visibility, 'private');
  assert.equal(pickChatBridgeReplay(replays, { privateOnly: true }).content, 'private');
});

