'use strict';

const net = require('node:net');

const INCOMPLETE = Symbol('incomplete RESP reply');

class RespReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RespReplyError';
  }
}

function readLine(buffer, offset) {
  const end = buffer.indexOf('\r\n', offset);
  if (end < 0) return INCOMPLETE;
  return { value: buffer.toString('utf8', offset, end), offset: end + 2 };
}

function parseReply(buffer, offset = 0) {
  if (offset >= buffer.length) return INCOMPLETE;
  const type = String.fromCharCode(buffer[offset]);
  const line = readLine(buffer, offset + 1);
  if (line === INCOMPLETE) return INCOMPLETE;

  if (type === '+' || type === '-' || type === ':') {
    let value = line.value;
    if (type === '-') value = new RespReplyError(line.value);
    if (type === ':') value = Number(line.value);
    return { value, offset: line.offset };
  }

  if (type === '$') {
    const length = Number(line.value);
    if (length === -1) return { value: null, offset: line.offset };
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Invalid RESP bulk length: ${line.value}`);
    const end = line.offset + length;
    if (buffer.length < end + 2) return INCOMPLETE;
    if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new Error('Invalid RESP bulk terminator');
    return { value: buffer.toString('utf8', line.offset, end), offset: end + 2 };
  }

  if (type === '*') {
    const length = Number(line.value);
    if (length === -1) return { value: null, offset: line.offset };
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`Invalid RESP array length: ${line.value}`);
    const value = [];
    let nextOffset = line.offset;
    for (let index = 0; index < length; index += 1) {
      const item = parseReply(buffer, nextOffset);
      if (item === INCOMPLETE) return INCOMPLETE;
      value.push(item.value);
      nextOffset = item.offset;
    }
    return { value, offset: nextOffset };
  }

  throw new Error(`Unsupported RESP reply type: ${type}`);
}

class RespParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const replies = [];
    let offset = 0;
    while (offset < this.buffer.length) {
      const parsed = parseReply(this.buffer, offset);
      if (parsed === INCOMPLETE) break;
      replies.push(parsed.value);
      offset = parsed.offset;
    }
    if (offset > 0) this.buffer = this.buffer.subarray(offset);
    return replies;
  }
}

function encodeCommand(parts) {
  const buffers = [Buffer.from(`*${parts.length}\r\n`)];
  for (const part of parts) {
    const value = Buffer.from(String(part), 'utf8');
    buffers.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(buffers);
}

class RespClient {
  constructor({ host = '127.0.0.1', port, connectTimeoutMs = 2_000 }) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.parser = new RespParser();
    this.pending = [];
  }

  async connect() {
    if (this.socket) throw new Error('RESP client is already connected');
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => this.rejectPending(error));
    socket.on('close', () => {
      this.rejectPending(new Error('Redis connection closed'));
      if (this.socket === socket) this.socket = null;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to Redis at ${this.host}:${this.port}`));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  handleData(chunk) {
    let replies;
    try {
      replies = this.parser.push(chunk);
    } catch (error) {
      this.rejectPending(error);
      this.close();
      return;
    }
    for (const reply of replies) {
      const pending = this.pending.shift();
      if (!pending) {
        this.close();
        throw new Error('Redis returned an unexpected reply');
      }
      if (reply instanceof RespReplyError) pending.reject(reply);
      else pending.resolve(reply);
    }
  }

  rejectPending(error) {
    while (this.pending.length > 0) this.pending.shift().reject(error);
  }

  sendCommands(commands) {
    if (!this.socket) return Promise.reject(new Error('RESP client is not connected'));
    const promises = commands.map(() => new Promise((resolve, reject) => this.pending.push({ resolve, reject })));
    this.socket.write(Buffer.concat(commands.map(encodeCommand)));
    return Promise.all(promises);
  }

  async sendCommand(parts) {
    const [reply] = await this.sendCommands([parts]);
    return reply;
  }

  close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.destroy();
    this.rejectPending(new Error('Redis connection closed by client'));
  }
}

module.exports = { RespClient, RespParser, RespReplyError, encodeCommand };
