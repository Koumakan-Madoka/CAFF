// @ts-check

(function registerConversationDigestHelpers() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function metadataForConversation(conversation) {
    return conversation && conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : null;
  }

  function digestsForConversation(conversation) {
    const metadata = metadataForConversation(conversation);
    const digests = metadata && Array.isArray(metadata.conversationDigests) ? metadata.conversationDigests : [];

    return digests
      .map((digest) => {
        const id = String((digest && digest.id) || '').trim();
        const summary = String((digest && digest.summary) || '').trim();
        const createdAt = String((digest && digest.createdAt) || '').trim();

        if (!id || !summary || !createdAt) {
          return null;
        }

        return {
          ...digest,
          id,
          summary,
          createdAt,
          updatedAt: String((digest && digest.updatedAt) || createdAt).trim(),
          messageRange: digest && digest.messageRange && typeof digest.messageRange === 'object' ? digest.messageRange : {},
          facts: sectionItems(digest && digest.facts),
          decisions: sectionItems(digest && digest.decisions),
          openQuestions: sectionItems(digest && digest.openQuestions),
          nextActions: sectionItems(digest && digest.nextActions),
          artifacts: sectionItems(digest && digest.artifacts),
        };
      })
      .filter(Boolean);
  }

  function sectionItems(value) {
    return (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function latestDigest(conversation) {
    const digests = digestsForConversation(conversation);
    return digests.length > 0 ? digests[digests.length - 1] : null;
  }

  function digestCount(conversation) {
    return digestsForConversation(conversation).length;
  }

  function formatDigestStatus(conversation) {
    const count = digestCount(conversation);

    if (count === 0) {
      return '当前没有会话摘要。使用 /digest 生成一条。';
    }

    return `会话摘要：${count} 条长期记忆条目`;
  }

  function messageRangeText(digest) {
    const range = digest && digest.messageRange && typeof digest.messageRange === 'object' ? digest.messageRange : {};
    const count = Number.parseInt(String(range.messageCount || '0'), 10) || 0;
    return count > 0 ? `${count} 条公开消息` : '';
  }

  shared.conversationDigest = {
    digestsForConversation,
    latestDigest,
    digestCount,
    formatDigestStatus,
    messageRangeText,
    sectionItems,
  };
})();
