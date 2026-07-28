'use strict';

const fs = require('node:fs');
const path = require('node:path');

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = Number(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${formatNumber(amount)} ${units[unit]}`;
}

function renderPerformanceRows(suite) {
  const rows = [];
  for (const run of suite.runs) {
    for (const backendName of ['sqlite', 'redis']) {
      const backend = run.backends[backendName];
      if (!backend || backend.status !== 'completed') {
        rows.push(`| ${run.configuration.durability} | ${backendName} | skipped | - | - | - |`);
        continue;
      }
      rows.push(
        `| ${run.configuration.durability} | ${backendName} | ` +
          `${formatNumber(backend.operations.append.throughputPerSecond)} msg/s | ` +
          `${formatNumber(backend.operations.latest.p95Ms)} ms | ` +
          `${formatBytes(backend.storage.bytes)} | ${formatNumber(backend.startupMs)} ms |`
      );
    }
  }
  return rows.join('\n');
}

function renderRecoveryRows(suite) {
  const rows = [];
  for (const run of suite.runs) {
    for (const backendName of ['sqlite', 'redis']) {
      const backend = run.backends[backendName];
      if (!backend || backend.status !== 'completed') continue;
      const recovery = backend.recovery;
      rows.push(
        `| ${run.configuration.durability} | ${backendName} | ${recovery.acknowledged} | ` +
          `${recovery.recovered} | ${recovery.lost} | ${formatNumber(recovery.restartRecoveryMs)} ms |`
      );
    }
  }
  return rows.join('\n');
}

function renderEvaluationReport(suite) {
  const limitations = [...new Set([...(suite.limitations || []), ...suite.runs.flatMap((run) => run.limitations || [])])];
  return `---
feature_ids: [CAFF-EVAL-CHAT-STORAGE]
topics: [storage, sqlite, redis, benchmark, durability, chat]
doc_kind: evaluation
created: 2026-07-28
---

# CAFF Chat Storage: Redis vs SQLite

## Verdict

**SQLite remains CAFF's durable source of truth for chat messages.** Redis is justified only as an optional coordination, fan-out, presence, queue, or disposable cache layer if CAFF later becomes a multi-process or multi-host service. It should not replace SQLite as the only durable message store for the current local-first architecture.

A long thread does not require loading the whole database. Indexed cursor queries read a bounded page from either engine. CAFF's current full-conversation \`.all()\` call is a repository query issue to fix with pagination, not a reason to move durable chat history to Redis.

## Measured Results

Profile: \`${suite.configuration.profile}\`; seed: \`${suite.configuration.seed ?? 'n/a'}\`; generated: \`${suite.generatedAt}\`.

| Durability | Backend | Append throughput | Latest-page p95 | Durable files | Startup |
|---|---|---:|---:|---:|---:|
${renderPerformanceRows(suite)}

Append p95 is measured per configured transaction batch; append throughput is messages per second. Latest-page reads return 50 messages in ascending display order.

## Process-Crash Recovery

| Durability | Backend | Acknowledged | Recovered | Lost | Restart/open |
|---|---|---:|---:|---:|---:|
${renderRecoveryRows(suite)}

The recovery probe terminates the storage process abruptly after acknowledgements and then reopens the same harness-owned data directory. This is process-crash evidence; it does not simulate host power loss or storage-device failure.

## Repository Evidence

- CAFF already uses SQLite WAL with \`synchronous=NORMAL\` and has a cursor-compatible message index. Its current conversation read path still calls an unbounded \`.all()\`; pagination should use that index.
- Clowder introduced Redis first for sessions (\`19f158c96\`), then for message persistence after a capped in-memory store lost history on restart (\`b1dd04cf8\`). That history establishes why Redis replaced memory, not that Redis beat SQLite.
- Clowder later experienced an RDB snapshot-window loss (\`40ecac509\`) and a default 30-day TTL deleting a thread (\`4e57a38e7\`). Durable user-visible chat therefore requires permanent retention and an explicitly tested persistence policy regardless of engine.

## Decision

For CAFF now:

1. Keep normalized SQLite as the authoritative store for threads, messages, tasks, summaries, and other user-visible recoverable state.
2. Replace full-history reads with bounded latest-page and after-cursor queries.
3. Add Redis only when a measured distributed coordination requirement appears, and keep it reconstructible from SQLite where possible.
4. Never apply an implicit TTL to chat history; retention must be an explicit user choice.

## Limitations

${limitations.map((item) => `- ${item}`).join('\n')}

## Reproduce

\`npm run eval:chat-storage:test\` validates the harness. \`npm run eval:chat-storage:quick\` runs a smoke profile. \`npm run eval:chat-storage:standard\` regenerates the balanced and strict evidence on the current machine. Set \`REDIS_SERVER_PATH\` when \`redis-server\` is not on \`PATH\`.
`;
}

function writeTextAtomic(outputPath, content) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, resolved);
}

if (require.main === module) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('Usage: node report.js <results.json> <verdict.md>');
    process.exitCode = 1;
  } else {
    const suite = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
    writeTextAtomic(outputPath, renderEvaluationReport(suite));
    console.log(`Wrote ${path.resolve(outputPath)}`);
  }
}

module.exports = { renderEvaluationReport, writeTextAtomic };
