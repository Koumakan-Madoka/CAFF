import { getSessionGoal } from './session-goal';
import { createPlannerAttentionRepository } from '../../../storage/chat/planner-attention.repository';

const ROOTS = new Set(['conversation_turn', 'conversation_side_dispatch']);
function parse(value: any) { try { return JSON.parse(value || 'null'); } catch { return null; } }
function actualAgents(value: any): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) return [];
  return [...new Set<string>(value.map(id => id.trim()))].sort();
}

// Run-only databases have no chat schema. Do not create it or fabricate Room
// associations. In the server, the chat store migrates first, before admission.
export function createPlannerTurnAttention(db: any) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_planner_attention'").get()) return null;
  const repository = createPlannerAttentionRepository(db);
  const header = db.prepare('SELECT metadata_json FROM chat_conversations WHERE id=?');
  function goal(conversationId: any) {
    if (typeof conversationId !== 'string' || !conversationId) return null;
    return getSessionGoal({ metadata: parse(header.get(conversationId)?.metadata_json) || {} });
  }
  return {
    startingMetadata(kind: string, metadata: any) {
      if (!ROOTS.has(kind)) return metadata;
      const current = goal(metadata?.conversationId);
      return { ...metadata, goalContext: current ? { goalId: current.goalId, revision: current.revision } : null };
    },
    preserveStartingMetadata(before: any, updates: any) {
      if (!ROOTS.has(before?.kind) || !Object.hasOwn(updates, 'metadataJson')) return updates;
      const initial = parse(before.metadata_json) || {};
      return { ...updates, metadataJson: JSON.stringify({ ...(parse(updates.metadataJson) || {}),
        conversationId: initial.conversationId, turnId: initial.turnId, goalContext: initial.goalContext }) };
    },
    terminal(before: any, next: any, interrupted = false) {
      if (!ROOTS.has(before?.kind) || !['queued', 'running'].includes(before.status)
        || !['failed', 'succeeded'].includes(next?.status)) return;
      const metadata = parse(before.metadata_json), context = metadata?.goalContext;
      if (!context?.goalId || !Number.isSafeInteger(context.revision) || context.revision < 1
        || typeof metadata?.turnId !== 'string' || !metadata.turnId) return;
      const current = goal(metadata.conversationId);
      if (!current || current.goalId !== context.goalId) return;
      const lane = before.kind === 'conversation_side_dispatch' ? 'side' : 'main';
      const at = next.ended_at || new Date().toISOString();
      const artifact = parse(next.artifact_summary_json);
      if (next.status === 'failed') {
        const agents = interrupted ? [] : actualAgents(artifact?.failedAgentIds);
        const item = repository.append({ conversationId: metadata.conversationId, goalId: current.goalId,
          goalRevision: current.revision, kind: 'turn_failed', sourceId: metadata.turnId,
          summary: 'Goal-associated turn failed', failedAgentIds: agents.length ? agents : ['unknown'], lane, createdAt: at });
        if (!item) throw new Error('Persisted turn attention occurrence is missing');
        if (current.status === 'complete' && !item.resolvedAt) repository.resolve(item.sequence, 'goal_completed', { kind: 'system' }, at);
      } else {
        for (const agentId of actualAgents(artifact?.completedAgentIds)) {
          repository.resolveSuccessfulTurn(metadata.conversationId, current.goalId, lane, agentId, at);
        }
      }
    },
  };
}
