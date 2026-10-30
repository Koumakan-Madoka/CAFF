import { createHttpError } from '../../http/http-errors';
import { validateAttentionQuery } from '../../../storage/chat/planner-attention.repository';

function closedError() { return createHttpError(503, 'Planner wait service is closing', { code: 'planner_wait_closed' }); }
export function createPlannerAttentionWait(store: any) {
  const pending = new Set<(error: any) => void>();
  let closed = false;
  function requireCapability() {
    for (const name of ['listPlannerAttention', 'getPlannerAttentionVersion', 'subscribePlannerAttention']) {
      if (typeof store?.[name] !== 'function') {
        throw createHttpError(501, 'Planner attention projection unavailable', { code: 'planner_projection_unavailable' });
      }
    }
  }
  return {
    async wait(query: any = {}, timeoutSeconds = 60, signal?: AbortSignal) {
      if (closed) throw closedError();
      requireCapability();
      validateAttentionQuery(query);
      if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
        throw createHttpError(400, 'Invalid attention timeout', { code: 'attention_query_invalid' });
      }
      const first = store.listPlannerAttention(query);
      if (first.items.length) return { ...first, timedOut: false };
      return new Promise<any>((resolve, reject) => {
        let done = false, unsubscribe = () => {};
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        let version = store.getPlannerAttentionVersion();
        const abort = () => finish(signal?.reason || new Error('Planner wait aborted'));
        function finish(error?: any, page?: any) {
          if (done) return;
          done = true;
          unsubscribe(); clearTimeout(timeout); clearInterval(poll);
          signal?.removeEventListener('abort', abort); pending.delete(cancel);
          if (error) reject(error); else resolve(page);
        }
        const cancel = (error: any) => finish(error);
        function check(timedOut = false) {
          if (done) return;
          try {
            const page = store.listPlannerAttention(query);
            if (page.items.length || timedOut) finish(undefined, { ...page, timedOut: !page.items.length });
          } catch (error) { finish(error); }
        }
        pending.add(cancel);
        try {
          unsubscribe = store.subscribePlannerAttention(() => check());
          if (done) { unsubscribe(); return; }
          timeout = setTimeout(() => check(true), timeoutSeconds * 1000);
          // Version polling closes cross-process/connection-alias notification
          // gaps. Only active waits poll; unchanged revisions avoid a page query.
          poll = setInterval(() => {
            try {
              const current = store.getPlannerAttentionVersion();
              if (current !== version) { version = current; check(); }
            } catch (error) { finish(error); }
          }, 100);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          else check(); // Mandatory read/subscribe race closure.
        } catch (error) { finish(error); }
      });
    },
    close() { closed = true; for (const cancel of [...pending]) cancel(closedError()); },
    getStats() { return { pending: pending.size, closed }; },
  };
}
