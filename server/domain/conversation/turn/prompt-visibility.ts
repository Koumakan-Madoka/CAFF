const { replacePromptUserMessage } = require('./turn-state');

export function isPrivateOnlyMessage(message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  return Boolean(metadata && metadata.privateOnly);
}

function filterPrivateOnlyPromptMessages(messages: any, promptUserMessage: any) {
  const promptMessageId = promptUserMessage && promptUserMessage.id ? String(promptUserMessage.id) : '';

  return (Array.isArray(messages) ? messages : []).filter((message: any) => {
    if (!isPrivateOnlyMessage(message)) {
      return true;
    }

    return Boolean(promptMessageId && message && String(message.id) === promptMessageId);
  });
}

export function buildPromptMessages(messages: any, promptUserMessage: any, options: any = {}) {
  const snapshotMessageIds = options.snapshotMessageIds instanceof Set ? options.snapshotMessageIds : null;
  const currentTurnId = String(options.currentTurnId || '').trim();
  const shouldReplacePromptUserMessage = options.replacePromptUserMessage !== false;
  const visibleMessages = (Array.isArray(messages) ? messages : []).filter((message: any) => {
    if (!snapshotMessageIds) {
      return true;
    }

    const messageId = message && message.id ? String(message.id) : '';

    if (messageId && snapshotMessageIds.has(messageId)) {
      return true;
    }

    return Boolean(currentTurnId && message && String(message.turnId || '') === currentTurnId);
  });
  const promptMessages = shouldReplacePromptUserMessage
    ? replacePromptUserMessage(visibleMessages, promptUserMessage)
    : visibleMessages;

  return filterPrivateOnlyPromptMessages(promptMessages, promptUserMessage);
}

export function buildPromptSnapshotMessageIds(messages: any) {
  return new Set(
    (Array.isArray(messages) ? messages : [])
      .map((message: any) => String(message && message.id ? message.id : '').trim())
      .filter(Boolean)
  );
}
