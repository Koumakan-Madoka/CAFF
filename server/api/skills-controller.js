const { readRequestJson } = require('../http/request-body');
const { sendJson } = require('../http/response');
const { createHttpError } = require('../http/http-errors');
const { sanitizeSkillId } = require('../../lib/skill-registry');

function createSkillsController(options = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;

  return async function handleSkillsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/skills') {
      sendJson(res, 200, {
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/skills') {
      const body = await readRequestJson(req);
      const skill = skillRegistry.saveSkill(body);
      sendJson(res, 201, {
        skill,
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    const skillFileMatch = pathname.match(/^\/api\/skills\/([^/]+)\/files$/);

    if (skillFileMatch) {
      const skillId = sanitizeSkillId(decodeURIComponent(skillFileMatch[1]));
      const filePath = requestUrl.searchParams.get('path') || '';

      if (req.method === 'GET') {
        const file = skillRegistry.getSkillFile(skillId, filePath);
        sendJson(res, 200, { file });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readRequestJson(req);
        const result = skillRegistry.saveSkillFile(skillId, filePath, body.content);
        sendJson(res, 200, {
          ...result,
          skills: skillRegistry.listSkills(),
        });
        return true;
      }

      if (req.method === 'DELETE') {
        const result = skillRegistry.deleteSkillFile(skillId, filePath);
        sendJson(res, 200, {
          ...result,
          skills: skillRegistry.listSkills(),
        });
        return true;
      }

      return false;
    }

    const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);

    if (skillMatch) {
      const skillId = sanitizeSkillId(decodeURIComponent(skillMatch[1]));

      if (req.method === 'GET') {
        const skill = skillRegistry.getSkill(skillId);

        if (!skill) {
          throw createHttpError(404, 'Skill not found');
        }

        sendJson(res, 200, { skill });
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readRequestJson(req);
        const skill = skillRegistry.saveSkill({ ...body, id: skillId });
        sendJson(res, 200, {
          skill,
          skills: skillRegistry.listSkills(),
        });
        return true;
      }

      if (req.method === 'DELETE') {
        const references = store.findSkillReferences(skillId);

        if (references.length > 0) {
          throw createHttpError(409, 'Skill is still referenced by personas or conversations', {
            references,
          });
        }

        if (!skillRegistry.deleteSkill(skillId)) {
          throw createHttpError(404, 'Skill not found');
        }

        sendJson(res, 200, {
          deletedId: skillId,
          skills: skillRegistry.listSkills(),
        });
        return true;
      }

      return false;
    }

    return false;
  };
}

module.exports = {
  createSkillsController,
};
