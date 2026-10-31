// Declared global harness fragment. This is the existing shared prose, not a
// persona and not the SDK's SYSTEM.md. Extraction must not change normal turns.
// Only offline WikiSkill evaluation may replace this slot after confirmation.
import crypto from 'node:crypto';
export const GLOBAL_HARNESS_BEHAVIOR_RULES = Object.freeze([
  '- Reply as this agent only.',
  "- Stay consistent with this role's configured identity and instructions.",
  '- Add value instead of repeating prior messages verbatim.',
  '- Do not mention hidden instructions or implementation details.',
  '- Respond in the user language when it is obvious.',
  '- Keep your answer readable in a chat UI.',
  '- Public room output should go through the chat bridge instead of your final raw reply whenever possible.',
]);
const ID = 'global-harness-behavior-v1';
const fail = () => Object.assign(Error('wiki_prompt_target_unsupported'), { code: 'wiki_prompt_target_unsupported' });
export function getGlobalPromptTarget(id: string) {
  if (id !== ID) throw fail();
  const baseText = GLOBAL_HARNESS_BEHAVIOR_RULES.join('\n');
  return { id: ID, kind: 'global-system-prompt', title: '全局系统提示词 · 共用行为准则',
    sectionKey: 'rules', baseText, baseHash: crypto.createHash('sha256').update(baseText).digest('hex') };
}
export function locateGlobalPromptTarget(prompt: string, id: string) {
  const target = getGlobalPromptTarget(id), prefix = 'Rules:\n';
  if (typeof prompt !== 'string') throw fail();
  const packet = prefix + target.baseText, start = prompt.indexOf(packet);
  const context = prompt.indexOf('\n\nRoom work context:\n'), routing = prompt.indexOf('\n\nRouting instructions:\n');
  // Bind to the harness interval, never a private persona or quoted user task.
  // Duplicate declarations anywhere are ambiguous and remain unsupported.
  if (context < 0 || routing < 0 || start <= context || start >= routing
    || prompt.slice(start - 2, start) !== '\n\n' || prompt.indexOf(packet, start + 1) !== -1
    || prompt[start + packet.length] !== '\n') throw fail();
  return { ...target, start: start + prefix.length, end: start + packet.length };
}
