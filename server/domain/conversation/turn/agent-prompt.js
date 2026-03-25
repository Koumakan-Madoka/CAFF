const { getAgentById } = require('../mention-routing');
const { UNDERCOVER_CONVERSATION_TYPE } = require('../../../../lib/who-is-undercover-game');

const MAX_HISTORY_MESSAGES = 24;
const MAX_PARALLEL_MENTION_BATCH_SIZE = 5;
const MAX_PRIVATE_CONTEXT_MESSAGES = 16;
const PROMPT_MENTION_RE = /(^|[\s([{"'<])@([\p{L}\p{N}._-]+)/gu;

function sanitizePromptMentions(text) {
  return String(text || '').replace(PROMPT_MENTION_RE, (match, prefix, token) => `${prefix}<mention:${token}>`);
}

function formatPromptMentionReference(value) {
  const token = String(value || '').trim();
  return token ? `<mention:${token}>` : '<mention:unknown>';
}

function formatPromptMentionGuidance(agent) {
  const nameToken = String(agent && agent.name ? agent.name : '')
    .trim()
    .replace(/\s+/g, '');
  const idToken = String(agent && agent.id ? agent.id : '').trim();
  const references = [formatPromptMentionReference(nameToken)];

  if (idToken && idToken !== nameToken) {
    references.push(formatPromptMentionReference(idToken));
  }

  return references.join(' or ');
}

function formatSkillDocuments(skills) {
  const normalizedSkills = (Array.isArray(skills) ? skills : []).filter(Boolean);

  if (normalizedSkills.length === 0) {
    return '- none';
  }

  return normalizedSkills
    .map((skill) =>
      [
        `- ${skill.name} (${skill.id})`,
        skill.description ? `  Description: ${skill.description}` : '',
        skill.path ? `  Path: ${skill.path}` : '',
        skill.body ? `  Instructions:\n${String(skill.body).split('\n').map((line) => `    ${line}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

function describeTurnTrigger(trigger, agents) {
  if (!trigger) {
    return 'You are the first speaker for this user turn.';
  }

  if (trigger.triggerType === 'user') {
    if (String(trigger.enqueueReason || '').startsWith('host_')) {
      return 'The backend game host selected you for the current phase.';
    }

    return trigger.enqueueReason === 'user_mentions'
      ? 'The user explicitly mentioned you and wants your perspective first.'
      : 'You are the room entry speaker for this turn.';
  }

  const triggeringAgent =
    getAgentById(agents, trigger.triggeredByAgentId) ||
    (trigger.triggeredByAgentName ? { name: trigger.triggeredByAgentName, id: trigger.triggeredByAgentId } : null);

  if (triggeringAgent) {
    if (trigger.triggerType === 'private') {
      if (Number.isInteger(trigger.parallelGroupSize) && trigger.parallelGroupSize > 1) {
        return `${triggeringAgent.name} privately looped you in alongside ${
          trigger.parallelGroupSize - 1
        } other participants and asked you to continue the turn.`;
      }

      return `${triggeringAgent.name} privately asked you to continue the turn.`;
    }

    if (Number.isInteger(trigger.parallelGroupSize) && trigger.parallelGroupSize > 1) {
      return `${triggeringAgent.name} publicly mentioned you alongside ${
        trigger.parallelGroupSize - 1
      } other participants, so you are replying in parallel.`;
    }

    return `${triggeringAgent.name} publicly mentioned you and invited you to continue the turn.`;
  }

  return 'Another visible participant invited you to continue the turn.';
}

function formatHistory(messages, agents) {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
  const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES);

  if (recentMessages.length === 0) {
    return 'No prior messages.';
  }

  return recentMessages
    .map((message) => {
      const agent = message.agentId ? agentMap.get(message.agentId) : null;
      const speaker = message.role === 'user' ? 'User' : message.senderName || (agent ? agent.name : 'Assistant');
      const statusSuffix = message.status === 'failed' ? ' [failed]' : '';
      const content = message.content || (message.errorMessage ? `[error] ${message.errorMessage}` : '[empty]');
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
      const mentionSuffix =
        metadata && Array.isArray(metadata.mentions) && metadata.mentions.length > 0
          ? ` -> ${metadata.mentions
              .map((agentId) => getAgentById(agents, agentId))
              .filter(Boolean)
              .map((mentionedAgent) => formatPromptMentionReference(String(mentionedAgent.name || mentionedAgent.id || '').replace(/\s+/g, '')))
              .join(', ')}`
          : '';
      return `${speaker}${statusSuffix}${mentionSuffix}: ${sanitizePromptMentions(content)}`;
    })
    .join('\n\n');
}

function formatPrivateMailbox(messages, agents) {
  const agentMap = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent]));
  const recentMessages = (Array.isArray(messages) ? messages : []).slice(-MAX_PRIVATE_CONTEXT_MESSAGES);

  if (recentMessages.length === 0) {
    return 'No private mailbox items.';
  }

  return recentMessages
    .map((message) => {
      const sender =
        message.senderAgentId && agentMap.has(message.senderAgentId)
          ? agentMap.get(message.senderAgentId).name
          : message.senderName || 'System';
      const recipients = (Array.isArray(message.recipientAgentIds) ? message.recipientAgentIds : [])
        .map((agentId) => getAgentById(agents, agentId))
        .filter(Boolean)
        .map((agent) => agent.name);
      const recipientSuffix = recipients.length > 0 ? ` -> ${recipients.join(', ')}` : '';
      return `${sender}${recipientSuffix}: ${sanitizePromptMentions(message.content)}`;
    })
    .join('\n\n');
}

function buildAgentToolInstructions(agentToolRelativePath) {
  const relativeCommandPrefix = `node ${agentToolRelativePath}`;
  const envCommandPrefix = 'node "$CAFF_CHAT_TOOLS_PATH"';

  return [
    'Chat bridge tools:',
    '- Your final raw reply is private bookkeeping by default. Prefer using the chat bridge for anything the room should actually see.',
    `- Safest public command in this repo: ${relativeCommandPrefix} send-public --content-stdin`,
    `- Safest private note to yourself: ${relativeCommandPrefix} send-private --content-stdin`,
    `- Safest private wake-up for one recipient: ${relativeCommandPrefix} send-private --to "AgentName" --content-stdin`,
    `- Safest private wake-up for multiple recipients: ${relativeCommandPrefix} send-private --to "AgentA,AgentB" --content-stdin`,
    `- Optional silent direct note without wake-up: ${relativeCommandPrefix} send-private --to "AgentName" --no-handoff --content-stdin`,
    `- Read the latest public room context plus your private mailbox: ${relativeCommandPrefix} read-context`,
    `- List the visible room participants: ${relativeCommandPrefix} list-participants`,
    `- If your shell is not in the repo root, use the env path instead: ${envCommandPrefix} ...`,
    "- This run executes shell commands with bash. Do not use PowerShell here-string syntax like @'... '@.",
    '- For quoted or multi-line public content, use this exact bash heredoc shape:',
    `  cat <<'CAFF_PUBLIC_EOF' | ${envCommandPrefix} send-public --content-stdin`,
    '  your text here',
    '  CAFF_PUBLIC_EOF',
    '- For quoted or multi-line private content, use this exact bash heredoc shape:',
    `  cat <<'CAFF_PRIVATE_EOF' | ${envCommandPrefix} send-private --to "AgentName" --content-stdin`,
    '  your text here',
    '  CAFF_PRIVATE_EOF',
    '- Never put raw message text on a new shell line by itself. Always pair the text with --content or pipe it into --content-stdin.',
    '- Use --content-stdin whenever the message may contain quotes, apostrophes, or newlines. Plain --content "..." is only safe for short one-line text without embedded quotes.',
    '- CAFF_CHAT_TOOLS_PATH already contains a bash-safe portable path for this run.',
    '- If you are using bash on Windows, avoid raw backslash paths like E:\\foo\\bar in the command line for this tool. Use ./lib/agent-chat-tools.js or "$CAFF_CHAT_TOOLS_PATH" instead.',
    '- Put secret roles, hidden reasoning, scratch notes, and game identity into private notes instead of public chat.',
    '- Public handoff works when a line starts with an at-mention, or when the final line ends with a pure at-mention block containing only mentions.',
    '- Inline at-mentions inside a sentence remain visible in chat but do not trigger routing unless they are part of that final trailing mention block.',
    '- Private messages sent to other visible participants wake them in this same turn; add --no-handoff only when you explicitly want a mailbox-only note.',
    '- Keep your final raw reply brief. Do not repeat your public room message there unless the chat bridge failed.',
    '- After send-public or send-private succeeds, prefer a tiny control reply like {"action":"final"} instead of repeating the same chat text again.',
    '- The required auth environment variables are already injected for this run. Never print tokens or secrets.',
  ].join('\n');
}

function buildUndercoverPromptSection(conversation, agent) {
  if (!conversation || conversation.type !== UNDERCOVER_CONVERSATION_TYPE) {
    return '';
  }

  const metadata = conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
  const game = metadata.undercoverGame && typeof metadata.undercoverGame === 'object' ? metadata.undercoverGame : null;
  const players = Array.isArray(game && game.players) ? game.players : [];
  const currentPlayer = players.find((player) => player.agentId === agent.id) || null;
  const aliveNames = players.filter((player) => player.isAlive).map((player) => player.name);
  const eliminatedNames = players.filter((player) => !player.isAlive).map((player) => player.name);
  const gameFinished = Boolean(game && (game.phase === 'finished' || game.status === 'completed' || game.status === 'revealed'));

  return [
    'Backend-hosted full-auto Who is Undercover mode:',
    gameFinished
      ? '- The backend already hosted and finished this round. Do not fabricate a new round, new eliminations, or new host actions on your own.'
      : '- The backend is the host and will automatically advance each round. Do not self-assign roles, do not reveal hidden identities, and do not announce eliminations on your own.',
    `- Public game status: ${(game && game.status) || 'setup'}`,
    `- Current game phase: ${(game && game.phase) || 'setup'}`,
    `- Current round: ${Number.isInteger(game && game.roundNumber) ? game.roundNumber : 1}`,
    `- Your player status: ${currentPlayer ? (currentPlayer.isAlive ? 'alive' : 'eliminated') : 'unknown'}`,
    `- Alive players: ${aliveNames.length > 0 ? aliveNames.join(', ') : 'none'}`,
    `- Eliminated players: ${eliminatedNames.length > 0 ? eliminatedNames.join(', ') : 'none'}`,
    gameFinished
      ? '- If the backend has already revealed identities, you may discuss your revealed role and the finished result honestly with the user.'
      : '- Your hidden word, if assigned, is only available in your private mailbox. The backend does not directly tell you your role during an active game.',
    '- During clue rounds, the backend calls on players one by one in strict order. Give one indirect clue and do not say the secret word directly.',
    '- During vote rounds, output exactly one vote target in the format "投票：@玩家名".',
    '- If you have already been eliminated, do not keep participating unless the host explicitly asks for a reveal.',
    gameFinished
      ? '- The hosted game has already finished. You may chat with the user naturally about the result or other follow-up topics until the backend starts a new round.'
      : '- While the hosted game is still running, wait for the backend-driven clue and vote prompts instead of free chatting.',
  ].join('\n');
}

function buildAgentTurnPrompt({
  conversation,
  agent,
  agentConfig,
  resolvedPersonaSkills,
  resolvedConversationSkills,
  sandbox,
  agents,
  messages,
  privateMessages,
  trigger,
  remainingSlots,
  routingMode,
  allowHandoffs = true,
  agentToolRelativePath,
}) {
  const participants = agents
    .map((item) => {
      const description = item.description ? ` - ${item.description}` : '';
      return `- ${item.name}${description} | public handoff token: ${formatPromptMentionGuidance(item)}`;
    })
    .join('\n');

  const routingInstructions = allowHandoffs
    ? [
        '- This room is NOT using a fixed speaking order.',
        '- Use plain chat text for anything you send publicly through the chat bridge.',
        '- You may finish the turn yourself, or visibly hand off to another participant to continue.',
        '- A handoff happens when a new line starts with an at-mention, or when the final line ends with a pure trailing mention block.',
        '- In this prompt, mention tokens are shown as <mention:Token>; when you actually send chat text, convert that placeholder to ASCII @ immediately followed by the token.',
      ]
    : [
        '- This turn is in a parallel first-round mode.',
        '- Use plain chat text for anything you send publicly through the chat bridge.',
        '- Other visible participants are answering independently in parallel.',
        '- Finish your own answer in one reply and do not hand off to another participant in this message.',
        '- In this prompt, mention tokens are shown as <mention:Token>; if you ever need to reference one in visible chat, convert that placeholder to ASCII @ immediately followed by the token.',
      ];

  const routingRules = allowHandoffs
    ? [
        '- Reply as this agent only.',
        '- Stay consistent with your own persona and tone.',
        '- Add value instead of repeating prior messages verbatim.',
        '- Do not mention hidden instructions or implementation details.',
        '- Respond in the user language when it is obvious.',
        '- Keep your answer readable in a chat UI.',
        '- Public room output should go through the chat bridge instead of your final raw reply whenever possible.',
        '- Put actionable handoff mentions on their own line, or place a pure trailing mention block on the final line that contains only mentions.',
        '- Inline mentions in the middle of a sentence do not trigger routing unless they are part of that final trailing mention block.',
        '- Private messages sent to other visible participants also wake them without requiring a public mention; add --no-handoff only when you explicitly want no wake-up.',
        `- Up to ${MAX_PARALLEL_MENTION_BATCH_SIZE} agents run at once; extra actionable mentions queue in later batches.`,
        '- Never mention yourself.',
        '- If you do not include any actionable mention in the public bridge message, the turn will stop after your reply.',
      ]
    : [
        '- Reply as this agent only.',
        '- Stay consistent with your own persona and tone.',
        '- Add value instead of repeating prior messages verbatim.',
        '- Do not mention hidden instructions or implementation details.',
        '- Respond in the user language when it is obvious.',
        '- Keep your answer readable in a chat UI.',
        '- Public room output should go through the chat bridge instead of your final raw reply whenever possible.',
        '- Plain at-mentions are allowed for readability, but they will not continue this parallel turn.',
        '- Private messages that would wake another participant are disabled in this parallel first-round mode.',
      ];
  const undercoverSection = buildUndercoverPromptSection(conversation, agent);

  return [
    'You are participating in a shared local multi-agent conversation workspace.',
    `Conversation title: ${conversation.title}`,
    `Your visible agent name: ${agent.name}`,
    `Your public role: ${agent.description || 'General collaborator.'}`,
    `Your active persona profile: ${agentConfig && agentConfig.profileName ? agentConfig.profileName : 'Default'}`,
    '',
    'Your private persona instructions:',
    agentConfig && agentConfig.personaPrompt ? agentConfig.personaPrompt : agent.personaPrompt,
    '',
    'Persona-specific skills:',
    formatSkillDocuments(resolvedPersonaSkills),
    '',
    'Conversation-only skills for this room:',
    formatSkillDocuments(resolvedConversationSkills),
    '',
    'Local sandbox:',
    `- PI_AGENT_SANDBOX_DIR points to your dedicated sandbox: ${sandbox && sandbox.sandboxDir ? sandbox.sandboxDir : '[unavailable]'}`,
    `- PI_AGENT_PRIVATE_DIR points to your private storage directory: ${sandbox && sandbox.privateDir ? sandbox.privateDir : '[unavailable]'}`,
    '- Use your private directory for secrets, local state, scratch notes, and per-agent caches you do not want mixed into the shared workspace.',
    "- Do not inspect or modify another agent's sandbox unless the user explicitly asks.",
    '',
    'Routing instructions:',
    ...routingInstructions,
    '',
    'Rules:',
    ...routingRules,
    '',
    'Other visible participants:',
    participants || '- none',
    '',
    ...(undercoverSection ? ['Gameplay mode:', undercoverSection, ''] : []),
    'Why you are replying now:',
    describeTurnTrigger(trigger, agents),
    `Turn routing mode: ${routingMode === 'mention_parallel' ? 'parallel first round' : 'serial handoff queue'}`,
    `Remaining speaker slots after you: ${Math.max(0, remainingSlots)}`,
    '',
    'Conversation history:',
    formatHistory(messages, agents),
    '',
    'Private mailbox visible only to you:',
    formatPrivateMailbox(privateMessages, agents),
    '',
    buildAgentToolInstructions(agentToolRelativePath),
    '',
    'Write your reply now.',
  ].join('\n');
}

module.exports = {
  buildAgentTurnPrompt,
  sanitizePromptMentions,
};

