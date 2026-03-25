const { createHttpError } = require('../../../http/http-errors');
const { nowIso, resetTurnStage, summarizeTurnState, syncCurrentTurnAgent } = require('./turn-state');

function registerTurnHandle(turnState, handle) {
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

function unregisterTurnHandle(turnState, handle) {
  if (!turnState || !handle || !(turnState.runHandles instanceof Set)) {
    return;
  }

  turnState.runHandles.delete(handle);
}

function createTurnStopper(options = {}) {
  const activeTurns = options.activeTurns;
  const broadcastRuntimeState = typeof options.broadcastRuntimeState === 'function' ? options.broadcastRuntimeState : () => {};
  const emitTurnProgress = typeof options.emitTurnProgress === 'function' ? options.emitTurnProgress : () => {};

  function requestStopConversationTurn(conversationId, reason = 'Stopped by user') {
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

    const handles = turnState.runHandles instanceof Set ? Array.from(turnState.runHandles) : [];

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

module.exports = {
  createTurnStopper,
  registerTurnHandle,
  unregisterTurnHandle,
};

