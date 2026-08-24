#!/usr/bin/env node
/**
 * Child scenario runner for the P0 summary-memory gate.
 *
 * Runs one measurement scenario against a disposable copy of the synthetic
 * seed inside a child process started with --expose-gc. The parent process
 * samples this child's RSS externally while the scenario runs; this script
 * samples in-process heap AND RSS at every per-digest repository call (the
 * plan's measurement contract) plus a high-frequency interval tracker for
 * HTTP scenarios, and reports a JSON result on stdout. RSS peak budget
 * evaluation uses the larger of the in-process and externally sampled peaks,
 * because fast requests can start and finish between external samples.
 *
 * Scenarios (frozen plan, Performance Acceptance Matrix, P0 rows):
 *   global-health        full seed global health: counts, <=128 MiB heap, <=10 s
 *   scoped-health        largest-conversation scoped health: <=64 MiB heap, <=2 s
 *   global-backfill      global backfill + idempotent repeat: <=128 MiB heap,
 *                        <=256 MiB RSS, each request <=120 s, no duplicate rows
 *   sequential-health    20 sequential health calls: post-GC retained heap
 *                        delta <=32 MiB from warm baseline
 *   concurrent-http      8 concurrent HTTP /api/memory/health requests: all
 *                        succeed, <=320 MiB peak RSS delta, no retained growth
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;

function parseArgs(argv) {
  const args = { scenario: '', workDir: '', manifestPath: '' };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--scenario') args.scenario = value;
    else if (key === '--work-dir') args.workDir = value;
    else if (key === '--manifest') args.manifestPath = value;
  }
  if (!args.scenario || !args.workDir || !args.manifestPath) {
    throw new Error('usage: gate-child.js --scenario <name> --work-dir <dir> --manifest <path>');
  }
  return args;
}

function gc() {
  if (typeof global.gc !== 'function') {
    throw new Error('gate child must run with --expose-gc');
  }
  global.gc();
  global.gc();
}

function sampleMemory(sampler) {
  const usage = process.memoryUsage();
  sampler.maxHeapUsed = Math.max(sampler.maxHeapUsed, usage.heapUsed);
  sampler.maxRss = Math.max(sampler.maxRss, usage.rss);
  sampler.samples += 1;
  return usage;
}

function createSampler() {
  return { maxHeapUsed: 0, maxRss: 0, samples: 0 };
}

// Re-arm peak trackers at a warm baseline so every reported peak delta
// measures growth over that baseline, not over process start.
function resetSamplerPeaks(sampler, baselineUsage) {
  sampler.maxHeapUsed = baselineUsage.heapUsed;
  sampler.maxRss = baselineUsage.rss;
}

function openStore(args) {
  const { createChatAppStore } = require('../../build/lib/chat-app-store');
  const sqlitePath = path.join(args.workDir, 'chat.sqlite');
  const store = createChatAppStore({ agentDir: args.workDir, sqlitePath });

  // Architectural contract: the P0 paths must never read message history.
  let listMessagesCalls = 0;
  const originalListMessages = store.listMessages;
  store.listMessages = function wrapped(...fnArgs) {
    listMessagesCalls += 1;
    return originalListMessages.apply(this, fnArgs);
  };

  // Per-digest repository call hooks: sample in-process heap inside the
  // synchronous loops (frozen plan measurement contract).
  const perDigestSampler = createSampler();
  const originalGetBySourceDigestId = store.summarySegmentRepository.getBySourceDigestId.bind(store.summarySegmentRepository);
  store.summarySegmentRepository.getBySourceDigestId = (...fnArgs) => {
    sampleMemory(perDigestSampler);
    return originalGetBySourceDigestId(...fnArgs);
  };
  const originalSave = store.saveSummarySegmentFromDigest.bind(store);
  store.saveSummarySegmentFromDigest = (...fnArgs) => {
    sampleMemory(perDigestSampler);
    return originalSave(...fnArgs);
  };

  return { store, counters: { get listMessagesCalls() { return listMessagesCalls; } }, perDigestSampler };
}

function assertZeroListMessages(counters) {
  if (counters.listMessagesCalls !== 0) {
    throw new Error(`listMessages was called ${counters.listMessagesCalls} times; P0 paths must never read message history`);
  }
}

function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const end = process.hrtime.bigint();
  return { value, durationMs: Number(end - start) / 1e6 };
}

async function runGlobalHealth(args, manifest) {
  const { store, counters, perDigestSampler } = openStore(args);
  try {
    gc();
    const baseline = sampleMemory(perDigestSampler);
    resetSamplerPeaks(perDigestSampler, baseline);
    const { value: health, durationMs } = timed(() => store.getSummaryMemoryHealth());
    const post = sampleMemory(perDigestSampler);
    assertZeroListMessages(counters);

    const digestTotal = Number(manifest.digestTotal);
    if (health.status !== 'needs_backfill') throw new Error(`expected needs_backfill, got ${health.status}`);
    if (health.ok !== true) throw new Error('expected health.ok === true');
    if (health.backfill.conversationCount !== manifest.digestConversations) {
      throw new Error(`conversationCount ${health.backfill.conversationCount} !== ${manifest.digestConversations}`);
    }
    if (health.backfill.digestCount !== digestTotal) {
      throw new Error(`digestCount ${health.backfill.digestCount} !== ${digestTotal}`);
    }
    if (health.backfill.unsyncedDigestCount !== digestTotal) {
      throw new Error(`unsyncedDigestCount ${health.backfill.unsyncedDigestCount} !== ${digestTotal}`);
    }
    if (health.segments.count !== 0) throw new Error(`expected 0 segments, got ${health.segments.count}`);

    gc();
    const retained = process.memoryUsage();
    return {
      budgets: { heapDeltaMiB: 128, durationMs: 10_000 },
      metrics: {
        durationMs,
        baselineHeapUsedMiB: baseline.heapUsed / MIB,
        peakHeapUsedMiB: perDigestSampler.maxHeapUsed / MIB,
        postCallHeapUsedMiB: post.heapUsed / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        perDigestSamples: perDigestSampler.samples,
        baselineRssMiB: baseline.rss / MIB,
        peakRssMiB: perDigestSampler.maxRss / MIB,
        retainedRssMiB: retained.rss / MIB,
      },
      counts: {
        conversationCount: health.backfill.conversationCount,
        digestCount: health.backfill.digestCount,
        unsyncedDigestCount: health.backfill.unsyncedDigestCount,
      },
    };
  } finally {
    store.close();
  }
}

async function runScopedHealth(args, manifest) {
  const { store, counters, perDigestSampler } = openStore(args);
  try {
    gc();
    const baseline = sampleMemory(perDigestSampler);
    resetSamplerPeaks(perDigestSampler, baseline);
    const conversationId = manifest.largestConversation.id;
    const { value: health, durationMs } = timed(() =>
      store.getSummaryMemoryHealth({ conversationId })
    );
    const post = sampleMemory(perDigestSampler);
    assertZeroListMessages(counters);

    if (health.status !== 'needs_backfill') throw new Error(`expected needs_backfill, got ${health.status}`);
    if (health.backfill.conversationCount !== 1) throw new Error('expected scoped conversationCount 1');
    if (health.backfill.digestCount !== manifest.largestConversation.digests) {
      throw new Error(`scoped digestCount ${health.backfill.digestCount} !== ${manifest.largestConversation.digests}`);
    }
    if (health.backfill.unsyncedDigestCount !== manifest.largestConversation.digests) {
      throw new Error('expected scoped unsyncedDigestCount to equal digest count');
    }
    // Bounded diagnostics contract: the detail list is capped while the
    // counts stay exact (12 digests -> capped detail of 10).
    if (health.backfill.unsyncedDigests.length !== Math.min(manifest.largestConversation.digests, 10)) {
      throw new Error(
        `scoped unsyncedDigests detail ${health.backfill.unsyncedDigests.length} does not match bounded cap for ${manifest.largestConversation.digests} digests`
      );
    }

    gc();
    const retained = process.memoryUsage();
    return {
      budgets: { heapDeltaMiB: 64, durationMs: 2_000 },
      metrics: {
        durationMs,
        baselineHeapUsedMiB: baseline.heapUsed / MIB,
        peakHeapUsedMiB: perDigestSampler.maxHeapUsed / MIB,
        postCallHeapUsedMiB: post.heapUsed / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        perDigestSamples: perDigestSampler.samples,
        baselineRssMiB: baseline.rss / MIB,
        peakRssMiB: perDigestSampler.maxRss / MIB,
        retainedRssMiB: retained.rss / MIB,
      },
      counts: {
        conversationCount: health.backfill.conversationCount,
        digestCount: health.backfill.digestCount,
        unsyncedDigestCount: health.backfill.unsyncedDigestCount,
      },
    };
  } finally {
    store.close();
  }
}

async function runGlobalBackfill(args, manifest) {
  const { backfillConversationDigestSummarySegments } = require('../../build/server/domain/conversation/conversation-digest');
  const { store, counters, perDigestSampler } = openStore(args);
  try {
    gc();
    const baseline = sampleMemory(perDigestSampler);
    resetSamplerPeaks(perDigestSampler, baseline);

    const first = timed(() => backfillConversationDigestSummarySegments(store, {}));
    const afterFirst = sampleMemory(perDigestSampler);
    const second = timed(() => backfillConversationDigestSummarySegments(store, {}));
    const afterSecond = sampleMemory(perDigestSampler);
    assertZeroListMessages(counters);

    const digestTotal = Number(manifest.digestTotal);
    // Existing semantics: backfill conversationCount counts every processed
    // conversation (digest-bearing or not), while health conversationCount
    // counts only digest-bearing conversations.
    if (first.value.conversationCount !== manifest.conversations) {
      throw new Error(`backfill conversationCount ${first.value.conversationCount} !== ${manifest.conversations}`);
    }
    if (first.value.digestCount !== digestTotal) throw new Error(`backfill digestCount ${first.value.digestCount} !== ${digestTotal}`);
    if (first.value.segmentCount !== digestTotal) throw new Error(`backfill segmentCount ${first.value.segmentCount} !== ${digestTotal}`);
    if (first.value.failedCount !== 0) throw new Error(`backfill failedCount ${first.value.failedCount} !== 0`);
    if (second.value.segmentCount !== digestTotal) throw new Error('repeat backfill segmentCount drifted');
    if (second.value.failedCount !== 0) throw new Error('repeat backfill failed');

    const snapshot = store.summarySegmentRepository.getHealthSnapshot();
    if (snapshot.segmentCount !== digestTotal) {
      throw new Error(`duplicate segments: ${snapshot.segmentCount} rows for ${digestTotal} digests`);
    }

    const health = store.getSummaryMemoryHealth();
    if (health.backfill.unsyncedDigestCount !== 0) {
      throw new Error(`post-backfill unsyncedDigestCount ${health.backfill.unsyncedDigestCount} !== 0`);
    }

    gc();
    const retained = process.memoryUsage();
    return {
      budgets: { heapDeltaMiB: 128, durationMs: 120_000 },
      metrics: {
        firstDurationMs: first.durationMs,
        secondDurationMs: second.durationMs,
        durationMs: Math.max(first.durationMs, second.durationMs),
        baselineHeapUsedMiB: baseline.heapUsed / MIB,
        peakHeapUsedMiB: perDigestSampler.maxHeapUsed / MIB,
        afterFirstHeapUsedMiB: afterFirst.heapUsed / MIB,
        afterSecondHeapUsedMiB: afterSecond.heapUsed / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        baselineRssMiB: baseline.rss / MIB,
        peakRssMiB: perDigestSampler.maxRss / MIB,
        retainedRssMiB: retained.rss / MIB,
        perDigestSamples: perDigestSampler.samples,
      },
      counts: {
        digestCount: first.value.digestCount,
        segmentCount: snapshot.segmentCount,
        repeatSegmentCount: second.value.segmentCount,
      },
    };
  } finally {
    store.close();
  }
}

async function runSequentialHealth(args) {
  const { store, counters, perDigestSampler } = openStore(args);
  try {
    // Warm baseline: two warmup calls, then explicit collection.
    store.getSummaryMemoryHealth();
    store.getSummaryMemoryHealth();
    gc();
    const warm = process.memoryUsage();
    resetSamplerPeaks(perDigestSampler, warm);

    const durations = [];
    for (let i = 0; i < 20; i += 1) {
      const { durationMs } = timed(() => store.getSummaryMemoryHealth());
      durations.push(durationMs);
      sampleMemory(perDigestSampler);
    }
    assertZeroListMessages(counters);

    gc();
    const retained = process.memoryUsage();
    return {
      budgets: { retainedHeapDeltaMiB: 32 },
      metrics: {
        warmBaselineHeapUsedMiB: warm.heapUsed / MIB,
        peakHeapUsedMiB: perDigestSampler.maxHeapUsed / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        maxDurationMs: Math.max(...durations),
        medianDurationMs: durations.slice().sort((a, b) => a - b)[Math.floor(durations.length / 2)],
        calls: durations.length,
        perDigestSamples: perDigestSampler.samples,
        baselineRssMiB: warm.rss / MIB,
        peakRssMiB: perDigestSampler.maxRss / MIB,
        retainedRssMiB: retained.rss / MIB,
      },
      counts: {},
    };
  } finally {
    store.close();
  }
}

async function runConcurrentHttpHealth(args, manifest) {
  const net = require('node:net');
  const { createServerApp } = require('../../build/server/app/create-server');

  const findFreePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
      probe.on('error', reject);
    });

  const port = await findFreePort();
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: args.workDir,
    sqlitePath: path.join(args.workDir, 'chat.sqlite'),
    projectDir: args.workDir,
  });

  let listMessagesCalls = 0;
  const originalListMessages = app.store.listMessages;
  app.store.listMessages = function wrapped(...fnArgs) {
    listMessagesCalls += 1;
    return originalListMessages.apply(this, fnArgs);
  };
  const perDigestSampler = createSampler();
  const originalGetBySourceDigestId = app.store.summarySegmentRepository.getBySourceDigestId.bind(app.store.summarySegmentRepository);
  app.store.summarySegmentRepository.getBySourceDigestId = (...fnArgs) => {
    sampleMemory(perDigestSampler);
    return originalGetBySourceDigestId(...fnArgs);
  };

  const maxMemoryTracker = setInterval(() => {
    sampleMemory(perDigestSampler);
  }, 50);
  maxMemoryTracker.unref();

  try {
    await new Promise((resolve, reject) => {
      app.start((error) => (error ? reject(error) : resolve()));
    });

    // Warm baseline after server boot.
    const warmup = await fetch(`http://127.0.0.1:${port}/api/memory/health`);
    const warmupBody = await warmup.json();
    if (!warmupBody.ok) throw new Error('warmup health request failed');
    gc();
    const warm = process.memoryUsage();
    // Re-arm peak trackers at the warm baseline: everything sampled before
    // this point (server boot, warmup request) is excluded from the peak
    // deltas that the RSS budget evaluates.
    resetSamplerPeaks(perDigestSampler, warm);

    const start = process.hrtime.bigint();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${port}/api/memory/health`))
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    for (const response of responses) {
      if (response.status !== 200) throw new Error(`health request returned ${response.status}`);
    }
    const digestTotal = Number(manifest.digestTotal);
    for (const body of bodies) {
      if (body.ok !== true || body.status !== 'needs_backfill') throw new Error('concurrent health body not ok/needs_backfill');
      if (body.backfill.digestCount !== digestTotal) {
        throw new Error(`concurrent digestCount ${body.backfill.digestCount} !== ${digestTotal}`);
      }
    }
    if (listMessagesCalls !== 0) {
      throw new Error(`HTTP health path called listMessages ${listMessagesCalls} times`);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    gc();
    const retained = process.memoryUsage();

    return {
      budgets: { rssDeltaMiB: 320 },
      metrics: {
        durationMs,
        warmBaselineHeapUsedMiB: warm.heapUsed / MIB,
        peakHeapUsedMiB: perDigestSampler.maxHeapUsed / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        retainedHeapDeltaMiB: (retained.heapUsed - warm.heapUsed) / MIB,
        baselineRssMiB: warm.rss / MIB,
        peakRssMiB: perDigestSampler.maxRss / MIB,
        retainedRssMiB: retained.rss / MIB,
        perDigestSamples: perDigestSampler.samples,
        concurrentRequests: responses.length,
      },
      counts: { digestCount: bodies[0].backfill.digestCount },
    };
  } finally {
    clearInterval(maxMemoryTracker);
    await new Promise((resolve) => app.close(resolve));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'));

  const scenarios = {
    'global-health': () => runGlobalHealth(args, manifest),
    'scoped-health': () => runScopedHealth(args, manifest),
    'global-backfill': () => runGlobalBackfill(args, manifest),
    'sequential-health': () => runSequentialHealth(args),
    'concurrent-http-health': () => runConcurrentHttpHealth(args, manifest),
  };

  const runner = scenarios[args.scenario];
  if (!runner) throw new Error(`unknown scenario: ${args.scenario}`);

  const result = await runner();
  process.stdout.write(`${JSON.stringify({ scenario: args.scenario, ok: true, ...result })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ scenario: parseArgs(process.argv).scenario, ok: false, error: String((error && error.stack) || error) })}\n`);
  process.exitCode = 1;
});
