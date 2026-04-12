function trimString(value: any) {
  return String(value || '').trim();
}

function asObject(value: any) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeConnectionMode(value: any) {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');

  if (!normalized) {
    return 'webhook';
  }

  if (normalized === 'websocket' || normalized === 'ws' || normalized === 'longconnection') {
    return 'long-connection';
  }

  return normalized;
}

function pickSdkLoggerLevel(sdk: any, value: any) {
  const normalized = trimString(value || 'info').toLowerCase();
  const loggerLevel = sdk && sdk.LoggerLevel ? sdk.LoggerLevel : null;

  if (!loggerLevel || !Object.prototype.hasOwnProperty.call(loggerLevel, normalized)) {
    return undefined;
  }

  return loggerLevel[normalized];
}

function normalizeLongConnectionEventPayload(value: any) {
  const payload = asObject(value);

  if (asObject(payload.header).event_type || asObject(payload.event).message) {
    return payload;
  }

  const eventType = trimString(payload.event_type || payload.type) || 'im.message.receive_v1';
  const header = {
    app_id: trimString(payload.app_id) || undefined,
    create_time: trimString(payload.create_time) || undefined,
    event_id: trimString(payload.event_id || payload.uuid) || undefined,
    event_type: eventType,
    tenant_key: trimString(payload.tenant_key) || undefined,
    token: trimString(payload.token) || undefined,
  };

  return {
    header,
    event: payload,
  };
}

function getSdkErrorMessage(error: any) {
  return error && error.message ? error.message : String(error || 'Unknown error');
}

export function createFeishuLongConnectionSource(options: any = {}) {
  const feishuService = options.feishuService;
  const logger = options.logger || console;
  const env = options.env || process.env;
  const appId = trimString(options.appId || env.FEISHU_APP_ID);
  const appSecret = trimString(options.appSecret || env.FEISHU_APP_SECRET);
  const connectionMode = normalizeConnectionMode(options.connectionMode || env.FEISHU_CONNECTION_MODE);
  const sdkLoggerLevelValue = options.sdkLoggerLevel || env.FEISHU_LONG_CONNECTION_LOGGER_LEVEL || 'info';

  let wsClient = null as any;
  let eventDispatcher = null as any;
  let startGeneration = 0;
  let processingChain = Promise.resolve();

  function logInfo(message: string, payload: any = null) {
    if (logger && typeof logger.log === 'function') {
      logger.log(`[feishu][long-connection] ${message}`, payload || '');
    }
  }

  function logWarn(message: string, payload: any = null) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[feishu][long-connection] ${message}`, payload || '');
      return;
    }

    logInfo(message, payload);
  }

  function isEnabled() {
    return connectionMode === 'long-connection';
  }

  function loadSdk() {
    if (options.larkSdk) {
      return options.larkSdk;
    }

    try {
      return require('@larksuiteoapi/node-sdk');
    } catch (error) {
      logWarn('Failed to load @larksuiteoapi/node-sdk', {
        error: getSdkErrorMessage(error),
      });
      return null;
    }
  }

  function enqueuePayload(payload: any) {
    processingChain = processingChain
      .then(() => feishuService.handleLongConnectionEvent(payload))
      .catch((error) => {
        logWarn('Failed to process inbound Feishu long connection event', {
          error: getSdkErrorMessage(error),
        });
      });

    return processingChain;
  }

  function buildWsClientConfig(sdk: any) {
    const loggerLevel = pickSdkLoggerLevel(sdk, sdkLoggerLevelValue);
    const config = {
      appId,
      appSecret,
      autoReconnect: true,
    } as any;

    if (sdk && sdk.Domain && Object.prototype.hasOwnProperty.call(sdk.Domain, 'Feishu')) {
      config.domain = sdk.Domain.Feishu;
    }

    if (loggerLevel !== undefined) {
      config.loggerLevel = loggerLevel;
    }

    return config;
  }

  function buildEventDispatcher(sdk: any) {
    const loggerLevel = pickSdkLoggerLevel(sdk, sdkLoggerLevelValue);
    const dispatcherOptions = {} as any;

    if (loggerLevel !== undefined) {
      dispatcherOptions.loggerLevel = loggerLevel;
    }

    return new sdk.EventDispatcher(dispatcherOptions).register({
      'im.message.receive_v1': (data: any) => enqueuePayload(normalizeLongConnectionEventPayload(data)),
    });
  }

  function start() {
    if (!isEnabled() || wsClient) {
      return false;
    }

    if (!feishuService || typeof feishuService.handleLongConnectionEvent !== 'function') {
      logWarn('Service handler is unavailable');
      return false;
    }

    if (!appId || !appSecret) {
      logWarn('FEISHU_APP_ID or FEISHU_APP_SECRET is missing');
      return false;
    }

    const sdk = loadSdk();
    if (!sdk || typeof sdk.WSClient !== 'function' || typeof sdk.EventDispatcher !== 'function') {
      logWarn('Official Feishu SDK WSClient/EventDispatcher is unavailable');
      return false;
    }

    try {
      eventDispatcher = buildEventDispatcher(sdk);
      wsClient = new sdk.WSClient(buildWsClientConfig(sdk));
    } catch (error) {
      wsClient = null;
      eventDispatcher = null;
      logWarn('Failed to create SDK long connection client', {
        error: getSdkErrorMessage(error),
      });
      return false;
    }

    const activeClient = wsClient;
    const activeGeneration = ++startGeneration;
    logInfo('Starting SDK long connection client');

    Promise.resolve()
      .then(() => activeClient.start({ eventDispatcher }))
      .then(() => {
        if (wsClient !== activeClient || activeGeneration !== startGeneration) {
          return;
        }

        logInfo('SDK long connection client is ready');
      })
      .catch((error) => {
        if (wsClient === activeClient && activeGeneration === startGeneration) {
          wsClient = null;
          eventDispatcher = null;
        }

        logWarn('SDK long connection client failed to start', {
          error: getSdkErrorMessage(error),
        });
      });

    return true;
  }

  function stop() {
    startGeneration += 1;

    const activeClient = wsClient;
    wsClient = null;
    eventDispatcher = null;

    if (activeClient && typeof activeClient.close === 'function') {
      try {
        activeClient.close({ force: true });
      } catch {}
    }
  }

  return {
    isEnabled,
    start,
    stop,
  };
}
