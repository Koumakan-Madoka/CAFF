export const DEFAULT_CONTEXT_SNAPSHOT_PAGE_LIMIT = 50;
export const MAX_CONTEXT_SNAPSHOT_PAGE_LIMIT = 100;
export const MAX_RETAINED_MODEL_USAGE_CALLS = 16;

function nonNegativeInteger(value: any, fallback = 0) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function projectContextSnapshotDelivery(snapshot: any) {
  const deliveryMode = String(snapshot && snapshot.deliveryMode || '').trim().toLowerCase();
  if (deliveryMode !== 'fresh' && deliveryMode !== 'resume') {
    return {};
  }

  const projected: any = { deliveryMode };
  const retained = snapshot && snapshot.retainedSessionPrefix;
  if (deliveryMode === 'resume' && retained && typeof retained === 'object' && !Array.isArray(retained)) {
    projected.retainedSessionPrefix = {
      sessionName: String(retained.sessionName || '').trim(),
      staticSegmentHash: String(retained.staticSegmentHash || '').trim(),
      cursorMessageId: String(retained.cursorMessageId || '').trim(),
      cursorMessageCount: nonNegativeInteger(retained.cursorMessageCount),
      cursorFirstMessageId: String(retained.cursorFirstMessageId || '').trim(),
      cursorMaxUpdatedAt: retained.cursorMaxUpdatedAt ? String(retained.cursorMaxUpdatedAt).trim() : null,
      lastReplyAt: String(retained.lastReplyAt || '').trim(),
    };
  }
  return projected;
}

export function buildStoredContextSnapshotSummary(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }

  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  return {
    schemaVersion: snapshot.schemaVersion || 1,
    snapshotId: String(snapshot.snapshotId || '').trim(),
    capturedAt: String(snapshot.capturedAt || '').trim(),
    conversationId: String(snapshot.conversationId || '').trim(),
    turnId: String(snapshot.turnId || '').trim(),
    messageId: String(snapshot.messageId || '').trim(),
    agentId: String(snapshot.agentId || '').trim(),
    agentName: String(snapshot.agentName || '').trim(),
    promptVersion: String(snapshot.promptVersion || '').trim(),
    ...projectContextSnapshotDelivery(snapshot),
    immutable: snapshot.immutable !== false,
    totalApproxTokens: nonNegativeInteger(snapshot.totalApproxTokens),
    totalByteSize: nonNegativeInteger(snapshot.totalByteSize),
    sectionCount: sections.length,
    sections: sections.map((section: any) => ({
      sectionKey: String(section && section.sectionKey || '').trim(),
      title: String(section && section.title || '').trim(),
      displayTitle: String(section && (section.displayTitle || section.title) || '').trim(),
      source: String(section && section.source || '').trim(),
      visibility: String(section && section.visibility || 'presence').trim() || 'presence',
      contentHash: String(section && section.contentHash || '').trim(),
      displayContentHash: String(section && section.displayContentHash || '').trim(),
      approxTokens: nonNegativeInteger(section && section.approxTokens),
      byteSize: nonNegativeInteger(section && section.byteSize),
      truncated: Boolean(section && section.truncated),
      truncationNote: String(section && section.truncationNote || '').trim(),
      redacted: Boolean(section && section.redacted),
      policyNote: String(section && section.policyNote || '').trim(),
      contentPreview: String(section && section.contentPreview || ''),
    })),
  };
}

export function retainModelUsageCalls(modelUsage: any) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return null;
  }

  const sourceCalls = (Array.isArray(modelUsage.calls) ? modelUsage.calls : [])
    .filter((call: any) => call && typeof call === 'object' && !Array.isArray(call));
  if (sourceCalls.length === 0) {
    return null;
  }

  const retainedCalls = sourceCalls.length <= MAX_RETAINED_MODEL_USAGE_CALLS
    ? sourceCalls
    : [sourceCalls[0], ...sourceCalls.slice(-(MAX_RETAINED_MODEL_USAGE_CALLS - 1))];
  const droppedCallCount = Math.max(0, sourceCalls.length - retainedCalls.length);

  return {
    modelCallCount: nonNegativeInteger(modelUsage.modelCallCount, sourceCalls.length),
    coldStartModelCallCount: nonNegativeInteger(modelUsage.coldStartModelCallCount),
    postColdModelCallCount: nonNegativeInteger(modelUsage.postColdModelCallCount),
    providerMissCount: nonNegativeInteger(modelUsage.providerMissCount),
    calls: retainedCalls,
    callsTruncated: droppedCallCount > 0,
    retainedCallCount: retainedCalls.length,
    droppedCallCount,
  };
}

export function buildLightweightContextSnapshotReference(snapshot: any) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }

  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  const sectionCount = nonNegativeInteger(snapshot.sectionCount, sections.length);
  return {
    schemaVersion: snapshot.schemaVersion || 1,
    snapshotId: String(snapshot.snapshotId || '').trim(),
    capturedAt: String(snapshot.capturedAt || '').trim(),
    conversationId: String(snapshot.conversationId || '').trim(),
    turnId: String(snapshot.turnId || '').trim(),
    messageId: String(snapshot.messageId || '').trim(),
    agentId: String(snapshot.agentId || '').trim(),
    agentName: String(snapshot.agentName || '').trim(),
    promptVersion: String(snapshot.promptVersion || '').trim(),
    ...projectContextSnapshotDelivery(snapshot),
    immutable: snapshot.immutable !== false,
    totalApproxTokens: nonNegativeInteger(snapshot.totalApproxTokens),
    totalByteSize: nonNegativeInteger(snapshot.totalByteSize),
    sectionCount,
  };
}

export function buildLightweightModelUsageSummary(modelUsage: any) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return null;
  }

  const retained = retainModelUsageCalls(modelUsage);
  if (retained) {
    return {
      modelCallCount: retained.modelCallCount,
      coldStartModelCallCount: retained.coldStartModelCallCount,
      postColdModelCallCount: retained.postColdModelCallCount,
      providerMissCount: retained.providerMissCount,
      callsTruncated: retained.callsTruncated,
      retainedCallCount: retained.retainedCallCount,
      droppedCallCount: retained.droppedCallCount,
    };
  }

  const hasSummary = [
    'modelCallCount',
    'coldStartModelCallCount',
    'postColdModelCallCount',
    'providerMissCount',
    'callsTruncated',
    'retainedCallCount',
    'droppedCallCount',
  ].some((key) => Object.prototype.hasOwnProperty.call(modelUsage, key));
  if (!hasSummary) {
    return null;
  }

  const modelCallCount = nonNegativeInteger(modelUsage.modelCallCount);
  const retainedCallCount = nonNegativeInteger(
    modelUsage.retainedCallCount,
    Math.min(modelCallCount, MAX_RETAINED_MODEL_USAGE_CALLS)
  );
  const droppedCallCount = nonNegativeInteger(
    modelUsage.droppedCallCount,
    Math.max(0, modelCallCount - retainedCallCount)
  );
  return {
    modelCallCount,
    coldStartModelCallCount: nonNegativeInteger(modelUsage.coldStartModelCallCount),
    postColdModelCallCount: nonNegativeInteger(modelUsage.postColdModelCallCount),
    providerMissCount: nonNegativeInteger(modelUsage.providerMissCount),
    callsTruncated: Boolean(modelUsage.callsTruncated) || droppedCallCount > 0,
    retainedCallCount,
    droppedCallCount,
  };
}

function normalizedMetadata(metadata: any) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
}

export function buildContractMessageMetadata(metadata: any, details: any = {}) {
  const projected = { ...normalizedMetadata(metadata) };

  if (Object.prototype.hasOwnProperty.call(details, 'contextSnapshot')) {
    const snapshotReference = buildLightweightContextSnapshotReference(details.contextSnapshot);
    if (snapshotReference) {
      projected.agentContextSnapshot = snapshotReference;
    } else {
      delete projected.agentContextSnapshot;
    }
  }

  if (Object.prototype.hasOwnProperty.call(details, 'modelUsage')) {
    const modelUsageSummary = buildLightweightModelUsageSummary(details.modelUsage);
    if (modelUsageSummary) {
      projected.modelUsage = modelUsageSummary;
    } else {
      delete projected.modelUsage;
    }
  }

  return projected;
}

export function projectMessageMetadataForTransport(metadata: any) {
  const source = normalizedMetadata(metadata);
  const projected = { ...source };

  if (Object.prototype.hasOwnProperty.call(source, 'agentContextSnapshot')) {
    const snapshotReference = buildLightweightContextSnapshotReference(source.agentContextSnapshot);
    if (snapshotReference) {
      projected.agentContextSnapshot = snapshotReference;
    } else {
      delete projected.agentContextSnapshot;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'modelUsage')) {
    const modelUsageSummary = buildLightweightModelUsageSummary(source.modelUsage);
    if (modelUsageSummary) {
      projected.modelUsage = modelUsageSummary;
    } else {
      delete projected.modelUsage;
    }
  }

  return projected;
}

export function projectMessageForTransport(message: any) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return message;
  }

  return {
    ...message,
    metadata: projectMessageMetadataForTransport(message.metadata),
  };
}

export function projectConversationMessageEventPayload(eventName: any, payload: any) {
  if (
    eventName !== 'conversation_message_created'
    && eventName !== 'conversation_message_updated'
  ) {
    return payload;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  return {
    ...payload,
    message: projectMessageForTransport(payload.message),
  };
}
