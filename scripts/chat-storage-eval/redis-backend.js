'use strict';

const { RedisProcessManager } = require('./redis-process');
const { RespClient, RespReplyError } = require('./resp-client');

function messageKey(messageId) {
  return `caff-eval:message:${messageId}`;
}

function threadKey(threadId) {
  return `caff-eval:thread:${threadId}:messages`;
}

function messageHashCommand(message) {
  return [
    'HSET', messageKey(message.id),
    'id', message.id,
    'threadId', message.threadId,
    'userId', message.userId,
    'sequence', message.sequence,
    'content', message.content,
    'status', message.status,
    'createdAt', message.createdAt,
    'mentions', JSON.stringify(message.mentions),
  ];
}

function mapHash(reply) {
  if (!reply || reply.length === 0) return null;
  const values = {};
  for (let index = 0; index < reply.length; index += 2) values[reply[index]] = reply[index + 1];
  return {
    id: values.id,
    threadId: values.threadId,
    userId: values.userId,
    sequence: Number(values.sequence),
    content: values.content,
    status: values.status,
    createdAt: Number(values.createdAt),
    mentions: JSON.parse(values.mentions),
  };
}

function configReplyToObject(reply) {
  const result = {};
  for (let index = 0; index < reply.length; index += 2) result[reply[index]] = reply[index + 1];
  return result;
}

function parseInfo(reply) {
  const result = {};
  for (const line of String(reply).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

class RedisChatBackend {
  constructor({ directory, durability = 'balanced', port, redisServerPath }) {
    this.process = new RedisProcessManager({ directory, durability, port, redisServerPath });
    this.durability = durability;
    this.client = null;
    this.durabilitySettings = null;
  }

  async open() {
    if (this.client) throw new Error('Redis benchmark backend is already open');
    await this.process.start();
    this.client = new RespClient({ port: this.process.port });
    try {
      await this.client.connect();
      const config = configReplyToObject(
        await this.client.sendCommand(['CONFIG', 'GET', 'appendonly', 'appendfsync', 'save'])
      );
      const expectedFsync = this.durability === 'strict' ? 'always' : 'everysec';
      if (config.appendonly !== 'yes' || config.appendfsync !== expectedFsync || config.save !== '60 1') {
        throw new Error(
          `Redis durability configuration mismatch: appendonly=${config.appendonly}, ` +
            `appendfsync=${config.appendfsync}, save=${config.save}`
        );
      }
      this.durabilitySettings = {
        appendonly: config.appendonly,
        appendfsync: config.appendfsync,
        rdbSchedule: config.save,
      };
    } catch (error) {
      this.client.close();
      this.client = null;
      await this.process.stop({ graceful: true });
      throw error;
    }
  }

  requireOpen() {
    if (!this.client) throw new Error('Redis benchmark backend is not open');
  }

  async append(message) {
    return this.appendBatch([message]);
  }

  async appendBatch(messages) {
    this.requireOpen();
    if (messages.length === 0) return;
    const commands = [['MULTI']];
    for (const message of messages) {
      commands.push(messageHashCommand(message));
      commands.push(['ZADD', threadKey(message.threadId), message.sequence, message.id]);
    }
    commands.push(['EXEC']);
    const replies = await this.client.sendCommands(commands);
    const transactionReply = replies[replies.length - 1];
    if (!Array.isArray(transactionReply)) throw new Error('Redis transaction did not return EXEC results');
    const commandError = transactionReply.find((reply) => reply instanceof RespReplyError);
    if (commandError) throw commandError;
  }

  async messagesForIds(ids) {
    if (ids.length === 0) return [];
    const replies = await this.client.sendCommands(ids.map((id) => ['HGETALL', messageKey(id)]));
    return replies.map(mapHash).filter(Boolean);
  }

  async latest(threadId, limit) {
    this.requireOpen();
    const ids = await this.client.sendCommand(['ZRANGE', threadKey(threadId), -limit, -1]);
    return this.messagesForIds(ids);
  }

  async after(threadId, cursorSequence, limit) {
    this.requireOpen();
    const ids = await this.client.sendCommand([
      'ZRANGEBYSCORE', threadKey(threadId), `(${cursorSequence}`, '+inf', 'LIMIT', 0, limit,
    ]);
    return this.messagesForIds(ids);
  }

  async getById(messageId) {
    this.requireOpen();
    return mapHash(await this.client.sendCommand(['HGETALL', messageKey(messageId)]));
  }

  async updateStatus(messageId, status) {
    this.requireOpen();
    await this.client.sendCommand(['HSET', messageKey(messageId), 'status', status]);
    return this.getById(messageId);
  }

  async count(threadId) {
    this.requireOpen();
    return this.client.sendCommand(['ZCARD', threadKey(threadId)]);
  }

  getDurabilitySettings() {
    this.requireOpen();
    return { ...this.durabilitySettings };
  }

  async getMemoryStats() {
    this.requireOpen();
    const info = parseInfo(await this.client.sendCommand(['INFO', 'MEMORY']));
    return {
      scope: 'redis-process',
      usedMemoryBytes: Number(info.used_memory),
      rssBytes: Number(info.used_memory_rss),
      comparableAcrossBackends: true,
    };
  }

  async close({ graceful = true } = {}) {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    await this.process.stop({ graceful });
  }

  async crash() {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    await this.process.killAbrupt();
  }

  get port() {
    return this.process.port;
  }

  get pid() {
    return this.process.pid;
  }
}

module.exports = { RedisChatBackend };
