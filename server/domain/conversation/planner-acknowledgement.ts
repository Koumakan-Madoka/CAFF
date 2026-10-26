const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const ids = (value: any) => Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
function publicPrincipal(value: any) {
  const p = object(value);
  if (p.kind === 'user' || p.kind === 'system') return { kind: p.kind };
  if (p.kind === 'planner' && typeof p.plannerId === 'string') return { kind: p.kind, plannerId: p.plannerId, plannerName: String(p.plannerName || '') };
  if (p.kind === 'agent' && typeof p.agentId === 'string') return { kind: p.kind, agentId: p.agentId, agentName: String(p.agentName || '') };
  return undefined;
}
// Acceptance is not a message read. Images can embed the text body as a
// contentBlocks entry; spreading metadata would silently defeat the lean API.
export function plannerMessageAcknowledgement(message: any) {
  const source = object(message?.metadata), metadata: any = {};
  for (const key of ['clientRequestId', 'source', 'routingStatus', 'routingRecordedAt', 'routingDispatchedAt', 'dispatchLane', 'dispatchTargetAgentId', 'goalId']) {
    if (typeof source[key] === 'string') metadata[key] = source[key];
  }
  const principal = publicPrincipal(source.principal); if (principal) metadata.principal = principal;
  if (source.routing && typeof source.routing === 'object') {
    const routing = object(source.routing);
    metadata.routing = { agentIds: ids(routing.agentIds) };
    for (const key of ['strategy', 'executionMode', 'explicitIntent']) if (typeof routing[key] === 'string') metadata.routing[key] = routing[key].slice(0, 80);
  }
  for (const key of ['goalRevision', 'goalIteration', 'goalMaxIterations']) if (Number.isSafeInteger(source[key])) metadata[key] = source[key];
  if (typeof source.goalAutoContinue === 'boolean') metadata.goalAutoContinue = source.goalAutoContinue;
  if (Array.isArray(source.initialAgentIds)) metadata.initialAgentIds = ids(source.initialAgentIds);
  return { id: message.id, senderName: message.senderName, role: message.role, metadata };
}
export function plannerContinuationAcknowledgement(value: any) {
  if (!value) return null;
  return { scheduled: value.scheduled === true, reason: value.reason,
    ...(typeof value.dispatch === 'string' ? { dispatch: value.dispatch } : {}),
    ...(value.message ? { message: plannerMessageAcknowledgement(value.message) } : {}) };
}
