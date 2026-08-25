export const DEFAULT_CONTEXT_SNAPSHOT_PAGE_LIMIT = 50;
export const MAX_CONTEXT_SNAPSHOT_PAGE_LIMIT = 100;
export const MAX_RETAINED_MODEL_USAGE_CALLS = 64;

function nonNegativeInteger(value: any, fallback = 0) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : fallback;
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
