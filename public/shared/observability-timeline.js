// @ts-check

(function registerObservabilityTimelineHelper() {
  const shared = window.CaffShared || (window.CaffShared = {});
  const MAX_RETAINED_EVENTS = 16;

  function normalizedEvents(value) {
    return (Array.isArray(value) ? value : []).filter(
      (event) => event && typeof event === 'object' && !Array.isArray(event)
    );
  }

  function retain(events, totalEventCount) {
    const source = normalizedEvents(events)
      .slice()
      .sort((left, right) => Number(left.timelineSequence || 0) - Number(right.timelineSequence || 0));
    const retained = source.length <= MAX_RETAINED_EVENTS
      ? source
      : [source[0], ...source.slice(-(MAX_RETAINED_EVENTS - 1))];
    const explicitTotal = Number(totalEventCount);
    const total = Math.max(Number.isFinite(explicitTotal) ? Math.round(explicitTotal) : source.length, source.length);
    return {
      events: retained,
      totalEventCount: total,
      retainedEventCount: retained.length,
      droppedEventCount: Math.max(0, total - retained.length),
      truncated: total > retained.length,
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
