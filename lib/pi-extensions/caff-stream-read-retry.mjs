const STREAM_READ_ERROR = 'stream_read_error';
const RETRYABLE_STREAM_READ_ERROR = `connection error: ${STREAM_READ_ERROR}`;

/** @param {unknown} value */
function normalizeErrorIdentifier(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {any} message */
export function normalizeStreamReadErrorMessage(message) {
  if (
    !message
    || typeof message !== 'object'
    || message.role !== 'assistant'
    || message.stopReason !== 'error'
    || normalizeErrorIdentifier(message.errorMessage) !== STREAM_READ_ERROR
  ) {
    return message;
  }

  return {
    ...message,
    errorMessage: RETRYABLE_STREAM_READ_ERROR,
  };
}

/** @param {{ on(event: string, handler: (event: any) => any): void }} pi */
export default function registerStreamReadErrorRetry(pi) {
  pi.on('message_end', (event) => {
    const message = normalizeStreamReadErrorMessage(event && event.message);
    return message === event?.message ? undefined : { message };
  });
}
