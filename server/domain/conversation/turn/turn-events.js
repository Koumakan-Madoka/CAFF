const { nowIso, summarizeTurnState } = require('./turn-state');

function createTurnEventEmitter(options = {}) {
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

module.exports = {
  createTurnEventEmitter,
};

