import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import type { RouteHandler } from '../http/router';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function normalizeActionBody(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createHttpError(400, 'Request body must be a JSON object', {
      issues: [{ code: 'invalid_body', message: 'Request body must be a JSON object' }],
    });
  }

  const unknownField = Object.keys(body).find((fieldName) => fieldName !== 'reason');
  if (unknownField) {
    throw createHttpError(400, `Unknown delivery action field: ${unknownField}`, {
      issues: [{ code: 'unknown_field', field: unknownField, message: `Unknown field: ${unknownField}` }],
    });
  }

  const reason = String(body.reason || '').trim();
  if (reason.length > 500) {
    throw createHttpError(400, 'reason must be at most 500 characters', {
      issues: [{ code: 'reason_too_long', field: 'reason', message: 'reason must be at most 500 characters' }],
    });
  }

  return { reason };
}

export function createConversationDeliveriesController(options: any = {}): RouteHandler<ApiContext> {
  const store = options.store;
  const deliveryWorker = options.deliveryWorker;
  const onDeliveryAvailable = typeof options.onDeliveryAvailable === 'function'
    ? options.onDeliveryAvailable
    : null;

  function buildDeliveryPayload(deliveryId: string) {
    const delivery = store && typeof store.getCrossConversationDelivery === 'function'
      ? store.getCrossConversationDelivery(deliveryId)
      : null;
    if (!delivery) {
      throw createHttpError(404, 'Delivery not found', {
        issues: [{ code: 'cross_conversation_delivery_not_found', message: 'Delivery not found' }],
      });
    }

    const responseDelivery = typeof store.getCrossConversationResponseDelivery === 'function'
      ? store.getCrossConversationResponseDelivery(delivery.id)
      : null;
    return {
      delivery,
      targetMessage: delivery.targetMessageId ? store.getMessage(delivery.targetMessageId) : null,
      sourceReceipt: delivery.sourceReceiptMessageId ? store.getMessage(delivery.sourceReceiptMessageId) : null,
      responseDelivery,
      responseMessage: responseDelivery && responseDelivery.targetMessageId
        ? store.getMessage(responseDelivery.targetMessageId)
        : null,
      events: typeof store.listCrossConversationDeliveryEvents === 'function'
        ? store.listCrossConversationDeliveryEvents(delivery.id)
        : [],
    };
  }

  return async function handleConversationDeliveriesRequest(context) {
    const { req, res, pathname } = context;
    const match = pathname.match(/^\/api\/conversation-deliveries\/([^/]+)(?:\/(retry|cancel))?$/);
    if (!match) {
      return false;
    }

    const deliveryId = decodeURIComponent(match[1]);
    const action = match[2] || '';
    if (!action && req.method === 'GET') {
      sendJson(res, 200, buildDeliveryPayload(deliveryId));
      return true;
    }
    if (!action || req.method !== 'POST') {
      return false;
    }
    if (!deliveryWorker || typeof deliveryWorker[action] !== 'function') {
      throw createHttpError(501, 'Cross-conversation delivery actions are unavailable');
    }

    const body = normalizeActionBody(await readRequestJson(req));
    const delivery = await deliveryWorker[action](deliveryId, body.reason || undefined);
    if (action === 'retry' && onDeliveryAvailable) {
      onDeliveryAvailable(delivery);
    }
    sendJson(res, 200, buildDeliveryPayload(delivery.id));
    return true;
  };
}
