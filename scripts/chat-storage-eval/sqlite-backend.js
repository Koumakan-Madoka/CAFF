'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const SYNCHRONOUS_NAMES = new Map([
  [0, 'OFF'],
  [1, 'NORMAL'],
  [2, 'FULL'],
  [3, 'EXTRA'],
]);

function assertDurability(value) {
  if (value !== 'balanced' && value !== 'strict') {
    throw new Error(`Unsupported SQLite durability profile: ${value}`);
  }
  return value;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    userId: row.user_id,
    sequence: row.sequence,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    mentions: JSON.parse(row.mentions_json),
  };
}

class SqliteChatBackend {
  constructor({ directory, durability = 'balanced', filename = 'chat-storage.sqlite' }) {
    if (!directory) throw new Error('SQLite benchmark directory is required');
    this.directory = path.resolve(directory);
    this.databasePath = path.join(this.directory, filename);
    this.durability = assertDurability(durability);
    this.db = null;
    this.statements = null;
  }

  async open() {
    if (this.db) throw new Error('SQLite benchmark backend is already open');
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new Database(this.databasePath);

    const requestedSynchronous = this.durability === 'strict' ? 'FULL' : 'NORMAL';
    const journalMode = String(this.db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
    this.db.pragma(`synchronous = ${requestedSynchronous}`);
    const synchronous = SYNCHRONOUS_NAMES.get(Number(this.db.pragma('synchronous', { simple: true })));

    if (journalMode !== 'wal' || synchronous !== requestedSynchronous) {
      this.db.close();
      this.db = null;
      throw new Error(
        `SQLite durability configuration mismatch: journal_mode=${journalMode}, synchronous=${synchronous}`
      );
    }

    this.durabilitySettings = { journalMode, synchronous };
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        mentions_json TEXT NOT NULL,
        UNIQUE (thread_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread_sequence
        ON messages (thread_id, sequence);
    `);

    this.statements = {
      append: this.db.prepare(`
        INSERT INTO messages (
          id, thread_id, user_id, sequence, content, status, created_at, mentions_json
        ) VALUES (
          @id, @threadId, @userId, @sequence, @content, @status, @createdAt, @mentionsJson
        )
      `),
      latest: this.db.prepare(`
        SELECT *
        FROM (
          SELECT * FROM messages
          WHERE thread_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        )
        ORDER BY sequence ASC
      `),
      after: this.db.prepare(`
        SELECT * FROM messages
        WHERE thread_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `),
      getById: this.db.prepare('SELECT * FROM messages WHERE id = ? LIMIT 1'),
      updateStatus: this.db.prepare('UPDATE messages SET status = ? WHERE id = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?'),
    };
    this.appendBatchTransaction = this.db.transaction((messages) => {
      for (const message of messages) this.appendRow(message);
    });
  }

  requireOpen() {
    if (!this.db || !this.statements) throw new Error('SQLite benchmark backend is not open');
  }

  appendRow(message) {
    this.statements.append.run({
      ...message,
      mentionsJson: JSON.stringify(message.mentions),
    });
  }

  async append(message) {
    this.requireOpen();
    this.appendRow(message);
  }

  async appendBatch(messages) {
    this.requireOpen();
    this.appendBatchTransaction(messages);
  }

  async latest(threadId, limit) {
    this.requireOpen();
    return this.statements.latest.all(threadId, limit).map(mapRow);
  }

  async after(threadId, cursorSequence, limit) {
    this.requireOpen();
    return this.statements.after.all(threadId, cursorSequence, limit).map(mapRow);
  }

  async getById(messageId) {
    this.requireOpen();
    return mapRow(this.statements.getById.get(messageId));
  }

  async updateStatus(messageId, status) {
    this.requireOpen();
    this.statements.updateStatus.run(status, messageId);
    return this.getById(messageId);
  }

  async count(threadId) {
    this.requireOpen();
    return this.statements.count.get(threadId).count;
  }

  getDurabilitySettings() {
    this.requireOpen();
    return { ...this.durabilitySettings };
  }

  async getMemoryStats() {
    this.requireOpen();
    return {
      scope: 'shared-node-process',
      rssBytes: process.memoryUsage().rss,
      comparableAcrossBackends: false,
    };
  }

  async close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
    this.statements = null;
    this.appendBatchTransaction = null;
  }
}

module.exports = {
  SqliteChatBackend,
};
