'use strict';

const BASE_TIMESTAMP = Date.UTC(2026, 0, 1);

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function payloadSizeForIndex(index) {
  if (index % 200 === 0) return 128 * 1024;
  if (index % 20 === 0) return 16 * 1024;
  return 1024;
}

function createContent(index, targetBytes) {
  const prefix = `message-${String(index + 1).padStart(8, '0')}|`;
  const fillLength = Math.max(0, targetBytes - Buffer.byteLength(prefix, 'utf8'));
  return `${prefix}${String.fromCharCode(97 + (index % 26)).repeat(fillLength)}`;
}

function threadIdForIndex(index, config) {
  if (index < config.hotThreadMessageCount) return 'thread-hot';
  return `thread-${String((index - config.hotThreadMessageCount) % config.ordinaryThreadCount).padStart(4, '0')}`;
}

function mentionsForIndex(index) {
  if (index % 31 === 0) return ['cat-maine', 'cat-ragdoll'];
  if (index % 7 === 0) return ['cat-maine'];
  return [];
}

function createMessage(index, config) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= config.messageCount) {
    throw new Error(`message index out of range: ${index}`);
  }
  const sequence = index + 1;
  return {
    id: `msg-${String(sequence).padStart(12, '0')}`,
    threadId: threadIdForIndex(index, config),
    userId: `user-${String(index % 100).padStart(3, '0')}`,
    sequence,
    content: createContent(index, payloadSizeForIndex(index)),
    status: 'completed',
    createdAt: BASE_TIMESTAMP + sequence,
    mentions: mentionsForIndex(index),
  };
}

function createSampleIndexes({ population, sampleSize, seed }) {
  if (!Number.isSafeInteger(population) || population <= 0) {
    throw new Error('population must be a positive safe integer');
  }
  if (!Number.isSafeInteger(sampleSize) || sampleSize <= 0 || sampleSize > population) {
    throw new Error('sampleSize must be between 1 and population');
  }
  const random = mulberry32(seed);
  const selected = new Set();
  while (selected.size < sampleSize) {
    selected.add(Math.floor(random() * population));
  }
  return [...selected];
}

module.exports = {
  BASE_TIMESTAMP,
  createMessage,
  createSampleIndexes,
  payloadSizeForIndex,
};
