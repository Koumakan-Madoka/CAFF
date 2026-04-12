const FEISHU_API_BASE_URL = 'https://open.feishu.cn';
const TOKEN_EXPIRY_SAFETY_WINDOW_MS = 60 * 1000;

function trimString(value: any) {
  return String(value || '').trim();
}

function resolveFetchImplementation(candidate: any) {
  if (typeof candidate === 'function') {
    return candidate;
  }

  if (typeof fetch === 'function') {
    return fetch.bind(globalThis);
  }

  throw new Error('Global fetch is not available in this environment');
}

function extractFeishuApiError(payload: any, fallbackStatus: any) {
  if (!payload || typeof payload !== 'object') {
    return `Feishu API request failed (${fallbackStatus})`;
  }

  return String(payload.msg || payload.message || payload.error || `Feishu API request failed (${fallbackStatus})`).trim();
}

function extractBotOpenId(payload: any) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  return trimString(
    payload.open_id
      || payload.bot_open_id
      || (payload.bot && payload.bot.open_id)
      || (payload.data && payload.data.open_id)
      || (payload.data && payload.data.bot && payload.data.bot.open_id)
  );
}

export function createFeishuClient(options: any = {}) {
  const fetchImpl = resolveFetchImplementation(options.fetch);
  const baseUrl = trimString(options.baseUrl || FEISHU_API_BASE_URL).replace(/\/+$/u, '') || FEISHU_API_BASE_URL;
  const appId = trimString(options.appId || process.env.FEISHU_APP_ID);
  const appSecret = trimString(options.appSecret || process.env.FEISHU_APP_SECRET);
  const fallbackBotOpenId = trimString(options.botOpenId || process.env.FEISHU_BOT_OPEN_ID);

  let tenantAccessToken = '';
  let tenantAccessTokenExpiresAt = 0;
  let cachedBotOpenId = '';
  let botInfoPromise = null as Promise<string> | null;

  function hasAppCredentials() {
    return Boolean(appId && appSecret);
  }

  async function requestJson(pathname: string, init: any = {}) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, init);
    const text = await response.text();
    let payload = {} as any;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Feishu API returned invalid JSON (${response.status})`);
      }
    }

    if (!response.ok) {
      throw new Error(extractFeishuApiError(payload, response.status));
    }

    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code') && Number(payload.code) !== 0) {
      throw new Error(extractFeishuApiError(payload, response.status));
    }

    return payload;
  }

  async function getTenantAccessToken(forceRefresh = false) {
    if (!hasAppCredentials()) {
      throw new Error('Feishu app credentials are not configured');
    }

    const now = Date.now();
    if (!forceRefresh && tenantAccessToken && tenantAccessTokenExpiresAt > now + TOKEN_EXPIRY_SAFETY_WINDOW_MS) {
      return tenantAccessToken;
    }

    const payload = await requestJson('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
    });

    const nextToken = trimString(payload.tenant_access_token || payload.access_token);
    if (!nextToken) {
      throw new Error('Feishu tenant access token response did not include a token');
    }

    const expireSeconds = Number(payload.expire || payload.expires_in || 7200);
    tenantAccessToken = nextToken;
    tenantAccessTokenExpiresAt = now + Math.max(60, Number.isFinite(expireSeconds) ? expireSeconds : 7200) * 1000;
    return tenantAccessToken;
  }

  async function fetchBotOpenId() {
    if (!hasAppCredentials()) {
      return fallbackBotOpenId;
    }

    const token = await getTenantAccessToken();
    const payload = await requestJson('/open-apis/bot/v3/info', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const nextBotOpenId = extractBotOpenId(payload);
    if (!nextBotOpenId) {
      throw new Error('Feishu bot info response did not include bot open_id');
    }

    cachedBotOpenId = nextBotOpenId;
    return cachedBotOpenId;
  }

  async function initialize() {
    if (!hasAppCredentials()) {
      return fallbackBotOpenId || '';
    }

    if (!botInfoPromise) {
      botInfoPromise = fetchBotOpenId()
        .catch(() => fallbackBotOpenId || '')
        .finally(() => {
          botInfoPromise = null;
        });
    }

    return botInfoPromise;
  }

  async function ensureBotOpenId() {
    if (cachedBotOpenId) {
      return cachedBotOpenId;
    }

    if (botInfoPromise) {
      const resolved = await botInfoPromise;
      if (resolved) {
        cachedBotOpenId = resolved;
      }
    }

    if (!cachedBotOpenId && hasAppCredentials()) {
      try {
        cachedBotOpenId = await fetchBotOpenId();
      } catch {
        cachedBotOpenId = fallbackBotOpenId || '';
      }
    }

    return cachedBotOpenId || fallbackBotOpenId || '';
  }

  async function sendTextMessage(chatId: string, text: string) {
    const normalizedChatId = trimString(chatId);
    const normalizedText = String(text || '').trim();

    if (!normalizedChatId) {
      throw new Error('Feishu chat_id is required');
    }

    if (!normalizedText) {
      throw new Error('Feishu outbound text is required');
    }

    const token = await getTenantAccessToken();
    const payload = await requestJson('/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: normalizedChatId,
        msg_type: 'text',
        content: JSON.stringify({
          text: normalizedText,
        }),
      }),
    });

    return {
      messageId: trimString(
        (payload.data && payload.data.message_id)
          || (payload.data && payload.data.message && payload.data.message.message_id)
          || payload.message_id
      ),
      payload,
    };
  }

  return {
    ensureBotOpenId,
    getTenantAccessToken,
    initialize,
    sendTextMessage,
  };
}
