// @ts-check

(function registerSummaryMemoryHelpers() {
  const shared = window.CaffShared || (window.CaffShared = {});

  function sectionItems(value) {
    return (Array.isArray(value) ? value : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function normalizeResult(result) {
    if (!result || typeof result !== 'object') {
      return null;
    }

    const id = String(result.id || '').trim();
    const sourceDigestId = String(result.sourceDigestId || '').trim();
    const summary = String(result.summary || '').trim();

    if (!id || !summary) {
      return null;
    }

    const messageRange = result.messageRange && typeof result.messageRange === 'object' ? result.messageRange : {};

    return {
      ...result,
      id,
      sourceDigestId,
      sourceKind: String(result.sourceKind || 'entry').trim() || 'entry',
      conversationId: String(result.conversationId || '').trim(),
      conversationTitle: String(result.conversationTitle || '').trim(),
      taskName: String(result.taskName || '').trim(),
      createdBy: String(result.createdBy || '').trim(),
      summary,
      facts: sectionItems(result.facts),
      decisions: sectionItems(result.decisions),
      openQuestions: sectionItems(result.openQuestions),
      nextActions: sectionItems(result.nextActions),
      artifacts: sectionItems(result.artifacts),
      triggerReason: String(result.triggerReason || '').trim(),
      messageRange: {
        fromMessageId: String(messageRange.fromMessageId || '').trim(),
        toMessageId: String(messageRange.toMessageId || '').trim(),
        messageCount: Number.parseInt(String(messageRange.messageCount || '0'), 10) || 0,
      },
      segmentCreatedAt: String(result.segmentCreatedAt || result.createdAt || '').trim(),
      segmentUpdatedAt: String(result.segmentUpdatedAt || result.updatedAt || '').trim(),
      matchedTerms: sectionItems(result.matchedTerms).slice(0, 8),
      createdAt: String(result.createdAt || '').trim(),
      updatedAt: String(result.updatedAt || '').trim(),
    };
  }

  function resultsFromPayload(payload) {
    return (Array.isArray(payload && payload.results) ? payload.results : [])
      .map(normalizeResult)
      .filter(Boolean);
  }

  function diagnosticsFromPayload(payload) {
    return (Array.isArray(payload && payload.diagnostics) ? payload.diagnostics : [])
      .map((diagnostic) => String((diagnostic && diagnostic.message) || '').trim())
      .filter(Boolean);
  }

  function resultTitle(result) {
    return result.conversationTitle || result.conversationId || '历史记忆';
  }

  function kindLabel(result) {
    return result.sourceKind === 'rollup' ? '压缩总摘要' : '摘要段';
  }

  function messageRangeText(result) {
    const count = Number.parseInt(String(result && result.messageRange && result.messageRange.messageCount || '0'), 10) || 0;
    return count > 0 ? `${count} 条公开消息` : '';
  }

  shared.summaryMemory = {
    diagnosticsFromPayload,
    kindLabel,
    messageRangeText,
    resultTitle,
    resultsFromPayload,
    sectionItems,
  };
})();
