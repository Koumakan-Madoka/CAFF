const { readRequestJson } = require('../http/request-body');
const { sendJson } = require('../http/response');
const { createHttpError } = require('../http/http-errors');

function createUndercoverController(options = {}) {
  const undercoverService = options.undercoverService;

  return async function handleUndercoverRequest(context) {
    const { req, res, pathname } = context;
    const undercoverActionMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/undercover\/(start|clue-round|vote-round|reveal|reset)$/);

    if (!undercoverActionMatch || req.method !== 'POST') {
      return false;
    }

    const conversationId = decodeURIComponent(undercoverActionMatch[1]);
    const action = undercoverActionMatch[2];
    const body = await readRequestJson(req);

    if (action !== 'start' && action !== 'reset') {
      throw createHttpError(409, '当前谁是卧底房间已切换为后端全自动模式，请直接开始新一局或重置对局');
    }

    const result =
      action === 'start'
        ? await undercoverService.startGame(conversationId, body)
        : action === 'clue-round'
          ? await undercoverService.runClueRound(conversationId)
          : action === 'vote-round'
            ? await undercoverService.runVoteRound(conversationId)
            : action === 'reveal'
              ? await undercoverService.revealGame(conversationId)
              : await undercoverService.resetGame(conversationId);

    sendJson(res, 200, result);
    return true;
  };
}

module.exports = {
  createUndercoverController,
};
