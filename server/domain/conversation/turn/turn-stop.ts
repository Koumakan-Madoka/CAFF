const { createHttpError } = require('../../../http/http-errors');
const { nowIso, resetTurnStage, summarizeTurnState, syncCurrentTurnAgent } = require('./turn-state');

export function registerTurnHandle(turnState: any, handle: any) {
  if (!turnState || !handle) {
    return;
  }

  if (!(turnState.runHandles instanceof Set)) {
    turnState.runHandles = new Set();
  }

  turnState.runHandles.add(handle);

  if (turnState.stopRequested && typeof handle.cancel === 'function') {
    try {
      handle.cancel(turnState.stopReason || 'Stopped by user');
    } catch {}
  }
}

export function unregisterTurnHandle(turnState: any, handle: any) {
  if (!turnState || !handle || !(turnState.runHandles instanceof Set)) {
    return;
  }

  turnState.runHandles.delete(handle);
}

export function createTurnStopper(options: any = {}) {
  const activeTurns = options.activeTurns;
  const broadcastRuntimeState = typeof options.broadcastRuntimeState === 'function' ? options.broadcastRuntimeState : () => {};
  const emitTurnProgress = typeof options.emitTurnProgress === 'function' ? options.emitTurnProgress : () => {};

  function requestStopConversationTurn(conversationId: any, reason: any = 'Stopped by user') {
    const turnState = activeTurns.get(conversationId);

    if (!turnState) {
      throw createHttpError(409, 'This conversation is not processing a turn');
    }

    const stopReason = String(reason || 'Stopped by user').trim() || 'Stopped by user';

    if (!turnState.stopRequested) {
      turnState.stopRequested = true;
      turnState.stopReason = stopReason;
      turnState.stopRequestedAt = nowIso();
      turnState.status = 'stopping';
      turnState.pendingAgentIds = [];

      for (const stage of Array.isArray(turnState.agents) ? turnState.agents : []) {
        if (stage.status === 'queued') {
          resetTurnStage(stage, 'idle');
        }
      }
    }

    const handles = turnState.runHandles instanceof Set ? (Array.from(turnState.runHandles) as any[]) : [];

    for (const handle of handles) {
      if (!handle || typeof handle.cancel !== 'function') {
        continue;
      }

      try {
        handle.cancel(stopReason);
      } catch {}
    }

    turnState.updatedAt = nowIso();
    syncCurrentTurnAgent(turnState);
    broadcastRuntimeState();
    emitTurnProgress(turnState);

    return summarizeTurnState(turnState);
  }

  return requestStopConversationTurn;
}
