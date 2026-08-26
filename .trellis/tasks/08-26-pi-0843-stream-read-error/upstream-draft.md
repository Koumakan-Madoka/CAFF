# Upstream Draft (Do Not Publish Without User Confirmation)

## Issue

### Title

Treat exact `stream_read_error` assistant failures as retryable stream termination

### Body

`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` 0.84.3 does not
classify the exact provider error `stream_read_error` as retryable.

Some OpenAI-compatible Responses gateways surface a mid-stream SSE read failure
as a final assistant message with:

```json
{
  "role": "assistant",
  "stopReason": "error",
  "errorMessage": "stream_read_error"
}
```

The current retry classifier recognizes equivalent premature-stream conditions
such as `stream ended before message_stop` and
`stream ended before a terminal response event`, but a controlled
`Agent` + `AgentSession` fixture shows the exact identifier causes one provider
call, zero `auto_retry_start` events, and immediate terminal failure. Replacing
the message with `connection error: stream_read_error` through the documented
`message_end` hook triggers the existing bounded retry path.

Expected behavior:

- exact normalized `stream_read_error` is retryable;
- ordinary retry settings remain authoritative (`enabled`, `maxRetries`,
  exponential backoff);
- abort/cancellation, quota/billing, HTTP 400/401/403, and decorated unrelated
  strings do not become retryable;
- completed tool results remain in context and are not executed again;
- four consecutive failures close after the configured three retries.

A narrow classifier entry such as an anchored, case-insensitive
`^stream_read_error$` check would align this identifier with existing premature
stream termination handling without broad substring matching.

I can provide a deterministic no-network regression fixture using
`createAssistantMessageEventStream()` if useful.

## Pull Request

### Title

fix(retry): classify exact stream_read_error as transient

### Summary

- recognize only normalized assistant error text exactly equal to
  `stream_read_error`;
- reuse the existing AgentSession retry budget and exponential backoff;
- leave abort, request/auth, quota, and decorated error strings unchanged;
- add controlled stream tests for one-failure recovery and four-failure bounded
  closure.

### Test Plan

- exact error then success: two provider calls, retry start attempt 1, successful
  retry end;
- exact error four times: four calls, attempts 1/2/3, final failed retry end;
- partial text then failure: failed assistant removed before continuation;
- completed tool then later failure: tool execute count remains one;
- HTTP 400/401/403, quota, abort, prefix/suffix variants: no retry;
- existing connection-error retry behavior remains unchanged.

### Compatibility

No provider API, session format, tool contract, streaming mode, or retry default
changes. The change only closes a classifier gap for one exact identifier.
