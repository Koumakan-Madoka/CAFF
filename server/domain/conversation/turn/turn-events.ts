const { nowIso, summarizeTurnState } = require('./turn-state');

export function createTurnEventEmitter(options: any = {}) {
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};

  function emitTurnProgress(turnState) {
    turnState.updatedAt = nowIso();
    broadcastEvent('turn_progress', {
      conversationId: turnState.conversationId,
      turn: summarizeTurnState(turnState),
    });
  }

  return {
    emitTurnProgress,
  };
}

