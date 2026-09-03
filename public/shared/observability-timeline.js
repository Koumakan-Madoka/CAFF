// @ts-check

(function registerObservabilityTimelineHelper() {
  const shared = window.CaffShared || (window.CaffShared = {});
  const MAX_RETAINED_EVENTS = 16;

  function normalizedEvents(value) {
    return (Array.isArray(value) ? value : []).filter(
      (event) => event && typeof event === 'object' && !Array.isArray(event)
    );
  }

  function positiveInteger(value, fallback = 0) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
  }

  function timestampMillis(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
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

  function eventTimestampMillis(event) {
    for (const field of ['occurredAt', 'createdAt', 'timestamp']) {
      const timestamp = timestampMillis(event && event[field]);
      if (timestamp !== null) {
        return timestamp;
      }
    }
    return null;
  }

  function compareTimelineEvents(left, right, leftIndex = 0, rightIndex = 0) {
    const leftTimestamp = eventTimestampMillis(left);
    const rightTimestamp = eventTimestampMillis(right);
    if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
      return leftTimestamp - rightTimestamp;
    }

    const leftSequence = positiveInteger(left && left.timelineSequence, leftIndex + 1);
    const rightSequence = positiveInteger(right && right.timelineSequence, rightIndex + 1);
    return leftSequence - rightSequence || leftIndex - rightIndex;
  }

  function renumberChronologicalWindow(events, totalEventCount) {
    if (events.length === 0) return events;
    if (totalEventCount === events.length) {
      return events.map((event, index) => ({ ...event, timelineSequence: index + 1 }));
    }
    if (events.length === MAX_RETAINED_EVENTS) {
      const tailStart = Math.max(2, totalEventCount - (events.length - 1) + 1);
      return events.map((event, index) => ({
        ...event,
        timelineSequence: index === 0 ? 1 : tailStart + index - 1,
      }));
    }
    return events;
  }

  function retain(events, totalEventCount) {
    const source = normalizedEvents(events)
      .map((event, index) => ({ event, index }))
      .sort((left, right) => compareTimelineEvents(left.event, right.event, left.index, right.index))
      .map(({ event }) => event);
    const retained = source.length <= MAX_RETAINED_EVENTS
      ? source
      : [source[0], ...source.slice(-(MAX_RETAINED_EVENTS - 1))];
    const explicitTotal = Number(totalEventCount);
    const total = Math.max(Number.isFinite(explicitTotal) ? Math.round(explicitTotal) : source.length, source.length);
    const chronological = renumberChronologicalWindow(retained, total);
    return {
      events: chronological,
      totalEventCount: total,
      retainedEventCount: chronological.length,
      droppedEventCount: Math.max(0, total - chronological.length),
      truncated: total > chronological.length,
    };
  }

  function merge(currentEvents, incomingEvents, windowSummary) {
    const byId = new Map();
    normalizedEvents(currentEvents).concat(normalizedEvents(incomingEvents)).forEach((event) => {
      const eventId = String(event.eventId || '').trim();
      if (!eventId) return;
      byId.set(eventId, { ...(byId.get(eventId) || {}), ...event, eventId });
    });
    return retain(Array.from(byId.values()), windowSummary && windowSummary.totalEventCount);
  }

  shared.observabilityTimeline = {
    MAX_RETAINED_EVENTS,
    retain,
    merge,
  };
})();
