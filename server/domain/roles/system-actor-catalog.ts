export const RECOVERY_SCRIBE_SYSTEM_ACTOR = Object.freeze({
  id: 'recovery_scribe',
  type: 'recovery_scribe',
  displayName: '系统书记',
  mechanicalDisplayName: '系统书记（机械摘要）',
  routable: false,
});

export const NON_ROUTABLE_SYSTEM_ACTOR_IDS = Object.freeze([
  RECOVERY_SCRIBE_SYSTEM_ACTOR.id,
]);

export const RESERVED_SYSTEM_ACTOR_NAMES = Object.freeze([
  RECOVERY_SCRIBE_SYSTEM_ACTOR.displayName,
  RECOVERY_SCRIBE_SYSTEM_ACTOR.mechanicalDisplayName,
  'Recovery Scribe',
  'Recovery Scribe (Mechanical)',
]);

const NON_ROUTABLE_SYSTEM_ACTOR_ID_SET = new Set<string>(NON_ROUTABLE_SYSTEM_ACTOR_IDS);
const RESERVED_SYSTEM_ACTOR_NAME_SET = new Set<string>(
  RESERVED_SYSTEM_ACTOR_NAMES.map((name) => normalizeSystemActorName(name))
);

function normalizeSystemActorName(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isNonRoutableSystemActorId(value: any) {
  return NON_ROUTABLE_SYSTEM_ACTOR_ID_SET.has(String(value || '').trim());
}

export function isReservedSystemActorName(value: any) {
  return RESERVED_SYSTEM_ACTOR_NAME_SET.has(normalizeSystemActorName(value));
}

export function isRoutableConversationAgent(agent: any) {
  const id = String(agent && (agent.id || agent.agentId) || '').trim();
  const name = String(agent && agent.name || '').trim();
  return Boolean(id)
    && !isNonRoutableSystemActorId(id)
    && !isReservedSystemActorName(name);
}

export function filterRoutableConversationAgents(agents: any) {
  return (Array.isArray(agents) ? agents : []).filter(isRoutableConversationAgent);
}
