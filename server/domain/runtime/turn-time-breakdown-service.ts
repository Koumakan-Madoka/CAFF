// Turn time breakdown — §9 read path and lazy backfill. The API returns a
// stored summary when it is terminal (cached path); a missing or `live`
// summary is (re)computed from the session JSONL incrementally
// (parse_offset), classified with rules + the JEV cache ONLY inside the
// synchronous path (fresh JEV calls are excluded so multi-MB logs finish
// within the AC5 budget), and pending steps resolve asynchronously via the
// pipeline afterwards.

import { computeTurnAttribution } from './turn-time-breakdown-attribution';
import {
  createTurnRuleClassifier,
  detectTestFailure,
  parseSessionTurnSteps,
} from './turn-time-breakdown';
import { jevCacheKey, truncateStepOutput } from './turn-time-breakdown-jev';

function fromIso(value: any) {
  const parsed = Date.parse(String(value || ''));

  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(msValue: any) {
  const num = Number(msValue);

  return Number.isFinite(num) && num > 0 ? new Date(num).toISOString() : null;
}

function safeJsonParse(value: any) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadTaskRow(db: any, taskId: any) {
  if (!db || !taskId) {
    return null;
  }

  try {
    return db
      .prepare(
        `SELECT id, status, run_id, session_path, metadata_json FROM a2a_tasks WHERE id = @taskId`
      )
      .get({ taskId: String(taskId) });
  } catch {
    return null;
  }
}

function mapStoredStep(row: any) {
  return {
    stepKey: row.step_key,
    toolName: row.tool_name,
    category: row.category,
    subcategory: row.subcategory,
    classifiedBy: row.classified_by,
    jevStatus: row.jev_status,
    confidence: Number.isFinite(row.confidence) ? row.confidence : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: Number.isFinite(row.duration_ms) ? row.duration_ms : null,
    runKind: row.run_kind,
    runFailed: row.run_failed === null || row.run_failed === undefined ? null : row.run_failed === 1,
    testRunCounts: Number.isFinite(row.run_count_full) || Number.isFinite(row.run_count_targeted)
      ? {
          full: Number.isFinite(row.run_count_full) ? row.run_count_full : 0,
          targeted: Number.isFinite(row.run_count_targeted) ? row.run_count_targeted : 0,
        }
      : null,
  };
}

function assembleResponse(summary: any, steps: any[], message: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : {};

  return {
    status: summary.status,
    categoryMs: summary.categoryMs,
    metrics: summary.metrics,
    steps: steps.map(mapStoredStep),
    computedAt: summary.computedAt,
    // §10: token display is an open question (q-tokens); the API already
    // carries the fields so enabling it later is display-only.
    tokenUsage: metadata.tokenUsage && typeof metadata.tokenUsage === 'object' ? metadata.tokenUsage : null,
  };
}

function resolveSessionSlice(db: any, message: any, resolvedSessionPath: any) {
  const metadata = message && message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const taskId = String(message && message.taskId ? message.taskId : '').trim();
  const taskRow = taskId ? loadTaskRow(db, taskId) : null;
  const taskMetadata = taskRow ? safeJsonParse(taskRow.metadata_json) : null;
  const startIndexCandidate = metadata.sessionAssistantStartIndex !== undefined
    ? metadata.sessionAssistantStartIndex
    : taskMetadata && taskMetadata.sessionAssistantStartIndex;
  const assistantStartIndex = Number.isSafeInteger(Number(startIndexCandidate)) && Number(startIndexCandidate) >= 0
    ? Number(startIndexCandidate)
    : null;
  const sessionPath = String(
    (taskRow && taskRow.session_path) || resolvedSessionPath || ''
  ).trim();

  return {
    taskId,
    taskRow,
    sessionPath,
    assistantStartIndex,
  };
}

// Recompute the summary row from stored steps. Preserves a terminal status
// unless the caller explicitly transitions it.
function recomputeSummary(repository: any, input: any) {
  const rows = repository.listSteps(input.taskId);
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
  const existing = repository.getSummary(input.messageId);
  const attribution = computeTurnAttribution({
    steps,
    errorEvents: input.errorEvents || [],
    turnStartedAtMs: input.turnStartedAtMs !== undefined ? input.turnStartedAtMs : null,
    turnEndedAtMs: input.turnEndedAtMs !== undefined ? input.turnEndedAtMs : null,
  });
  const metrics = {
    ...(existing && existing.metrics ? existing.metrics : {}),
    ...attribution.metrics,
    ...(input.metrics || {}),
  };

  repository.upsertSummary({
    messageId: input.messageId,
    taskId: input.taskId,
    conversationId: input.conversationId,
    status: input.status || (existing && existing.status) || 'live',
    turnStartedAt: toIso(attribution.turnStartedAtMs) || (existing && existing.turnStartedAt) || null,
    turnEndedAt: input.turnEndedAtMs !== undefined
      ? toIso(attribution.turnEndedAtMs)
      : (existing && existing.turnEndedAt) || null,
    categoryMs: attribution.categoryMs,
    metrics,
    parseOffset: input.parseOffset !== undefined ? input.parseOffset : (existing ? existing.parseOffset : null),
    assistantCount: input.assistantCount !== undefined ? input.assistantCount : (existing ? existing.assistantCount : null),
    computedAt: toIso(input.nowMs),
  });

  return repository.getSummary(input.messageId);
}

export function getTurnTimeBreakdownForMessage(options: any = {}) {
  const db = options.db || null;
  const agentDir = String(options.agentDir || '').trim();
  const message = options.message || null;
  const repository = options.repository || null;
  const pipeline = options.pipeline || null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  if (!db || !repository || !message || !message.id) {
    return null;
  }

  const messageId = String(message.id);
  const conversationId = String(message.conversationId || (options.conversationId || ''));
  const slice = resolveSessionSlice(db, message, options.resolvedSessionPath);

  if (!slice.taskId) {
    return null;
  }

  let summary = repository.getSummary(messageId);

  // Cached path (§9): a terminal summary is returned as-is (< 2 s target).
  if (summary && summary.status !== 'live') {
    return assembleResponse(summary, repository.listSteps(slice.taskId), message);
  }

  const parsed = slice.sessionPath
    ? parseSessionTurnSteps(slice.sessionPath, agentDir, {
        assistantStartIndex: slice.assistantStartIndex,
        fromOffset: summary && Number.isSafeInteger(summary.parseOffset) ? summary.parseOffset : 0,
        assistantCountBase: summary && Number.isSafeInteger(summary.assistantCount) ? summary.assistantCount : 0,
      })
    : null;

  if (!parsed && !summary) {
    return null; // no session file and no stored rows — nothing to show
  }

  const messageMetadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  const jevContext = { taskId: slice.taskId, messageId, conversationId };
  const jevEnabled = pipeline && typeof pipeline.isJevEnabled === 'function'
    ? pipeline.isJevEnabled(jevContext)
    : false;
  const pendingForAsync: any[] = [];

  if (parsed) {
    // Rebuild the rule classifier's cold-start state from steps stored by
    // earlier passes: a write already classified (rules, JEV, or cache)
    // flips later reads to purposeful-lookup (§5 rule 5).
    const classifier = createTurnRuleClassifier();

    for (const row of repository.listSteps(slice.taskId)) {
      if (row.category === 'write') {
        classifier.noteExternalCategory('write');
      }
    }

    for (const step of parsed.steps) {
      const baseRow = {
        taskId: slice.taskId,
        messageId,
        toolName: step.toolName,
        startedAt: toIso(step.startedAtMs) || toIso(step.endedAtMs) || toIso(nowMs),
        endedAt: toIso(step.endedAtMs),
        durationMs: step.durationMs,
      };

      // §4 cross-chunk merge: an orphan toolResult joins the open row an
      // earlier pass stored, instead of becoming a second row.
      if (step.orphan && step.toolCallId) {
        const openRow = repository.findOpenStep(slice.taskId, step.toolCallId);

        if (openRow) {
          // Merge into the stored open row: keep its start and
          // classification, take the result's end/output. Duration derives
          // from the pair, never from the orphan alone.
          const mergedStartMs = fromIso(openRow.started_at);
          const mergedEndMs = step.endedAtMs;

          repository.upsertStep({
            ...baseRow,
            stepKey: openRow.step_key,
            startedAt: openRow.started_at,
            durationMs: mergedStartMs !== null && mergedEndMs !== null && mergedEndMs >= mergedStartMs
              ? mergedEndMs - mergedStartMs
              : null,
            category: openRow.category,
            subcategory: openRow.subcategory,
            classifiedBy: openRow.classified_by,
            jevStatus: openRow.jev_status,
            confidence: openRow.confidence,
            runKind: openRow.run_kind,
            runFailed: openRow.category === 'test'
              ? detectTestFailure(step.output, step.isError)
              : (openRow.run_failed === 1 ? true : openRow.run_failed === 0 ? false : null),
            testRunCounts: Number.isFinite(openRow.run_count_full) || Number.isFinite(openRow.run_count_targeted)
              ? { full: openRow.run_count_full || 0, targeted: openRow.run_count_targeted || 0 }
              : null,
          });
          continue;
        }
      }

      const stepKey = String(step.stepKey || `step:${step.toolName}:${step.startedAtMs || 'orphan'}`);

      // JEV-resolved rows keep their category; backfill only refreshes timing.
      const existingRow = repository.getStep(slice.taskId, stepKey);

      if (existingRow && (existingRow.classified_by === 'jev' || existingRow.classified_by === 'jev-cache')) {
        repository.upsertStep({
          ...baseRow,
          stepKey,
          category: existingRow.category,
          subcategory: existingRow.subcategory,
          classifiedBy: existingRow.classified_by,
          jevStatus: existingRow.jev_status,
          confidence: existingRow.confidence,
          runKind: existingRow.run_kind,
          runFailed: existingRow.run_failed === 1 ? true : existingRow.run_failed === 0 ? false : null,
          testRunCounts: Number.isFinite(existingRow.run_count_full) || Number.isFinite(existingRow.run_count_targeted)
            ? { full: existingRow.run_count_full || 0, targeted: existingRow.run_count_targeted || 0 }
            : null,
        });
        continue;
      }

      const classified = classifier.classify({
        toolName: step.toolName,
        args: step.args,
        output: step.output,
        isError: step.isError === true,
      });

      if (classified) {
        repository.upsertStep({
          ...baseRow,
          stepKey,
          category: classified.category,
          subcategory: classified.subcategory || null,
          classifiedBy: 'rules',
          jevStatus: null,
          confidence: null,
          runKind: classified.runKind || null,
          runFailed: classified.runFailed === true ? true : classified.category === 'test' ? false : null,
          testRunCounts: classified.testRunCounts || null,
        });
        continue;
      }

      // §9 synchronous path: rules + JEV cache only; fresh JEV calls are
      // excluded so multi-MB logs stay within the backfill budget.
      const cacheKey = jevCacheKey(step);
      const cached = repository.getJevCacheEntry(cacheKey);

      if (cached) {
        repository.upsertStep({
          ...baseRow,
          stepKey,
          category: cached.category,
          subcategory: cached.subcategory || null,
          classifiedBy: 'jev-cache',
          jevStatus: 'ok',
          confidence: cached.confidence,
          runKind: cached.runKind || null,
          runFailed: cached.category === 'test' ? detectTestFailure(step.output, step.isError) : null,
        });

        if (cached.category === 'write') {
          classifier.noteExternalCategory('write');
        }

        continue;
      }

      repository.upsertStep({
        ...baseRow,
        stepKey,
        category: 'unclassified',
        subcategory: null,
        classifiedBy: 'unclassified',
        jevStatus: jevEnabled ? 'pending' : 'disabled',
        confidence: null,
        runKind: null,
        runFailed: null,
        payloadJson: JSON.stringify({
          args: step.args !== undefined ? step.args : null,
          output: truncateStepOutput(step.output),
        }),
      });

      if (jevEnabled) {
        pendingForAsync.push({ stepKey, step });
      }
    }
  }

  // §6: a later pass may reclassify timeout/error steps via cache or a fresh
  // call — payload_json makes the retry reproducible without a re-parse.
  if (jevEnabled) {
    for (const row of repository.listJevRetrySteps(slice.taskId)) {
      const payload = safeJsonParse(row.payload_json);

      if (!payload) {
        continue;
      }

      pendingForAsync.push({
        stepKey: row.step_key,
        step: {
          toolName: row.tool_name,
          args: payload.args,
          output: payload.output,
          isError: false,
          durationMs: row.duration_ms,
        },
        baseRow: {
          startedAt: row.started_at,
          endedAt: row.ended_at,
          durationMs: row.duration_ms,
        },
      });
    }
  }

  const openStepCount = repository
    .listSteps(slice.taskId)
    .filter((row: any) => row.ended_at === null || row.ended_at === undefined)
    .length;
  const messageCompleted = String(message.status || '') === 'completed';
  const status = parsed && parsed.truncated
    ? 'partial-truncated'
    : messageCompleted
      ? openStepCount > 0
        ? 'partial-interrupted'
        : 'complete'
      : (summary && summary.status) || 'live';
  // §2: session reuse comes straight from the authoritative message
  // metadata; history messages lacking the fields simply omit them (the
  // panel renders 无记录, never a guess).
  const reuseMetrics: any = {};

  if (typeof messageMetadata.sessionReused === 'boolean') {
    reuseMetrics.sessionReused = messageMetadata.sessionReused;
  }

  if (messageMetadata.sessionReuseReason) {
    reuseMetrics.sessionReuseReason = String(messageMetadata.sessionReuseReason);
  }

  // Turn span end: a completed turn seals at message finalization (so the
  // last model generation counts as thinking); a live turn accounts to now.
  const messageEndMs = messageCompleted
    ? fromIso(message.updatedAt) || fromIso(message.createdAt)
    : null;
  const stepEnds = repository
    .listSteps(slice.taskId)
    .map((row: any) => fromIso(row.ended_at))
    .filter((value: any) => value !== null);
  const derivedTurnEndMs = messageCompleted
    ? Math.max(messageEndMs || 0, ...stepEnds, 0) || null
    : nowMs;

  summary = recomputeSummary(repository, {
    messageId,
    taskId: slice.taskId,
    conversationId,
    status,
    errorEvents: parsed ? parsed.errorEvents : [],
    turnStartedAtMs: parsed && parsed.firstEventMs !== null && parsed.firstEventMs !== undefined
      ? parsed.firstEventMs
      : undefined,
    turnEndedAtMs: derivedTurnEndMs !== null ? derivedTurnEndMs : undefined,
    metrics: reuseMetrics,
    parseOffset: parsed ? parsed.endOffset : (summary ? summary.parseOffset : null),
    assistantCount: parsed ? parsed.assistantMessageTotal : (summary ? summary.assistantCount : null),
    nowMs,
  });

  // Async JEV resolution for pending steps — after the response is
  // assembled, never inside the synchronous backfill (§9).
  if (pipeline && pendingForAsync.length > 0) {
    for (const pending of pendingForAsync) {
      const stepRow = {
        stepKey: pending.stepKey,
        toolName: pending.step.toolName,
        args: pending.step.args,
        output: pending.step.output,
        isError: pending.step.isError === true,
        durationMs: Number.isFinite(pending.step.durationMs) ? pending.step.durationMs : null,
        startedAt: pending.baseRow ? pending.baseRow.startedAt : toIso(pending.step.startedAtMs),
        endedAt: pending.baseRow ? pending.baseRow.endedAt : toIso(pending.step.endedAtMs),
      };

      Promise.resolve(pipeline.resolvePendingStep({ ...jevContext, step: stepRow })).catch(() => {});
    }
  }

  return assembleResponse(summary, repository.listSteps(slice.taskId), message);
}
