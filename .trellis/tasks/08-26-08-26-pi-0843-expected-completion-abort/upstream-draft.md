# Upstream PI Regression Draft (Not Published)

## Title

Abort during provider-auth setup is surfaced as an assistant error instead of
an aborted message

## Summary

Starting in PI AI 0.84.0, provider-auth resolution races with the Agent abort
signal. If an Agent session is aborted while the next model call is in lazy
stream setup, the rejected abort reason is converted by the lazy setup error
path into an assistant message with `stopReason: "error"` and an abort-shaped
`errorMessage`. A caller-requested abort can therefore look like a provider
invocation failure.

## Observed Sequence

1. A tool result completes successfully.
2. The embedding application calls `session.abort()` to stop remaining work.
3. The Agent loop has already started the next model call.
4. `resolveProviderAuth` rejects from the aborted signal.
5. The lazy stream setup catch emits an assistant message with
   `stopReason: "error"` and `errorMessage: "This operation was aborted"`.

The assistant error appears immediately after the successful tool result and
contains no usage or content.

## Expected Behavior

An abort signal observed during request/auth setup should produce the same
`stopReason: "aborted"` classification as an abort observed during provider
streaming. User-initiated or embedding-initiated abort should not be reported as
a provider/model error solely because it won the auth-setup race.

## Suggested Upstream Direction

Make the lazy setup error path abort-aware. When the setup rejection is the
active abort signal reason or an AbortError/abort DOMException, emit an aborted
assistant message rather than the generic setup error message. Preserve ordinary
auth/provider setup failures as `stopReason: "error"`.

## Compatibility Note

CAFF applies a local event-order guard at its own expected-completion boundary;
it does not match this error text. An upstream classification fix would make the
local guard a harmless defense for other post-completion assistant tail output.

This draft is repository evidence only. It has not been submitted to an
upstream issue tracker or pull request.
