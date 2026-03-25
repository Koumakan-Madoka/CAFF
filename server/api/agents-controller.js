const { readRequestJson } = require('../http/request-body');
const { sendJson } = require('../http/response');

function createAgentsController(options = {}) {
  const store = options.store;
  const skillRegistry = options.skillRegistry;
  const buildConfiguredModelOptions = options.buildConfiguredModelOptions;

  return async function handleAgentsRequest(context) {
    const { req, res, pathname } = context;

    if (req.method === 'GET' && pathname === '/api/agents') {
      sendJson(res, 200, {
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/agents') {
      const body = await readRequestJson(req);
      const agent = store.saveAgent(body);
      sendJson(res, 201, {
        agent,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);

    if (!agentMatch) {
      return false;
    }

    const agentId = decodeURIComponent(agentMatch[1]);

    if (req.method === 'PUT') {
      const body = await readRequestJson(req);
      const agent = store.saveAgent({ ...body, id: agentId });
      sendJson(res, 200, {
        agent,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
      });
      return true;
    }

    if (req.method === 'DELETE') {
      store.deleteAgent(agentId);
      sendJson(res, 200, {
        deletedId: agentId,
        agents: store.listAgents(),
        modelOptions: buildConfiguredModelOptions(),
        skills: skillRegistry.listSkills(),
        conversations: store.listConversations(),
      });
      return true;
    }

    return false;
  };
}

module.exports = {
  createAgentsController,
};
