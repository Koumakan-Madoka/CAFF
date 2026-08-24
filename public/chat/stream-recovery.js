// @ts-check

// P1B browser SSE recovery (reviewed plan a9f9eec):
// After an errored stream successfully reopens, exactly one coalesced
// refreshAll(selectedConversationId) restores authoritative state over HTTP.
// Initial/healthy opens never refresh; repeated opens while a recovery refresh
// is still in flight are coalesced into that refresh (no parallel refreshes).
// There is no Last-Event-ID consumption, no event replay, and no at-least-once
// delivery claim — missed events are recovered through the HTTP refresh plus
// subsequent live events.

(function registerStreamRecoveryModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createStreamRecovery = function createStreamRecovery() {
    let sawStreamError = false;
    let recoveryInFlight = false;

    return {
      markStreamError() {
        sawStreamError = true;
      },
      /**
       * Called on every stream open. Returns true exactly once per errored
       * episode when an authoritative refresh should start; the caller must
       * invoke finishRecovery() when that refresh settles (finally), which
       * re-arms recovery for future errored episodes.
       */
      shouldRecoverOnOpen() {
        if (!sawStreamError) {
          return false;
        }
        sawStreamError = false;
        if (recoveryInFlight) {
          return false;
        }
        recoveryInFlight = true;
        return true;
      },
      finishRecovery() {
        recoveryInFlight = false;
      },
    };
  };
})();
