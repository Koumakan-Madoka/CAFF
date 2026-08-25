import { randomUUID } from 'node:crypto';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { projectConversationMessageEventPayload } from '../../lib/message-detail-contract';

export type SseNowFn = () => string;

export type SseInitialEvent = {
  eventName?: string;
  payload?: unknown;
};

export type SseBusOptions = {
  keepAliveMs?: number;
  now?: SseNowFn;
  drainDeadlineMs?: number;
  maxBufferBytes?: number;
};

export type SseBusOpenStreamOptions = {
  conversationId?: string;
  initialEvents?: SseInitialEvent[];
};

export type SseBusStats = {
  activeClients: number;
  backpressuredClients: number;
  queuedFrameBytes: number;
  writableBytes: number;
  disconnects: {
    byteBudget: number;
    drainTimeout: number;
  };
};

type SseFrame = {
  text: string;
  bytes: number;
};

type SseClient = {
  id: string;
  conversationId: string;
  keepAliveTimer: NodeJS.Timeout | null;
  res: ServerResponse;
  blocked: boolean;
  queue: SseFrame[];
  queuedBytes: number;
  drainTimer: NodeJS.Timeout | null;
  detachHandlers: () => void;
};

const DEFAULT_DRAIN_DEADLINE_MS = 5000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export function createSseBus(options: SseBusOptions = {}) {
  const providedKeepAliveMs = options.keepAliveMs;
  const keepAliveMs =
    typeof providedKeepAliveMs === 'number' && Number.isFinite(providedKeepAliveMs) && providedKeepAliveMs > 0
      ? providedKeepAliveMs
      : 15000;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const providedDrainDeadlineMs = options.drainDeadlineMs;
  const drainDeadlineMs =
    typeof providedDrainDeadlineMs === 'number' && Number.isFinite(providedDrainDeadlineMs) && providedDrainDeadlineMs > 0
      ? providedDrainDeadlineMs
      : DEFAULT_DRAIN_DEADLINE_MS;
  const providedMaxBufferBytes = options.maxBufferBytes;
  const maxBufferBytes =
    typeof providedMaxBufferBytes === 'number' && Number.isFinite(providedMaxBufferBytes) && providedMaxBufferBytes > 0
      ? Math.floor(providedMaxBufferBytes)
      : DEFAULT_MAX_BUFFER_BYTES;
  const clients = new Map<string, SseClient>();
  const disconnects = {
    byteBudget: 0,
    drainTimeout: 0,
  };
  let nextEventId = 1;

  function buildFrameText(eventName: string, payload: unknown) {
    const eventId = nextEventId;
    nextEventId += 1;

    let text = `id: ${eventId}\n`;

    if (eventName) {
      text += `event: ${eventName}\n`;
    }

    const body = JSON.stringify(projectConversationMessageEventPayload(eventName, payload));

    for (const line of body.split('\n')) {
      text += `data: ${line}\n`;
    }

    text += '\n';
    return text;
  }

  function clearDrainTimer(client: SseClient) {
    if (client.drainTimer) {
      clearTimeout(client.drainTimer);
      client.drainTimer = null;
    }
  }

  function armDrainDeadline(client: SseClient) {
    clearDrainTimer(client);
    client.drainTimer = setTimeout(() => {
      client.drainTimer = null;
      removeClient(client.id, 'drain_timeout');
      endClientStream(client, { force: true });
    }, drainDeadlineMs);

    if (typeof client.drainTimer.unref === 'function') {
      client.drainTimer.unref();
    }
  }

  function endClientStream(client: SseClient, options: { force?: boolean } = {}) {
    // `force` is used when a client is removed for backpressure reasons
    // (byte budget, drain deadline, oversize frame, write error): end() alone
    // leaves the accepted writable buffer alive on a stalled socket until the
    // OS flushes it (possibly never), so the removal physically destroys the
    // stream to release the socket and its buffered bytes immediately.
    try {
      client.res.end();
    } catch {}

    if (options.force === true) {
      try {
        client.res.destroy();
      } catch {}
    }
  }

  function removeClient(clientId: string, reason: 'byte_budget' | 'drain_timeout' | null = null) {
    const client = clients.get(clientId);

    if (!client) {
      return;
    }

    if (client.keepAliveTimer) {
      clearInterval(client.keepAliveTimer);
      client.keepAliveTimer = null;
    }

    clearDrainTimer(client);
    client.detachHandlers();
    client.queue = [];
    client.queuedBytes = 0;
    client.blocked = false;
    clients.delete(clientId);

    if (reason === 'byte_budget') {
      disconnects.byteBudget += 1;
    } else if (reason === 'drain_timeout') {
      disconnects.drainTimeout += 1;
    }
  }

  function flushQueue(client: SseClient) {
    while (client.queue.length > 0 && clients.has(client.id)) {
      // The head frame's bytes are included in queuedBytes, so the combined
      // budget for the pending write is queuedBytes + writableLength.
      if (client.queuedBytes + client.res.writableLength > maxBufferBytes) {
        removeClient(client.id, 'byte_budget');
        endClientStream(client, { force: true });
        return;
      }

      const frame = client.queue.shift();

      if (!frame) {
        break;
      }

      client.queuedBytes -= frame.bytes;

      let writeOk: boolean;

      try {
        writeOk = client.res.write(frame.text);
      } catch {
        removeClient(client.id);
        endClientStream(client, { force: true });
        return;
      }

      if (writeOk === false) {
        client.blocked = true;
        armDrainDeadline(client);
        return;
      }
    }
  }

  function writeFrame(client: SseClient, text: string) {
    if (!clients.has(client.id)) {
      return;
    }

    const bytes = Buffer.byteLength(text);

    // A single frame larger than the budget removes the client before that
    // frame is written, even when its buffers are otherwise empty.
    if (bytes > maxBufferBytes || client.queuedBytes + client.res.writableLength + bytes > maxBufferBytes) {
      removeClient(client.id, 'byte_budget');
      endClientStream(client, { force: true });
      return;
    }

    if (client.blocked) {
      client.queue.push({ text, bytes });
      client.queuedBytes += bytes;
      return;
    }

    let writeOk: boolean;

    try {
      writeOk = client.res.write(text);
    } catch {
      removeClient(client.id);
      endClientStream(client, { force: true });
      return;
    }

    if (writeOk === false) {
      client.blocked = true;
      armDrainDeadline(client);
    }
  }

  function writeClientEvent(client: SseClient, eventName: string, payload: unknown) {
    writeFrame(client, buildFrameText(eventName, payload));
  }

  function broadcast(eventName: string, payload: any) {
    // Serialize the frame once and reuse it for every matching client.
    const frameText = buildFrameText(eventName, payload);

    for (const client of clients.values()) {
      if (client.conversationId && payload && payload.conversationId && client.conversationId !== payload.conversationId) {
        continue;
      }

      writeFrame(client, frameText);
    }
  }

  function openStream(req: IncomingMessage, res: ServerResponse, options: SseBusOpenStreamOptions = {}) {
    const clientId = randomUUID();
    const conversationId = String(options.conversationId || '').trim();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const client: SseClient = {
      id: clientId,
      conversationId,
      keepAliveTimer: null,
      res,
      blocked: false,
      queue: [],
      queuedBytes: 0,
      drainTimer: null,
      detachHandlers: () => {},
    };

    const onDrain = () => {
      if (!clients.has(clientId)) {
        return;
      }

      clearDrainTimer(client);
      client.blocked = false;
      flushQueue(client);
    };
    const onClose = () => {
      removeClient(clientId);
    };
    const onError = () => {
      removeClient(clientId);
      endClientStream(client, { force: true });
    };

    client.detachHandlers = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
    };

    clients.set(clientId, client);

    res.on('drain', onDrain);
    res.on('close', onClose);
    res.on('error', onError);

    // Prelude shares the same backpressure accounting.
    writeFrame(client, ': connected\n\n');

    if (clients.has(clientId)) {
      const keepAliveTimer = setInterval(() => {
        writeClientEvent(client, 'ping', { timestamp: now() });
      }, keepAliveMs);

      if (typeof keepAliveTimer.unref === 'function') {
        keepAliveTimer.unref();
      }

      client.keepAliveTimer = keepAliveTimer;
    }

    for (const event of Array.isArray(options.initialEvents) ? options.initialEvents : []) {
      writeClientEvent(client, event.eventName || '', Object.prototype.hasOwnProperty.call(event, 'payload') ? event.payload : null);
    }

    req.on('close', () => {
      removeClient(clientId);
    });
  }

  function getStats(): SseBusStats {
    let backpressuredClients = 0;
    let queuedFrameBytes = 0;
    let writableBytes = 0;

    for (const client of clients.values()) {
      if (client.blocked) {
        backpressuredClients += 1;
      }

      queuedFrameBytes += client.queuedBytes;
      writableBytes += client.res.writableLength;
    }

    return {
      activeClients: clients.size,
      backpressuredClients,
      queuedFrameBytes,
      writableBytes,
      disconnects: {
        byteBudget: disconnects.byteBudget,
        drainTimeout: disconnects.drainTimeout,
      },
    };
  }

  function writeEvent(res: ServerResponse, eventName: string, payload: unknown) {
    for (const client of clients.values()) {
      if (client.res === res) {
        writeClientEvent(client, eventName, payload);
        return;
      }
    }

    // Legacy fallback for streams not registered with this bus.
    res.write(buildFrameText(eventName, payload));
  }

  function closeAll() {
    for (const client of clients.values()) {
      if (client.keepAliveTimer) {
        clearInterval(client.keepAliveTimer);
        client.keepAliveTimer = null;
      }

      clearDrainTimer(client);
      client.detachHandlers();
      client.queue = [];
      client.queuedBytes = 0;
      client.blocked = false;

      try {
        client.res.end();
      } catch {}
    }

    clients.clear();
  }

  return {
    broadcast,
    closeAll,
    getStats,
    openStream,
    writeEvent,
  };
}
