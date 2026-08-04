function normalizeText(value: any) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePort(value: any, fallback = 0) {
  const numberValue = Number.isInteger(value) ? value : Number.parseInt(String(value || ''), 10);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeConnectionMode(value: any) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');

  if (!normalized) {
    return 'webhook';
  }
  if (normalized === 'longconnection' || normalized === 'websocket' || normalized === 'ws') {
    return 'long-connection';
  }
  return normalized;
}

function firstRuntimeParticipant(value: any) {
  return Array.isArray(value) && value[0] && typeof value[0] === 'object' ? value[0] : null;
}

function failedAvailability(error: any, role: any) {
  const issue = Array.isArray(error?.issues) && error.issues[0] && typeof error.issues[0] === 'object'
    ? error.issues[0]
    : null;
  return normalizeText(issue?.availability?.status)
    || normalizeText(role?.availability?.status)
    || 'unavailable';
}

function projectDefaultRole(role: any, resolveRuntimeParticipants: any) {
  const base = {
    id: normalizeText(role?.id),
    name: normalizeText(role?.name),
  };

  try {
    const participant = firstRuntimeParticipant(resolveRuntimeParticipants([{ agentId: base.id }]));
    const provider = normalizeText(participant?.runtimeConfig?.provider);
    const model = normalizeText(participant?.runtimeConfig?.model);

    if (!participant || !provider || !model) {
      return {
        ...base,
        ready: false,
        availability: normalizeText(role?.availability?.status) || 'unavailable',
      };
    }

    return {
      ...base,
      ready: true,
      availability: 'available',
      provider,
      model,
    };
  } catch (error) {
    return {
      ...base,
      ready: false,
      availability: failedAvailability(error, role),
    };
  }
}

function resolveCoreAddress(options: any) {
  const fallbackHost = normalizeText(options.host) || '127.0.0.1';
  const fallbackPort = normalizePort(options.port);
  let address = null as any;

  try {
    address = typeof options.getAddress === 'function' ? options.getAddress() : null;
  } catch {}

  if (!address || typeof address !== 'object') {
    return { ready: true, host: fallbackHost, port: fallbackPort };
  }

  return {
    ready: true,
    host: normalizeText(address.address) || fallbackHost,
    port: normalizePort(address.port, fallbackPort),
  };
}

function resolveFeishuStatus(options: any) {
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  let longConnectionSdkAvailable = false;

  try {
    longConnectionSdkAvailable = Boolean(
      typeof options.isFeishuLongConnectionSdkAvailable === 'function'
        ? options.isFeishuLongConnectionSdkAvailable()
        : false
    );
  } catch {}

  return {
    configured: Boolean(normalizeText(env.FEISHU_APP_ID) && normalizeText(env.FEISHU_APP_SECRET)),
    connectionMode: normalizeConnectionMode(env.FEISHU_CONNECTION_MODE),
    longConnectionSdkAvailable,
  };
}

export function createReadinessHealthStatus(options: any = {}) {
  const getRoleDirectory = typeof options.getRoleDirectory === 'function'
    ? options.getRoleDirectory
    : () => ({ agents: [] });
  const resolveRuntimeParticipants = typeof options.resolveRuntimeParticipants === 'function'
    ? options.resolveRuntimeParticipants
    : () => [];
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  return function getReadinessHealthStatus() {
    const core = resolveCoreAddress(options);
    let chat: any;

    try {
      const directory = getRoleDirectory();
      const defaultRoles = (Array.isArray(directory?.agents) ? directory.agents : [])
        .filter((role: any) => Boolean(role?.isDefaultChatRole));
      const roles = defaultRoles.map((role: any) => projectDefaultRole(role, resolveRuntimeParticipants));
      const availableDefaultRoleCount = roles.filter((role: any) => role.ready).length;
      chat = {
        ready: availableDefaultRoleCount > 0,
        defaultRoleCount: roles.length,
        availableDefaultRoleCount,
        roles,
      };
    } catch {
      chat = {
        ready: false,
        defaultRoleCount: 0,
        availableDefaultRoleCount: 0,
        roles: [],
        issue: { code: 'role_directory_unavailable' },
      };
    }

    const timestampValue = now();
    const timestamp = timestampValue instanceof Date && Number.isFinite(timestampValue.getTime())
      ? timestampValue.toISOString()
      : new Date().toISOString();

    return {
      ok: core.ready && chat.ready,
      core,
      chat,
      optional: {
        feishu: resolveFeishuStatus(options),
      },
      timestamp,
    };
  };
}
