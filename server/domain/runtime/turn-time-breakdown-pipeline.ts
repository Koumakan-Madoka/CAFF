// Turn time breakdown — §8 real-time pipeline. The turn path (agent
// executor pi_event hook, agent-tool-bridge invocations) only ENQUEUES:
// a synchronous array push plus an unref'd drain timer, so classification
// and sqlite writes never block the agent's turn. A serial worker drains
// the queue: rules first, JEV-needed steps are stored as unclassified +
// pending and resolved asynchronously in place.
//
// Failure contract (§6/§11): nothing here ever throws into the turn path;
// JEV timeout/error/low-confidence/disabled all land on honest
// `unclassified` rows with a `jevStatus`, and queue overflow drops
// classification (counted) while the underlying event stays in
// a2a_task_events — lazy backfill (§9) repairs the gap on next view.

import { computeTurnAttribution } from './turn-time-breakdown-attribution';
import { createTurnRuleClassifier, detectTestFailure } from './turn-time-breakdown';
import { createJevClassifier, truncateStepOutput } from './turn-time-breakdown-jev';

const DEFAULT_QUEUE_CAP = 256;

function toIso(msValue: any) {
  const num = Number(msValue);

  return Number.isFinite(num) && num > 0 ? new Date(num).toISOString() : null;
}

function fromIso(value: any) {
  const parsed = Date.parse(String(value || ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function defaultLogger() {
  return {
    warn(...args: any[]) {
      console.warn(...args);
    },
  };
}

export function createTurnTimeBreakdownPipeline(options: any = {}) {
  const repository = options.repository || null;
  const queueCap = Number.isSafeInteger(options.queueCap) && options.queueCap > 0 ? options.queueCap : DEFAULT_QUEUE_CAP;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const logger = options.logger || defaultLogger();
  const resolveJevEnabled = typeof options.resolveJevEnabled === 'function'
    ? options.resolveJevEnabled
    : () => false;
  const createJevClient = typeof options.createJevClient === 'function'
    ? options.createJevClient
    : () => null;

  const queue: any[] = [];
  const taskStates = new Map<string, any>();
  const pendingAsync = new Set<Promise<any>>();
  let drainTimer: any = null;
  let droppedCount = 0;
  let jevClient: any = null;
  let jevClientResolved = false;

  function resolveSharedJevClient() {
    if (!jevClientResolved) {
      jevClientResolved = true;

      try {
        jevClient = createJevClient();
      } catch (error: any) {
        logger.warn('[turn-time-breakdown] JEV client construction failed:', error && error.message ? error.message : error);
        jevClient = null;
      }
    }

    return jevClient;
  }

  // One JEV classifier per task state, sharing the dedicated client and the
  // sqlite-backed cache adapter (§6: dedicated instance, never the bridge's).
  function resolveJevClassifier(state: any) {
    if (state.jevClassifier) {
      return state.jevClassifier;
    }

    if (!state.jevEnabled) {
      return null;
    }

    const client = resolveSharedJevClient();

    state.jevClassifier = createJevClassifier({
      client,
      cache: repository
        ? {
            get: (key: any) => repository.getJevCacheEntry(key),
            set: (key: any, entry: any) => repository.setJevCacheEntry(key, entry),
          }
        : null,
      enabled: Boolean(client),
    });

    return state.jevClassifier;
  }

  function ensureTaskState(input: any) {
    const taskId = String(input && input.taskId ? input.taskId : '').trim();

    if (!taskId) {
      return null;
    }

    let state = taskStates.get(taskId);

    if (!state) {
      let jevEnabled = false;

      try {
        jevEnabled = resolveJevEnabled({
          taskId,
          messageId: input.messageId || null,
          conversationId: input.conversationId || null,
        }) === true;
      } catch {
        jevEnabled = false;
      }

      state = {
        taskId,
        messageId: input.messageId ? String(input.messageId) : null,
        conversationId: input.conversationId ? String(input.conversationId) : '',
        classifier: createTurnRuleClassifier(),
        jevEnabled,
        jevClassifier: null,
        errorEvents: [] as any[],
        // Anchored by the first pi event of the turn (§8 turn-start marker):
        // the first tool step can start well after the trace's first event
        // (model thinking), which would otherwise eat into the span.
        turnStartedAtMs: null,
        anonymousStepOrdinal: 0,
        completed: false,
      };
      taskStates.set(taskId, state);
    } else {
      if (!state.messageId && input.messageId) {
        state.messageId = String(input.messageId);
      }

      if (!state.conversationId && input.conversationId) {
        state.conversationId = String(input.conversationId);
      }
    }

    return state;
  }

  function summarizeTask(state: any, terminal: any = null) {
    if (!repository || !state.messageId) {
      return;
    }

    const rows = repository.listSteps(state.taskId);
    const steps = rows.map((row: any) => ({
      category: row.category,
      startedAtMs: fromIso(row.started_at),
      endedAtMs: fromIso(row.ended_at),
      runKind: row.run_kind,
      runFailed: row.run_failed === 1,
      testRunCounts: Number.isFinite(row.run_count_full) || Number.isFinite(row.run_count_targeted)
        ? {
            full: Number.isFinite(row.run_count_full) ? row.run_count_full : 0,
            targeted: Number.isFinite(row.run_count_targeted) ? row.run_count_targeted : 0,
          }
        : null,
    }));
    const existing = repository.getSummary(state.messageId);
    const nowMs = now();
    // A terminal summary keeps its sealed span end on late updates (e.g. an
    // async JEV resolution landing after completion) — otherwise "now"
    // would stretch thinking across the gap since the turn actually ended.
    const existingTerminal = Boolean(existing && existing.status && existing.status !== 'live');
    const sealedEndMs = existingTerminal && existing.turnEndedAt ? fromIso(existing.turnEndedAt) : null;
    const attribution = computeTurnAttribution({
      steps,
      errorEvents: state.errorEvents,
      // The §8 turn-start marker (first pi event) wins over step extremes;
      // a stored value (e.g. from the §9 full reparse) is the fallback.
      // Live turns account thinking up to "now" (contract §3).
      turnStartedAtMs: Number.isFinite(state.turnStartedAtMs)
        ? state.turnStartedAtMs
        : (existing && existing.turnStartedAt ? fromIso(existing.turnStartedAt) : null),
      turnEndedAtMs: terminal
        ? (Number.isFinite(terminal.endedAtMs) ? terminal.endedAtMs : nowMs)
        : sealedEndMs !== null
          ? sealedEndMs
          : nowMs,
    });
    const nextStatus = terminal
      ? terminal.status
      : (existing && existing.status) || 'live';
    const metrics = {
      ...(existing && existing.metrics ? existing.metrics : {}),
      ...attribution.metrics,
      ...(terminal && terminal.metrics ? terminal.metrics : {}),
    };

    repository.upsertSummary({
      messageId: state.messageId,
      taskId: state.taskId,
      conversationId: state.conversationId,
      status: nextStatus,
      turnStartedAt: toIso(attribution.turnStartedAtMs),
      turnEndedAt: terminal
        ? toIso(attribution.turnEndedAtMs)
        : (existing && existing.turnEndedAt) || (existingTerminal ? toIso(attribution.turnEndedAtMs) : null),
      categoryMs: attribution.categoryMs,
      metrics,
      parseOffset: existing ? existing.parseOffset : null,
      assistantCount: existing ? existing.assistantCount : null,
      computedAt: toIso(nowMs),
    });
  }

  function trackAsync(promise: Promise<any>) {
    pendingAsync.add(promise);

    const release = () => {
      pendingAsync.delete(promise);
    };

    promise.then(release, release);
  }

  // JEV resolution shared by the worker and the §9 backfill: upsert the
  // resolved row in place, feed writes back to the rule classifier
  // (cold-start flip), and refresh the live summary. Never rejects.
  function resolveStepWithJev(state: any, stepRow: any) {
    const classifier = resolveJevClassifier(state);

    if (!classifier || !classifier.enabled) {
      return Promise.resolve(false);
    }

    const promise = classifier
      .classifyStep({
        toolName: stepRow.toolName,
        args: stepRow.args,
        output: stepRow.output,
        isError: stepRow.isError,
        durationMs: stepRow.durationMs,
      })
      .then((result: any) => {
        if (!result || !result.category) {
          return false;
        }

        repository.upsertStep({
          taskId: state.taskId,
          messageId: state.messageId,
          stepKey: stepRow.stepKey,
          toolName: stepRow.toolName,
          category: result.category,
          subcategory: result.subcategory || null,
          classifiedBy: result.classifiedBy,
          jevStatus: result.jevStatus,
          confidence: result.confidence,
          startedAt: stepRow.startedAt,
          endedAt: stepRow.endedAt,
          durationMs: stepRow.durationMs,
          runKind: result.runKind || null,
          // JEV answers carry no failure signal; derive it from the output
          // fingerprint so fullRunFailCount stays honest.
          runFailed: result.category === 'test'
            ? detectTestFailure(stepRow.output, stepRow.isError)
            : null,
        });

        if (result.category === 'write') {
          state.classifier.noteExternalCategory('write');
        }

        summarizeTask(state);
        return true;
      })
      .catch((error: any) => {
        // §6: classification never rejects into the turn path. Log the code
        // so budget exhaustion (typesafe_budget_exceeded) stays visible.
        const code = error && error.code ? error.code : 'unknown';

        logger.warn('[turn-time-breakdown] JEV resolution failed:', code);

        try {
          repository.upsertStep({
            taskId: state.taskId,
            messageId: state.messageId,
            stepKey: stepRow.stepKey,
            toolName: stepRow.toolName,
            category: 'unclassified',
            subcategory: null,
            classifiedBy: 'unclassified',
            jevStatus: 'error',
            confidence: null,
            startedAt: stepRow.startedAt,
            endedAt: stepRow.endedAt,
            durationMs: stepRow.durationMs,
          });
        } catch {}

        return false;
      });

    trackAsync(promise);

    return promise;
  }

  function processTurnStart(input: any) {
    const state = ensureTaskState(input);

    if (!state) {
      return;
    }

    const startedAtMs = Number.isFinite(input.startedAtMs) ? input.startedAtMs : null;

    if (startedAtMs !== null && (state.turnStartedAtMs === null || startedAtMs < state.turnStartedAtMs)) {
      state.turnStartedAtMs = startedAtMs;
    }

    // Creates the live summary row even before the first tool step, so an
    // in-progress turn is refreshable from its true start (AC1).
    summarizeTask(state);
  }

  function processStep(input: any) {
    const state = ensureTaskState(input);

    if (!state || !repository) {
      return;
    }

    const step = input.step || {};
    const startedAtMs = Number.isFinite(step.startedAtMs) ? step.startedAtMs : null;
    const endedAtMs = Number.isFinite(step.endedAtMs) ? step.endedAtMs : null;
    let stepKey = String(step.stepKey || step.toolCallId || '').trim();

    if (!stepKey) {
      // pi always sends a toolCallId; this fallback exists for defensive
      // completeness and must still be unique per step (contract §7:
      // toolName + ordinal), so anonymous steps never overwrite each other.
      state.anonymousStepOrdinal = (state.anonymousStepOrdinal || 0) + 1;
      stepKey = `${step.toolName || 'tool'}:live:${state.anonymousStepOrdinal}`;
    }
    const durationMs = startedAtMs !== null && endedAtMs !== null && endedAtMs >= startedAtMs
      ? endedAtMs - startedAtMs
      : null;
    const classified = state.classifier.classify({
      toolName: step.toolName,
      args: step.args,
      output: step.output,
      isError: step.isError === true,
    });

    const baseRow = {
      taskId: state.taskId,
      messageId: state.messageId,
      stepKey,
      toolName: String(step.toolName || 'tool'),
      // A start-less step (missing tool_execution_start) anchors at its end
      // with a NULL duration — open intervals never silently extend (§4).
      startedAt: toIso(startedAtMs) || toIso(endedAtMs) || toIso(now()),
      endedAt: toIso(endedAtMs),
      durationMs,
      output: step.output,
      isError: step.isError === true,
      args: step.args,
    };

    if (classified) {
      repository.upsertStep({
        ...baseRow,
        category: classified.category,
        subcategory: classified.subcategory || null,
        classifiedBy: classified.classifiedBy || 'rules',
        jevStatus: null,
        confidence: null,
        runKind: classified.runKind || null,
        runFailed: classified.runFailed === true ? true : classified.category === 'test' ? false : null,
        testRunCounts: classified.testRunCounts || null,
      });
      summarizeTask(state);
      return;
    }

    // §8: JEV-needed steps are stored unclassified + pending first, then
    // resolved asynchronously and updated in place. payload_json keeps the
    // classifier input so a later pass can retry timeout/error steps
    // without re-parsing the session (§6).
    repository.upsertStep({
      ...baseRow,
      category: 'unclassified',
      subcategory: null,
      classifiedBy: 'unclassified',
      jevStatus: state.jevEnabled ? 'pending' : 'disabled',
      confidence: null,
      runKind: null,
      runFailed: null,
      payloadJson: JSON.stringify({
        args: baseRow.args !== undefined ? baseRow.args : null,
        output: truncateStepOutput(baseRow.output),
      }),
    });
    summarizeTask(state);

    if (state.jevEnabled) {
      resolveStepWithJev(state, baseRow);
    }
  }

  function processErrorEvent(input: any) {
    const state = ensureTaskState(input);

    if (!state) {
      return;
    }

    state.errorEvents.push({ timestampMs: Number.isFinite(input.timestampMs) ? input.timestampMs : now() });
    summarizeTask(state);
  }

  function processComplete(input: any) {
    const state = ensureTaskState(input);

    if (!state) {
      return;
    }

    state.completed = true;
    summarizeTask(state, {
      // Failed/cancelled turns seal as partial-interrupted (§8), not
      // complete — the panel must say the turn never finished (AC5).
      status: input.status === 'partial-interrupted' ? 'partial-interrupted' : 'complete',
      endedAtMs: Number.isFinite(input.endedAtMs) ? input.endedAtMs : undefined,
      metrics: {
        ...(input.sessionReused !== undefined ? { sessionReused: input.sessionReused === true } : {}),
        ...(input.sessionReuseReason ? { sessionReuseReason: String(input.sessionReuseReason) } : {}),
      },
    });
    taskStates.delete(state.taskId);
  }

  function drain() {
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }

    while (queue.length > 0) {
      const item = queue.shift();

      try {
        if (item.kind === 'start') {
          processTurnStart(item);
        } else if (item.kind === 'step') {
          processStep(item);
        } else if (item.kind === 'error') {
          processErrorEvent(item);
        } else if (item.kind === 'complete') {
          processComplete(item);
        }
      } catch (error: any) {
        // §11: a classification worker failure is logged; the turn path
        // never sees it.
        logger.warn(
          '[turn-time-breakdown] worker item failed:',
          error && error.message ? error.message : error
        );
      }
    }
  }

  function scheduleDrain() {
    if (drainTimer) {
      return;
    }

    drainTimer = setTimeout(drain, 0);

    if (drainTimer && typeof drainTimer.unref === 'function') {
      // Same contract as the observability sampler: the queue timer must
      // never keep the process alive.
      drainTimer.unref();
    }
  }

  function enqueue(item: any) {
    if (!repository) {
      return false;
    }

    if (queue.length >= queueCap) {
      // §8: drop the classification, never the underlying event (the raw
      // step remains in a2a_task_events / the session JSONL; lazy backfill
      // repairs the breakdown on next view).
      droppedCount += 1;
      return false;
    }

    queue.push(item);
    scheduleDrain();
    return true;
  }

  return {
    // Fire-and-forget; never throws, never awaits classification.
    enqueueTurnStart(input: any) {
      try {
        return enqueue({ ...input, kind: 'start' });
      } catch {
        return false;
      }
    },
    enqueueStep(input: any) {
      try {
        return enqueue({ ...input, kind: 'step' });
      } catch {
        return false;
      }
    },
    enqueueErrorEvent(input: any) {
      try {
        return enqueue({ ...input, kind: 'error' });
      } catch {
        return false;
      }
    },
    completeTask(input: any) {
      try {
        return enqueue({ ...input, kind: 'complete' });
      } catch {
        return false;
      }
    },
    // Shared JEV resolution entry for the §9 lazy backfill (steps classified
    // rules+cache only synchronously, then resolved here asynchronously).
    resolvePendingStep(input: any) {
      const state = ensureTaskState(input);

      if (!state || !repository) {
        return Promise.resolve(false);
      }

      return resolveStepWithJev(state, input.step || {});
    },
    isJevEnabled(context: any) {
      try {
        return resolveJevEnabled(context || {}) === true;
      } catch {
        return false;
      }
    },
    getStats() {
      return { droppedCount, queueDepth: queue.length, pendingAsync: pendingAsync.size };
    },
    // Test/support hook: drain synchronously and settle in-flight JEV work.
    async flushForTests() {
      drain();
      await Promise.all(Array.from(pendingAsync));
      drain();
      await Promise.all(Array.from(pendingAsync));
    },
  };
}
