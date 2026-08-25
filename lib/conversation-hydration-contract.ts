export const DEFAULT_PROMPT_HISTORY_LIMIT = 24;
export const MAX_PROMPT_HISTORY_LIMIT = 100;
export const MAX_RUNTIME_MESSAGE_ID_PROJECTION = 256;

export function requiresBoundedConversationProjections(store: any) {
  return Boolean(
    store
    && (
      store.boundedConversationProjections === true
      || (store.constructor && store.constructor.name === 'ChatAppStore')
    )
  );
}
