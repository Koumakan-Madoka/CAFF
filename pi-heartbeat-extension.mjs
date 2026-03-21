const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const DEFAULT_HEARTBEAT_PREFIX = '__PI_HEARTBEAT__';

function resolveInteger(value, fallbackValue) {
  const rawValue = value ?? fallbackValue;
  const parsedValue = Number.parseInt(String(rawValue), 10);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return fallbackValue;
  }

  return parsedValue;
}

export default function heartbeatExtension(pi) {
  const heartbeatIntervalMs = resolveInteger(process.env.PI_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS);
  const heartbeatPrefix = String(process.env.PI_HEARTBEAT_PREFIX || DEFAULT_HEARTBEAT_PREFIX);
  let heartbeatTimer = null;
  let sequence = 0;

  function emitHeartbeat(reason) {
    const payload = JSON.stringify({
      sequence,
      reason,
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(`${heartbeatPrefix} ${payload}\n`);
    sequence += 1;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer || heartbeatIntervalMs <= 0) {
      return;
    }

    emitHeartbeat('start');
    heartbeatTimer = setInterval(() => {
      emitHeartbeat('tick');
    }, heartbeatIntervalMs);

    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  pi.on('session_start', () => {
    startHeartbeat();
  });

  pi.on('agent_start', () => {
    startHeartbeat();
  });

  pi.on('agent_end', () => {
    stopHeartbeat();
  });

  pi.on('session_shutdown', () => {
    stopHeartbeat();
  });
}
