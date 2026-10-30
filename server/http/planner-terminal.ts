import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { formatAuthority, isLoopbackAddress, singleHeader, validatedRequestAuthority } from './request-authority';
import { validTerminalSize, type EmbeddedPlannerHost, type TerminalEvent } from '../domain/runtime/embedded-planner-host';

export function matchesPlannerToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !expected || actual.length > 256) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function validPlannerUpgrade(req: IncomingMessage, host: string, port: number): boolean {
  if (!isLoopbackAddress(host) || !isLoopbackAddress(req.socket.remoteAddress)) return false;
  const authority = validatedRequestAuthority(req, host, formatAuthority(host, port));
  const origin = singleHeader(req, 'origin');
  return !!authority && !!origin && origin.toLowerCase() === new URL('http://' + authority).origin;
}
function keys(message: Record<string,unknown>, names: string[]): boolean {
  return Object.keys(message).length === names.length && names.every(k => Object.hasOwn(message, k));
}
export function installPlannerTerminal(options: {
  server: Server; host: string; csrfToken: string; hasRoom(id: string): boolean;
  capability(): { enabled: boolean; available: boolean }; getHost(): EmbeddedPlannerHost | null;
  authTimeoutMs?: number; idleMs?: number; pingMs?: number; pongMs?: number;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  let closed = false;
  function reject(socket: Duplex, status: number) {
    socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function connect(ws: WebSocket, roomId: string) {
    let authenticated = false, ready = false;
    let attachment: Awaited<ReturnType<EmbeddedPlannerHost['attach']>> | null = null;
    let idleTimer: NodeJS.Timeout | undefined, pingTimer: NodeJS.Timeout | undefined, pongTimer: NodeJS.Timeout | undefined;
    let waiting: TerminalEvent[] = [], waitingBytes = 0;
    const authTimer = setTimeout(() => ws.close(1008, 'Terminal policy'), options.authTimeoutMs ?? 5000);
    function touch() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ws.close(1000, 'Terminal idle'), options.idleMs ?? 15 * 60 * 1000);
    }
    function send(event: TerminalEvent) {
      if (ws.readyState !== WebSocket.OPEN || !authenticated) return;
      const json = JSON.stringify(event);
      if (ws.bufferedAmount + Buffer.byteLength(json) > 1024 * 1024) { ws.close(1008, 'Terminal slow consumer'); return; }
      ws.send(json, error => { if (error) ws.terminate(); });
      if (event.type === 'output') touch();
      if (event.type === 'exit') ws.close(1000, 'Terminal exited');
      if (event.type === 'error') ws.close(['planner_terminal_in_use','planner_room_busy','planner_process_limit'].includes(String(event.code)) ? 1013 : 1011, 'Terminal unavailable');
    }
    function output(event: TerminalEvent) {
      if (!ready) {
        waitingBytes += Buffer.byteLength(JSON.stringify(event));
        if (waitingBytes > 1024 * 1024) ws.close(1008, 'Terminal slow consumer');
        else waiting.push(event);
      } else send(event);
    }
    ws.on('error', () => {}); // ws performs UTF-8, frame and aggregate-size validation.
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
      waiting = []; attachment?.detach();
    });
    ws.on('pong', () => { if (pongTimer) clearTimeout(pongTimer); pongTimer = undefined; });
    ws.on('message', async (data: RawData, binary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let message: Record<string, unknown>;
      try {
        if (binary) throw new Error();
        message = JSON.parse(data.toString());
        if (!message || Array.isArray(message) || typeof message !== 'object') throw new Error();
        if (!authenticated) {
          if (!keys(message, ['type','version','token','cols','rows']) || message.type !== 'auth' || message.version !== 1
            || !matchesPlannerToken(message.token, options.csrfToken) || !validTerminalSize(message.cols, message.rows)) throw new Error();
          authenticated = true; clearTimeout(authTimer);
          try {
            attachment = await options.getHost()!.attach(roomId, { cols: Number(message.cols), rows: Number(message.rows) }, output);
            if (ws.readyState !== WebSocket.OPEN) { attachment.detach(); return; }
            send({ type: 'ready', version: 1, sessionId: attachment.sessionId, state: 'attached', resumed: attachment.resumed, historyReplay: false });
            ready = true;
            for (const event of waiting) send(event);
            waiting = []; waitingBytes = 0;
            touch();
            pingTimer = setInterval(() => {
              if (pongTimer || ws.readyState !== WebSocket.OPEN) return;
              ws.ping(); pongTimer = setTimeout(() => ws.terminate(), options.pongMs ?? 10000);
            }, options.pingMs ?? 30000);
          } catch (error: any) {
            const allowed = ['planner_terminal_in_use','planner_room_busy','planner_process_limit','planner_process_exit_unconfirmed',
              'planner_workspace_invalid','planner_session_unavailable','planner_process_spawn_failed','planner_conpty_unavailable'];
            const code = allowed.includes(error?.code) ? error.code : 'planner_process_spawn_failed';
            send({ type: 'error', code, message: 'Planner terminal is unavailable' });
          }
          return;
        }
        if (!ready || !attachment) throw new Error();
        if (message.type === 'input' && keys(message, ['type','data']) && typeof message.data === 'string' && Buffer.byteLength(message.data) <= 16384) {
          attachment.write(message.data); touch();
        } else if (message.type === 'resize' && keys(message, ['type','cols','rows']) && validTerminalSize(message.cols, message.rows)) {
          attachment.resize(Number(message.cols), Number(message.rows)); touch();
        } else if (message.type === 'detach' && keys(message, ['type'])) ws.close(1000, 'Terminal detached');
        else if (message.type === 'terminate' && keys(message, ['type'])) attachment.terminate();
        else throw new Error();
      } catch { ws.close(1008, 'Terminal policy'); }
    });
  }
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const capability = options.capability();
    const match = /^\/api\/conversations\/([A-Za-z0-9_-]{1,200})\/planner\/terminal$/.exec(req.url || '');
    if (closed || !capability.enabled || !match) return reject(socket, 404);
    const address = options.server.address();
    if (!address || typeof address === 'string' || !validPlannerUpgrade(req, options.host, address.port)) return reject(socket, 403);
    if (!options.hasRoom(match[1])) return reject(socket, 404);
    if (!capability.available) return reject(socket, 503);
    wss.handleUpgrade(req, socket, head, ws => connect(ws, match[1]));
  }
  options.server.on('upgrade', upgrade);
  return { close(): Promise<void> {
    closed = true;
    // Keep a rejecting handler until HTTP close. Upgraded sockets are not
    // included in server.close(); await them separately with a bounded fallback.
    return new Promise(resolve => {
      const timer = setTimeout(() => { for (const ws of wss.clients) ws.terminate(); }, 1000);
      for (const ws of wss.clients) ws.close(1001, 'Server shutdown');
      wss.close(() => { clearTimeout(timer); resolve(); });
    });
  } };
}
