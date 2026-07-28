'use strict';

const { resolveBenchmarkConfig } = require('./config');
const { SqliteChatBackend } = require('./sqlite-backend');
const { createMessage } = require('./workload');

async function main() {
  const input = JSON.parse(process.argv[2] || '{}');
  const config = resolveBenchmarkConfig(input.config);
  const backend = new SqliteChatBackend({ directory: input.directory, durability: input.durability });
  const acknowledgedIds = [];
  await backend.open();

  for (let start = 0; start < config.recoveryMessageCount; start += config.appendBatchSize) {
    const end = Math.min(config.recoveryMessageCount, start + config.appendBatchSize);
    const messages = [];
    for (let index = start; index < end; index += 1) messages.push(createMessage(index, config));
    await backend.appendBatch(messages);
    acknowledgedIds.push(...messages.map((message) => message.id));
  }

  if (process.send) process.send({ type: 'ready-for-crash', acknowledgedIds });
  setInterval(() => {}, 60_000);
}

main().catch((error) => {
  if (process.send) process.send({ type: 'error', message: error.stack || error.message });
  process.exitCode = 1;
});
