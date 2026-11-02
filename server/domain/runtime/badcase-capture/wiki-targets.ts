import crypto from 'node:crypto';
import { getGlobalPromptTarget, SEND_PUBLIC_CHAT_BRIDGE_DESCRIPTION } from '../../../../lib/agent-prompt-targets';
const fail = () => Object.assign(Error('wiki_target_unknown'), { code: 'wiki_target_unknown' });
function toolTargets() {
  // This module is metadata-only on import. The default registration function
  // and tool executors are never invoked by WikiSkill or candidate generation.
  const { listCaffToolDescriptions } = require('../../../../lib/pi-extensions/caff-capabilities.mjs');
  return listCaffToolDescriptions().map((tool: any) => ({ id: 'tool-description-' + tool.name, kind: 'tool-description',
    title: `工具描述 · ${tool.name}`, toolName: tool.name, baseText: tool.description,
    baseHash: crypto.createHash('sha256').update(tool.description).digest('hex') }));
}
function publicBridgeTarget() {
  return { id: 'tool-description-send-public', kind: 'tool-description', title: '工具描述 · send-public（公开发言）',
    toolName: 'send-public', source: 'chat-bridge-cli-description', baseText: SEND_PUBLIC_CHAT_BRIDGE_DESCRIPTION,
    baseHash: crypto.createHash('sha256').update(SEND_PUBLIC_CHAT_BRIDGE_DESCRIPTION).digest('hex') };
}
export function listWikiTargets(): any[] { return [getGlobalPromptTarget('global-harness-behavior-v1'), publicBridgeTarget(), ...toolTargets()]; }
export function getWikiTarget(id: string): any {
  if (id === 'global-harness-behavior-v1') return getGlobalPromptTarget(id);
  if (id === 'tool-description-send-public') return publicBridgeTarget();
  const target = toolTargets().find((t: any) => t.id === id);
  if (!target) throw fail();
  return target;
}
