import { createHash } from 'node:crypto';
import { createHttpError } from '../../http/http-errors';

export function plannerRoomCreationKey(req: any): string {
  const value = req.headers?.['idempotency-key'];
  let count = typeof value === 'string' ? 1 : 0;
  if (Array.isArray(req.rawHeaders)) {
    count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (String(req.rawHeaders[i]).toLowerCase() === 'idempotency-key') count++;
  }
  if (count !== 1 || typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw createHttpError(400, 'Planner Room creation requires an Idempotency-Key', { code: 'idempotency_key_required' });
  }
  return value; // opaque; whitespace checking is not key normalization
}
const text = (value: any) => String(value || '').trim();
function skillIds(value: any): string[] {
  return [...new Set<string>((Array.isArray(value) ? value : []).map(skill => typeof skill === 'string' ? skill.trim()
    : skill && typeof skill === 'object' ? text(skill.id || skill.skillId || skill.slug || skill.name) : '').filter(Boolean))];
}
// This is caller intent, NOT resolved configuration. Keep in sync with roster
// syntax, but never read current roles/profiles/mode defaults on a replay.
export function plannerRoomCreationDigest(body: any): string {
  const participants = Array.isArray(body.participants) ? body.participants.map((participant: any) => {
    const object = participant && typeof participant === 'object' ? participant : {};
    return {
      agentId: typeof participant === 'string' ? participant.trim() : text(object.agentId || object.id),
      modelProfileId: text(object.modelProfileId || object.selectedModelProfileId) || null,
      conversationSkillIds: skillIds(object.conversationSkillIds || object.conversationSkills || object.sessionSkillIds || object.sessionSkills),
    };
  }) : null;
  const intent = { version: 1, title: text(body.title) || null, projectScopeId: text(body.projectScopeId), modeId: text(body.modeId), participants };
  return createHash('sha256').update(JSON.stringify(intent), 'utf8').digest('hex');
}
