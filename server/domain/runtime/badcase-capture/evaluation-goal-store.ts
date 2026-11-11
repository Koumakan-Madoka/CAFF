// Per-callback Goal state and append-only evidence. Never used by public context
// handlers, never imports a historical Goal, never opens an ambient database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChatAppStore } from '../../../../lib/chat-app-store';
import { createAgentToolBridge } from '../agent-tool-bridge';
import { applySessionGoalAction } from '../../conversation/session-goal';
import { buildErrorJsonPayload } from '../../../http/response';
import { containsSecretSentinel } from './secrets';
const digest = (v: any) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = () => Object.assign(Error('evaluation_callback_storage_failed'), { code: 'evaluation_callback_storage_failed', statusCode: 500 });
export const APPROXIMATE_GOAL_STATE = 'approximate-minimal-v1';

export function createEvaluationGoalStore(options: any) {
  const { directory, seed, publicStore, credentials, stage, initialState, executionId } = options;
  const goalDirectory = path.join(directory, 'goal-store');
  fs.mkdirSync(goalDirectory, { mode: 0o700 });
  const databasePath = path.join(goalDirectory, 'goal.sqlite');
  const store = createChatAppStore({ agentDir: goalDirectory, sqlitePath: databasePath });
  let bridge: ReturnType<typeof createAgentToolBridge> | undefined, context: any;
  try {
    if (process.platform === 'linux') fs.chmodSync(databasePath, 0o600);
    const conversation = publicStore.getConversation(seed.conversationId);
    const agent = publicStore.getAgent(seed.agent.id);
    if (!agent || !conversation) throw fail();
    if (!agent.id.startsWith('role-family-')) store.saveCustomRoleConfig({ id: agent.id, name: agent.name,
      description: agent.description || '', personaPrompt: 'Isolated Goal handler identity only.' });
    store.createConversation({ id: seed.conversationId, title: conversation.title, type: conversation.type,
      participants: [seed.agent.id], metadata: {} });
    store.createMessage({ id: seed.assistantMessageId, conversationId: seed.conversationId, turnId: seed.turnId,
      role: 'assistant', agentId: seed.agent.id, senderName: seed.agent.name, content: 'Thinking...', status: 'streaming' });
    const goal = initialState === 'none' ? null : applySessionGoalAction(store, seed.conversationId, {
      action: 'set', objective: 'Isolated replay Goal state approximation; not historical Room state.',
      owner: { agentId: seed.agent.id, agentName: seed.agent.name },
      acceptanceCriteria: [{ id: 'AC1', statement: 'Replay verification pending', verifyBy: 'Independent replay evidence', status: 'pending' }],
      workItems: [{ id: 'M1', text: 'Replay verification', status: 'todo' }],
    }).goal;
    const receipt = { kind: 'evaluation-goal-evidence-v1', executionId,
      goalState: goal ? APPROXIMATE_GOAL_STATE : 'unseeded', seed: goal, seedHash: digest(goal) };
    store.db.exec(`
      CREATE TABLE evaluation_goal_seed (singleton INTEGER PRIMARY KEY CHECK(singleton=1), record_json TEXT NOT NULL);
      CREATE TABLE evaluation_goal_calls (sequence INTEGER PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TRIGGER evaluation_goal_seed_no_update BEFORE UPDATE ON evaluation_goal_seed BEGIN SELECT RAISE(ABORT, 'immutable Goal seed'); END;
      CREATE TRIGGER evaluation_goal_seed_no_delete BEFORE DELETE ON evaluation_goal_seed BEGIN SELECT RAISE(ABORT, 'immutable Goal seed'); END;
      CREATE TRIGGER evaluation_goal_calls_no_update BEFORE UPDATE ON evaluation_goal_calls BEGIN SELECT RAISE(ABORT, 'immutable Goal call'); END;
      CREATE TRIGGER evaluation_goal_calls_no_delete BEFORE DELETE ON evaluation_goal_calls BEGIN SELECT RAISE(ABORT, 'immutable Goal call'); END;
    `);
    store.db.prepare('INSERT INTO evaluation_goal_seed VALUES (1, ?)').run(JSON.stringify(receipt));
    bridge = createAgentToolBridge({ store, agentDir: goalDirectory });
    context = bridge.registerInvocation(bridge.createInvocationContext({ ...credentials,
      conversationId: seed.conversationId, turnId: seed.turnId, agentId: seed.agent.id, agentName: seed.agent.name,
      userMessageId: seed.userMessage.id, assistantMessageId: seed.assistantMessageId,
      conversationAgents: store.getConversation(seed.conversationId)!.agents, stage, allowHandoffs: false }));
    function safeParameters(body: any) {
      const { invocationId: ignoredInvocation, callbackToken: ignoredAuth, ...parameters } = body;
      const serialized = JSON.stringify(parameters);
      const redacted = serialized.includes(credentials.callbackToken) || serialized.includes(credentials.invocationId) || containsSecretSentinel(serialized);
      return { parameters: redacted ? null : parameters, redacted };
    }
    function recordCall(endpoint: string, body: any, statusCode: number, response: any) {
      const { parameters, redacted } = safeParameters(body);
      const sequence = store.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM evaluation_goal_calls').get().next;
      const record = { executionId, sequence, endpoint, parameters,
        ...(redacted ? { redacted: true } : {}), statusCode, errorCode: statusCode >= 400 ? response.code ?? null : null, response };
      store.db.prepare('INSERT INTO evaluation_goal_calls (sequence, record_json) VALUES (?, ?)').run(sequence, JSON.stringify(record));
    }
    return {
      databasePath,
      readEvidence: () => ({ ...JSON.parse(store.db.prepare('SELECT record_json FROM evaluation_goal_seed WHERE singleton=1').get().record_json),
        calls: store.db.prepare('SELECT record_json FROM evaluation_goal_calls ORDER BY sequence').all().map((r: any) => JSON.parse(r.record_json)) }),
      recordCall,
      handle: store.db.transaction((endpoint: string, body: any) => {
        // Atomic state + evidence for Goal handlers; auth in arbitrary nested
        // user text must not reach mutable state, the call ledger or the WAL.
        const { redacted } = safeParameters(body);
        let statusCode = 200, response: any;
        if (redacted) { statusCode = 400; response = { error: 'evaluation_callback_body_invalid' }; }
        else try { response = endpoint === 'goal/suggest' ? bridge!.handleSuggestGoal(body) : bridge!.handleUpdateGoal(body); }
        catch (e: any) {
          if (!Number.isInteger(e?.statusCode) || e.statusCode < 400 || e.statusCode > 599) {
            statusCode = 500; response = { error: 'evaluation_callback_failed' };
          } else { statusCode = e.statusCode; response = buildErrorJsonPayload(e); }
        }
        recordCall(endpoint, body, statusCode, response);
        return { statusCode, response };
      }),
      close() { bridge!.unregisterInvocation(context.invocationId); store.close(); },
    };
  } catch (e) { if (context) bridge?.unregisterInvocation(context.invocationId); store.close(); throw e; }
}
