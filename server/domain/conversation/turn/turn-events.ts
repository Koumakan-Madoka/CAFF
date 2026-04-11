const { nowIso, summarizeAgentSlotState, summarizeTurnState } = require('./turn-state');

export function createTurnEventEmitter(options: any = {}) {
  const broadcastEvent = typeof options.broadcastEvent === 'function' ? options.broadcastEvent : () => {};

  function emitTurnProgress(turnState: any) {
    turnState.updatedAt = nowIso();

    if (turnState && turnState.executionLane === 'side') {
      broadcastEvent('agent_slot_progress', {
        conversationId: turnState.conversationId,
        slot: summarizeAgentSlotState(turnState),
      });
      return;
    }

    broadcastEvent('turn_progress', {
      conversationId: turnState.conversationId,
      turn: summarizeTurnState(turnState),
    });
  }

  function emitAgentSlotFinished(turnState: any, failures: any[] = []) {
    turnState.updatedAt = nowIso();
    broadcastEvent('agent_slot_finished', {
      conversationId: turnState.conversationId,
      slot: summarizeAgentSlotState(turnState),
      failures,
    });
  }

  return {
    emitAgentSlotFinished,
    emitTurnProgress,
  };
}
