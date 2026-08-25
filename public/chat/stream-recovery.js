// @ts-check

// P1B browser SSE recovery (reviewed plan a9f9eec):
// After an errored stream successfully reopens, exactly one coalesced
// refreshAll(selectedConversationId) restores authoritative state over HTTP.
// Initial/healthy opens never refresh; an errored episode that reopens while
// a recovery refresh is still in flight never starts a parallel refresh — it
// is coalesced into exactly one serialized trailing refresh that runs after
// the in-flight one settles (state may have changed after the first refresh
// already read it). There is no Last-Event-ID consumption, no event replay,
// and no at-least-once delivery claim — missed events are recovered through
// the HTTP refresh plus subsequent live events.

(function registerStreamRecoveryModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  chat.createStreamRecovery = function createStreamRecovery() {
    let sawStreamError = false;
    let recoveryInFlight = false;
    let pendingRecovery = false;

    return {
      markStreamError() {
        sawStreamError = true;
      },
      /**
       * Called on every stream open. Returns true exactly once per errored
       * episode when an authoritative refresh should start; while a refresh
       * is already in flight, a reopened errored episode is coalesced into a
       * pending trailing refresh instead of a parallel one.
       */
      shouldRecoverOnOpen() {
        if (!sawStreamError) {
          return false;
        }
        sawStreamError = false;

        if (recoveryInFlight) {
          pendingRecovery = true;
          return false;
        }

        recoveryInFlight = true;
        return true;
      },
      /**
       * Called when a recovery refresh settles (finally). Returns true when a
       * coalesced trailing episode is pending and exactly one more refresh
       * must run immediately, serialized after the one that just settled —
       * dropping it would leave a quiet conversation stuck on stale state,
       * since there is no replay and no periodic authoritative broadcast.
       */
      finishRecovery() {
        recoveryInFlight = false;

        if (pendingRecovery) {
          pendingRecovery = false;
          recoveryInFlight = true;
          return true;
        }

        return false;
      },
    };
  };
})();
