export type RuntimeMemorySample = {
  timestamp: string;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

export type RuntimeObservabilitySnapshot = {
  timestamp: string;
  memory: RuntimeMemorySample;
  counters: Record<string, any>;
  memoryHistory: RuntimeMemorySample[];
};

export type RuntimeCounterProvider = () => Record<string, any>;

export type RuntimeObservabilityOptions = {
  sampleIntervalMs?: number;
  maxHistoryEntries?: number;
  memoryUsage?: () => any;
  now?: () => Date;
  log?: (line: string) => void;
};

const DEFAULT_SAMPLE_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_HISTORY_ENTRIES = 96;

function normalizePositiveInteger(value: any, fallback: number) {
  const numberValue = Number.isInteger(value) ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

// undefined/null -> default; explicit number <= 0 -> 0 (sampler disabled);
// non-numeric garbage -> default.
function resolveSampleIntervalMs(value: any) {
  if (value === undefined || value === null) {
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }

  const numberValue = Number.isInteger(value) ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(numberValue)) {
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }

  return numberValue > 0 ? numberValue : 0;
}

function toFiniteBytes(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
}

function formatMiB(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

export function createRuntimeObservability(options: RuntimeObservabilityOptions = {}) {
  const sampleIntervalMs = resolveSampleIntervalMs(options.sampleIntervalMs);
  const maxHistoryEntries = normalizePositiveInteger(options.maxHistoryEntries, DEFAULT_MAX_HISTORY_ENTRIES);
  const memoryUsage = typeof options.memoryUsage === 'function' ? options.memoryUsage : () => process.memoryUsage();
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const log = typeof options.log === 'function' ? options.log : (line: string) => console.log(line);

  const providers = new Map<string, RuntimeCounterProvider>();
  const history: RuntimeMemorySample[] = [];
  let sampleTimer: NodeJS.Timeout | null = null;

  function timestampNow() {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString()
      : new Date().toISOString();
  }

  function collectMemory(): RuntimeMemorySample {
    let usage: any = null;

    try {
      usage = memoryUsage();
    } catch {
      usage = null;
    }

    return {
      timestamp: timestampNow(),
      heapUsedBytes: toFiniteBytes(usage && usage.heapUsed),
      heapTotalBytes: toFiniteBytes(usage && usage.heapTotal),
      rssBytes: toFiniteBytes(usage && usage.rss),
      externalBytes: toFiniteBytes(usage && usage.external),
      arrayBuffersBytes: toFiniteBytes(usage && usage.arrayBuffers),
    };
  }

  function sampleAndRecord(): RuntimeMemorySample {
    const sample = collectMemory();

    history.push(sample);
    if (history.length > maxHistoryEntries) {
      history.splice(0, history.length - maxHistoryEntries);
    }

    log(
      `[runtime-observability] memory heapUsed=${formatMiB(sample.heapUsedBytes)}`
      + ` heapTotal=${formatMiB(sample.heapTotalBytes)}`
      + ` rss=${formatMiB(sample.rssBytes)}`
      + ` external=${formatMiB(sample.externalBytes)}`
      + ` arrayBuffers=${formatMiB(sample.arrayBuffersBytes)}`
    );

    return sample;
  }

  function registerCounterProvider(name: any, provider: any) {
    const normalizedName = String(name || '').trim();

    if (!normalizedName || typeof provider !== 'function') {
      return false;
    }

    providers.set(normalizedName, provider);
    return true;
  }

  function unregisterCounterProvider(name: any) {
    const normalizedName = String(name || '').trim();

    if (!normalizedName || !providers.has(normalizedName)) {
      return false;
    }

    providers.delete(normalizedName);
    return true;
  }

  function getSnapshot(): RuntimeObservabilitySnapshot {
    const counters: Record<string, any> = {};

    for (const [name, provider] of Array.from(providers.entries())) {
      try {
        counters[name] = provider();
      } catch (error) {
        counters[name] = { unavailable: true };
        console.error(`[runtime-observability] counter provider "${name}" failed: ${String(error)}`);
      }
    }

    return {
      timestamp: timestampNow(),
      memory: collectMemory(),
      counters,
      memoryHistory: history.slice(),
    };
  }

  function getMemoryHistory() {
    return history.slice();
  }

  function start() {
    if (sampleTimer || sampleIntervalMs <= 0) {
      return false;
    }

    sampleAndRecord();
    sampleTimer = setInterval(sampleAndRecord, sampleIntervalMs);

    if (typeof sampleTimer.unref === 'function') {
      sampleTimer.unref();
    }

    return true;
  }

  function stop() {
    if (!sampleTimer) {
      return false;
    }

    clearInterval(sampleTimer);
    sampleTimer = null;
    return true;
  }

  function dispose() {
    stop();
    providers.clear();
    history.length = 0;
  }

  return {
    dispose,
    getMemoryHistory,
    getSnapshot,
    registerCounterProvider,
    start,
    stop,
    unregisterCounterProvider,
  };
}
