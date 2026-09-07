export const MAX_RETAINED_OBSERVABILITY_EVENTS = 16;
const OBSERVABILITY_STATE = Symbol.for('caff.observabilityTimelineState');

function nonNegativeInteger(value: any, fallback = 0) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function positiveInteger(value: any, fallback = 0) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizedEvents(value: any) {
  return (Array.isArray(value) ? value : []).filter(
    (event) => event && typeof event === 'object' && !Array.isArray(event)
  );
}

function timestampMillis(value: any) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Provider timestamps are normally epoch milliseconds. Also accept epoch
    // seconds from older/alternate producers so mixed model/tool events remain
    // comparable with ISO timestamps.
    return Math.abs(value) < 100000000000 ? value * 1000 : value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return timestampMillis(numeric);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventTimestampMillis(event: any) {
  for (const field of ['occurredAt', 'createdAt', 'timestamp']) {
    const timestamp = timestampMillis(event && event[field]);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

function compareTimelineEvents(left: any, right: any, leftIndex = 0, rightIndex = 0) {
  const leftTimestamp = eventTimestampMillis(left);
  const rightTimestamp = eventTimestampMillis(right);

  // Only compare timestamps when both sides have trustworthy evidence. A
  // missing timestamp must fall back to the original sequence rather than
  // silently jumping across a known event.
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  const leftSequence = positiveInteger(left && left.timelineSequence, leftIndex + 1);
  const rightSequence = positiveInteger(right && right.timelineSequence, rightIndex + 1);
  return leftSequence - rightSequence || leftIndex - rightIndex;
}

function renumberChronologicalWindow(events: any[], totalEventCount: number) {
  if (events.length === 0) {
    return events;
  }

  // A complete, unbounded set can use a contiguous chronological sequence.
  if (totalEventCount === events.length) {
    return events.map((event, index) => ({ ...event, timelineSequence: index + 1 }));
  }

  // For the bounded first-one-plus-latest-fifteen window, preserve the omitted
  // middle gap while assigning the retained events their chronological slots.
  if (events.length === MAX_RETAINED_OBSERVABILITY_EVENTS) {
    const tailStart = Math.max(2, totalEventCount - (events.length - 1) + 1);
    return events.map((event, index) => ({
      ...event,
      timelineSequence: index === 0 ? 1 : tailStart + index - 1,
    }));
  }

  return events;
}

function isActiveToolStatus(value: any) {
  const status = String(value || '').trim().toLowerCase();
  return status === 'running' || status === 'queued' || status === 'pending';
}

export function retainObservabilityEvents(events: any, totalEventCount?: any) {
  const sourceEvents = normalizedEvents(events)
    .map((event, index) => ({ event, index }))
    .sort((left, right) => compareTimelineEvents(left.event, right.event, left.index, right.index))
    .map(({ event }) => event);
  const normalizedTotal = Math.max(nonNegativeInteger(totalEventCount, sourceEvents.length), sourceEvents.length);
  const retainedEvents = sourceEvents.length <= MAX_RETAINED_OBSERVABILITY_EVENTS
    ? sourceEvents
    : [sourceEvents[0], ...sourceEvents.slice(-(MAX_RETAINED_OBSERVABILITY_EVENTS - 1))];
  const chronologicalEvents = renumberChronologicalWindow(retainedEvents, normalizedTotal);
  const droppedEventCount = Math.max(0, normalizedTotal - chronologicalEvents.length);

  return {
    events: chronologicalEvents,
    totalEventCount: normalizedTotal,
    retainedEventCount: chronologicalEvents.length,
    droppedEventCount,
    truncated: droppedEventCount > 0,
  };
}

export function normalizeObservabilityTimeline(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const retained = retainObservabilityEvents(value.events, value.totalEventCount);
  return {
    schemaVersion: 1,
    ...retained,
    modelCallCount: nonNegativeInteger(value.modelCallCount),
    coldStartModelCallCount: nonNegativeInteger(value.coldStartModelCallCount),
    postColdModelCallCount: nonNegativeInteger(value.postColdModelCallCount),
    providerMissCount: nonNegativeInteger(value.providerMissCount),
    toolExecutionCount: nonNegativeInteger(value.toolExecutionCount),
    failedToolExecutionCount: nonNegativeInteger(value.failedToolExecutionCount),
    totalToolDurationMs: nonNegativeInteger(value.totalToolDurationMs),
  };
}

export function createObservabilityTimelineState() {
  return {
    schemaVersion: 1,
    nextTimelineSequence: 1,
    nextModelCallSequence: 1,
    totalEventCount: 0,
    modelCallCount: 0,
    coldStartModelCallCount: 0,
    postColdModelCallCount: 0,
    providerMissCount: 0,
    toolExecutionCount: 0,
    failedToolExecutionCount: 0,
    totalToolDurationMs: 0,
    events: [] as any[],
    activeToolEvents: new Map<string, any>(),
  };
}

export function ensureObservabilityTimelineState(owner: any) {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) {
    return createObservabilityTimelineState();
  }

  if (!owner[OBSERVABILITY_STATE]) {
    Object.defineProperty(owner, OBSERVABILITY_STATE, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: createObservabilityTimelineState(),
    });
  }

  return owner[OBSERVABILITY_STATE];
}

function retainedEventIndex(state: any, eventId: string) {
  return Array.isArray(state.events)
    ? state.events.findIndex((event: any) => event && event.eventId === eventId)
    : -1;
}

function projectStateWindow(state: any) {
  const retained = retainObservabilityEvents(state.events, state.totalEventCount);
  state.events = retained.events;
  return retained;
}

export function upsertObservabilityEvent(state: any, rawEvent: any) {
  if (!state || !rawEvent || typeof rawEvent !== 'object') {
    return null;
  }

  const eventType = rawEvent.eventType === 'model_call' ? 'model_call' : 'tool_execution';
  const fallbackId = eventType === 'model_call'
    ? `model-call:${positiveInteger(rawEvent.modelCallSequence, state.nextModelCallSequence)}`
    : `tool:${String(rawEvent.stepId || state.nextTimelineSequence)}`;
  const eventId = String(rawEvent.eventId || fallbackId).trim();
  if (!eventId) {
    return null;
  }

  const existingIndex = retainedEventIndex(state, eventId);
  const activeToolEvent = eventType === 'tool_execution' && state.activeToolEvents instanceof Map
    ? state.activeToolEvents.get(eventId) || null
    : null;
  const existing = existingIndex >= 0 ? state.events[existingIndex] : activeToolEvent;
  const isNew = !existing;
  const timelineSequence = existing
    ? positiveInteger(existing.timelineSequence)
    : positiveInteger(rawEvent.timelineSequence, state.nextTimelineSequence);
  const event = {
    ...(existing || {}),
    ...rawEvent,
    eventId,
    eventType,
    timelineSequence,
  };

  if (isNew) {
    state.totalEventCount += 1;
    state.nextTimelineSequence = Math.max(state.nextTimelineSequence, timelineSequence + 1);
    if (eventType === 'model_call') {
      state.modelCallCount += 1;
      if (event.isColdStart || event.coldStart) {
        state.coldStartModelCallCount += 1;
      } else {
        state.postColdModelCallCount += 1;
      }
      if (event.providerMiss) {
        state.providerMissCount += 1;
      }
    } else {
      state.toolExecutionCount += 1;
      if (event.status === 'failed') {
        state.failedToolExecutionCount += 1;
      }
      state.totalToolDurationMs += nonNegativeInteger(event.durationMs);
    }
    state.events.push(event);
  } else {
    if (eventType === 'tool_execution') {
      if (existing.status !== 'failed' && event.status === 'failed') {
        state.failedToolExecutionCount += 1;
      }
      const priorDuration = nonNegativeInteger(existing.durationMs);
      const nextDuration = nonNegativeInteger(event.durationMs);
      state.totalToolDurationMs += Math.max(0, nextDuration - priorDuration);
    }
    if (existingIndex >= 0) {
      state.events[existingIndex] = event;
    }
  }

  if (eventType === 'tool_execution' && state.activeToolEvents instanceof Map) {
    if (isActiveToolStatus(event.status)) {
      state.activeToolEvents.set(eventId, event);
    } else {
      state.activeToolEvents.delete(eventId);
    }
  }

  projectStateWindow(state);
  return event;
}

export function createModelCallObservabilityEvent(state: any, input: any = {}) {
  const modelCallSequence = positiveInteger(input.modelCallSequence, state.nextModelCallSequence);
  state.nextModelCallSequence = Math.max(state.nextModelCallSequence, modelCallSequence + 1);
  const tokenUsage = input.tokenUsage && typeof input.tokenUsage === 'object'
    ? input.tokenUsage
    : null;
  if (!tokenUsage) {
    return null;
  }
  const isColdStart = modelCallSequence === 1;
  const providerMiss = !isColdStart
    && tokenUsage.cacheReadTokens === 0
    && (tokenUsage.uncachedInputTokens || 0) > 0;
  const responseId = String(input.responseId || '').trim();
  const messageKey = String(input.messageKey || '').trim();

  return upsertObservabilityEvent(state, {
    eventId: `model-call:${responseId || messageKey || modelCallSequence}`,
    eventType: 'model_call',
    modelCallSequence,
    sequence: modelCallSequence,
    key: messageKey,
    responseId,
    stopReason: String(input.stopReason || '').trim(),
    timestamp: input.timestamp === undefined ? null : input.timestamp,
    coldStart: isColdStart,
    isColdStart,
    providerMiss,
    tokenUsage,
  });
}

export function createToolObservabilityEvent(state: any, step: any) {
  if (!step || typeof step !== 'object') {
    return null;
  }
  const kind = String(step.kind || 'session').trim() || 'session';
  const stepId = String(step.stepId || '').trim();
  if (!stepId) {
    return null;
  }
  return upsertObservabilityEvent(state, {
    ...step,
    eventId: `tool:${kind}:${stepId.replace(/^session-/u, '')}`,
    eventType: 'tool_execution',
  });
}

export function finalizeObservabilityToolEvents(state: any, failed = false) {
  if (!state || !Array.isArray(state.events)) {
    return;
  }
  const activeToolEvents = state.activeToolEvents instanceof Map
    ? Array.from(state.activeToolEvents.values()).filter((event: any) => event && isActiveToolStatus(event.status))
    : [];
  state.events = state.events.map((event: any) => {
    if (!event || event.eventType !== 'tool_execution') {
      return event;
    }
    if (!isActiveToolStatus(event.status)) {
      return event;
    }
    return {
      ...event,
      status: failed ? 'failed' : event.kind === 'bridge' ? 'succeeded' : 'observed',
    };
  });
  if (failed) {
    state.failedToolExecutionCount = nonNegativeInteger(state.failedToolExecutionCount) + activeToolEvents.length;
  }
  if (state.activeToolEvents instanceof Map) {
    state.activeToolEvents.clear();
  }
}

export function snapshotObservabilityTimeline(state: any) {
  return normalizeObservabilityTimeline({
    ...state,
    ...retainObservabilityEvents(state && state.events, state && state.totalEventCount),
  });
}
