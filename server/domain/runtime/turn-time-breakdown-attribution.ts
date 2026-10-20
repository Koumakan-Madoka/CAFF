// Turn time breakdown — §3 time attribution. Pure functions over classified
// steps: parallel steps are merged by interval union (never double-counted),
// cross-category overlaps are sliced by fixed priority, and `thinking` is
// the turn span minus all tool intervals minus model-side error intervals.
//
// Priority (contract §3): test > write > build-check > read >
// process-report > exception-retry > unclassified. Model error intervals
// (§2 source b) are disjoint from tool intervals by construction, so their
// position here is defensive only.

export const ATTRIBUTION_PRIORITY = [
  'test',
  'write',
  'build-check',
  'read',
  'process-report',
  'exception-retry',
  'unclassified',
];

const PRIORITY_INDEX = new Map(ATTRIBUTION_PRIORITY.map((category, index) => [category, index]));

function priorityOf(category: any) {
  const index = PRIORITY_INDEX.get(String(category || ''));

  return index === undefined ? PRIORITY_INDEX.get('unclassified') : index;
}

function toFiniteMs(value: any) {
  // Number(null) === 0 would silently pin intervals to the epoch — treat
  // null/undefined/empty as absent before coercing.
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = Number(value);

  return Number.isFinite(num) ? num : null;
}

// Collect [startMs, endMs] tool intervals. Steps without a resolvable end
// (durationMs NULL per contract §4) contribute nothing to the union.
function collectIntervals(steps: any[]) {
  const intervals: Array<{ startMs: number; endMs: number; category: string }> = [];

  for (const step of steps || []) {
    const startMs = toFiniteMs(step && (step.startedAtMs !== undefined ? step.startedAtMs : step.startMs));
    let endMs = toFiniteMs(step && (step.endedAtMs !== undefined ? step.endedAtMs : step.endMs));

    if (startMs === null && endMs === null) {
      continue;
    }

    if (endMs === null) {
      continue; // open interval: contributes nothing (contract §4)
    }

    if (startMs === null || endMs < startMs) {
      continue;
    }

    intervals.push({ startMs, endMs, category: String(step.category || 'unclassified') });
  }

  return intervals;
}

// Sweep-line over all interval boundaries: each elementary segment is
// attributed to the highest-priority category present in it.
function attributeByUnion(intervals: Array<{ startMs: number; endMs: number; category: string }>) {
  const boundaries = new Set<number>();

  for (const interval of intervals) {
    boundaries.add(interval.startMs);
    boundaries.add(interval.endMs);
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const categoryMs: Record<string, number> = {};
  let unionMs = 0;

  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];

    if (end <= start) {
      continue;
    }

    let best: string | null = null;
    let bestPriority = Infinity;

    for (const interval of intervals) {
      if (interval.startMs <= start && interval.endMs >= end) {
        const priority = priorityOf(interval.category) as number;

        if (priority < bestPriority) {
          bestPriority = priority;
          best = interval.category;
        }
      }
    }

    if (best) {
      categoryMs[best] = (categoryMs[best] || 0) + (end - start);
      unionMs += end - start;
    }
  }

  return { categoryMs, unionMs };
}

// §2(b): model error intervals. Each error event spans from the end of the
// previous trace event (step end or start) to the error row's timestamp.
function collectErrorIntervals(errorEvents: any[], steps: any[], turnStartMs: number | null) {
  const intervals: Array<{ startMs: number; endMs: number; category: string }> = [];

  for (const event of errorEvents || []) {
    const endMs = toFiniteMs(event && (event.timestampMs !== undefined ? event.timestampMs : event.endMs));

    if (endMs === null) {
      continue;
    }

    let startMs = turnStartMs;

    for (const step of steps || []) {
      const candidates = [
        toFiniteMs(step && (step.endedAtMs !== undefined ? step.endedAtMs : step.endMs)),
        toFiniteMs(step && (step.startedAtMs !== undefined ? step.startedAtMs : step.startMs)),
      ];

      for (const candidate of candidates) {
        if (candidate !== null && candidate < endMs && (startMs === null || candidate > startMs)) {
          startMs = candidate;
        }
      }
    }

    if (startMs === null || endMs <= startMs) {
      continue;
    }

    intervals.push({ startMs, endMs, category: 'exception-retry' });
  }

  return intervals;
}

// Compute the per-category wall-clock breakdown and turn-level metrics for
// one turn. steps: classified rows (category, startedAtMs/endedAtMs or
// durationMs, runKind/runFailed/testRunCounts). errorEvents: §2(b) model
// error timestamps. Turn span: first trace event → last event (or "now"
// for a live turn, passed in by the caller).
export function computeTurnAttribution(options: any = {}) {
  const steps = Array.isArray(options.steps) ? options.steps : [];
  const errorEvents = Array.isArray(options.errorEvents) ? options.errorEvents : [];
  const toolIntervals = collectIntervals(steps);
  const errorIntervals = collectErrorIntervals(errorEvents, steps, toFiniteMs(options.turnStartedAtMs));
  // One sweep over tool + error intervals: error intervals (§2 source b) are
  // disjoint from tool intervals by construction, and any residual overlap
  // (clock skew) loses to every tool category by priority.
  const attribution = attributeByUnion([...toolIntervals, ...errorIntervals]);
  const categoryMs: Record<string, number> = { ...attribution.categoryMs };

  // Turn span: explicit bounds win; otherwise derive from step extremes.
  let turnStartMs = toFiniteMs(options.turnStartedAtMs);
  let turnEndMs = toFiniteMs(options.turnEndedAtMs);

  if (turnStartMs === null) {
    for (const interval of [...toolIntervals, ...errorIntervals]) {
      if (turnStartMs === null || interval.startMs < turnStartMs) {
        turnStartMs = interval.startMs;
      }
    }
  }

  if (turnEndMs === null) {
    for (const interval of [...toolIntervals, ...errorIntervals]) {
      if (turnEndMs === null || interval.endMs > turnEndMs) {
        turnEndMs = interval.endMs;
      }
    }
  }

  const turnSpanMs = turnStartMs !== null && turnEndMs !== null && turnEndMs > turnStartMs
    ? turnEndMs - turnStartMs
    : 0;

  categoryMs.thinking = Math.max(0, turnSpanMs - attribution.unionMs);

  // Metrics (§2): firstWriteMs, full regression counters.
  let firstWriteMs = null;

  for (const step of steps) {
    if (String(step && step.category) !== 'write') {
      continue;
    }

    const startMs = toFiniteMs(step && (step.startedAtMs !== undefined ? step.startedAtMs : step.startMs));

    if (startMs === null || turnStartMs === null) {
      continue;
    }

    const offset = startMs - turnStartMs;

    if (firstWriteMs === null || offset < firstWriteMs) {
      firstWriteMs = offset;
    }
  }

  let fullRunCount = 0;
  let fullRunFailCount = 0;

  for (const step of steps) {
    if (String(step && step.category) !== 'test') {
      continue;
    }

    const counts = step && step.testRunCounts && typeof step.testRunCounts === 'object' ? step.testRunCounts : null;
    const full = counts && Number.isFinite(counts.full)
      ? counts.full
      : (step.runKind === 'full-regression' ? 1 : 0);

    fullRunCount += full;

    if (full > 0 && (step.runFailed === true || step.run_failed === 1)) {
      fullRunFailCount += 1;
    }
  }

  return {
    categoryMs,
    turnStartedAtMs: turnStartMs,
    turnEndedAtMs: turnEndMs,
    turnSpanMs,
    metrics: {
      firstWriteMs,
      fullRunCount,
      fullRunFailCount,
    },
  };
}
