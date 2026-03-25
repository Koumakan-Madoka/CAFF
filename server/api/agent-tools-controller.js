const { readRequestJson } = require('../http/request-body');
const { sendJson } = require('../http/response');

function createAgentToolsController(options = {}) {
  const agentToolBridge = options.agentToolBridge;

  return async function handleAgentToolsRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (pathname === '/api/agent-tools/post-message' && req.method === 'POST') {
      const body = await readRequestJson(req);
      sendJson(res, 200, agentToolBridge.handlePostMessage(body));
      return true;
    }

    if (pathname === '/api/agent-tools/context' && req.method === 'GET') {
      sendJson(res, 200, agentToolBridge.handleReadContext(requestUrl));
      return true;
    }

    if (pathname === '/api/agent-tools/participants' && req.method === 'GET') {
      sendJson(res, 200, agentToolBridge.handleListParticipants(requestUrl));
      return true;
    }

    return false;
  };
}

module.exports = {
  createAgentToolsController,
};
