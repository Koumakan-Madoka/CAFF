const { sendJson } = require('../http/response');

function createBootstrapController(options = {}) {
  const sseBus = options.sseBus;
  const turnOrchestrator = options.turnOrchestrator;
  const buildBootstrapPayload = options.buildBootstrapPayload;

  return async function handleBootstrapRequest(context) {
    const { req, res, pathname, requestUrl } = context;

    if (req.method === 'GET' && pathname === '/api/events') {
      const conversationId = String(requestUrl.searchParams.get('conversationId') || '').trim();
      const turnEvents = turnOrchestrator.listTurnSummaries({ conversationId }).map((turn) => ({
        eventName: 'turn_progress',
        payload: {
          conversationId: turn.conversationId,
          turn,
        },
      }));

      sseBus.openStream(req, res, {
        conversationId,
        initialEvents: [
          {
            eventName: 'runtime_state',
            payload: turnOrchestrator.buildRuntimePayload(),
          },
          ...turnEvents,
        ],
      });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      sendJson(res, 200, buildBootstrapPayload());
      return true;
    }

    return false;
  };
}

module.exports = {
  createBootstrapController,
};
