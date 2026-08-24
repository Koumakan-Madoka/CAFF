#!/usr/bin/env node
/**
 * Child scenario runner for the P1 metrics/SSE/observability gate.
 *
 * Runs one measurement scenario inside a child process started with
 * --expose-gc. The parent samples this child's RSS externally; this script
 * samples in-process heap AND RSS via interval trackers and reports a JSON
 * result (plus functional checks) on stdout.
 *
 * Scenarios (frozen plan, Performance Acceptance Matrix, P1 rows):
 *   metrics-31d-bounded    bounded 31-day report on the production-shape
 *                          seed: exact aggregates, no raw metadata/event
 *                          column materialization, peak RSS delta <=512 MiB
 *   sse-healthy-burst      6 x 256 KiB burst with timely drain: client stays
 *                          connected, frames in order, queued bytes -> 0
 *   sse-blocked-client     10,000 x 256 KiB into a never-reading client:
 *                          dropped at the 2 MiB budget, peak RSS delta
 *                          <=64 MiB, no writes after removal
 *   sse-oversize-frame     single frame > 2 MiB removes the client before
 *                          the frame is written
 *   sse-connect-cycles     100 connect/close cycles: zero clients, queues,
 *                          listeners, timers afterwards
 *   concurrent-metrics-sse real server: concurrent bounded metrics + invalid
 *                          window 400s + SSE clients receiving live events
 *   goal-workload-stability accelerated goal-continuation workload through
 *                          the real turn orchestrator: runtime counters
 *                          settle to zero, post-GC retained heap bounded
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
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
  if (!args.scenario || !args.workDir) {
    throw new Error('usage: gate-child.js --scenario <name> --work-dir <dir> [--manifest <path>]');
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

function resetSamplerPeaks(sampler, baselineUsage) {
  sampler.maxHeapUsed = baselineUsage.heapUsed;
  sampler.maxRss = baselineUsage.rss;
}

function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const end = process.hrtime.bigint();
  return { value, durationMs: Number(end - start) / 1e6 };
}

function memoryMetrics(baseline, sampler, extras = {}) {
  return {
    baselineHeapUsedMiB: baseline.heapUsed / MIB,
    baselineRssMiB: baseline.rss / MIB,
    peakHeapUsedMiB: sampler.maxHeapUsed / MIB,
    peakRssMiB: sampler.maxRss / MIB,
    samples: sampler.samples,
    ...extras,
  };
}

function functionalCheck(name, pass, detail) {
  return { name, pass, detail: detail || undefined };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  throw new Error(`timeout after ${timeoutMs}ms waiting for ${label || 'condition'}`);
}

// ---------------------------------------------------------------------------
// P1A projection contract: the bounded report must not materialize raw
// metadata_json / event_json column values into JS, and must not SELECT *
// from the two wide tables. Enforced at SQL level (prepare interception) and
// row level (any huge materialized string in a result row).
// ---------------------------------------------------------------------------

const JSON_SCALAR_FUNCTIONS = ['json_valid', 'json_extract', 'json_type', 'json_quote', 'length'];

function stripFunctionCalls(sql, functionName) {
  let output = '';
  let index = 0;
  const needle = `${functionName}(`;
  const lowerSql = sql.toLowerCase();
  while (index < sql.length) {
    const hit = lowerSql.indexOf(needle, index);
    if (hit === -1) {
      output += sql.slice(index);
      break;
    }
    output += sql.slice(index, hit);
    // Skip to the matching close paren (balanced).
    let depth = 0;
    let cursor = hit + needle.length - 1;
    for (; cursor < sql.length; cursor += 1) {
      if (sql[cursor] === '(') depth += 1;
      else if (sql[cursor] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
  return output;
}

function installProjectionGuard(db, violations) {
  const originalPrepare = db.prepare.bind(db);
  let checking = false;

  function checkSql(sql) {
    const text = String(sql);
    if (!/\b(chat_messages|a2a_task_events)\b/i.test(text)) {
      return;
    }

    let stripped = text;
    for (const functionName of JSON_SCALAR_FUNCTIONS) {
      stripped = stripFunctionCalls(stripped, functionName);
    }

    if (/(metadata_json|event_json)/i.test(stripped)) {
      violations.push(`raw metadata_json/event_json column reference outside scalar json functions: ${text.slice(0, 160)}`);
    }

    // Any star select on the wide tables except COUNT(*) materializes raw
    // columns (SELECT * / alias.*).
    const starMatches = stripped.match(/\*/g) || [];
    const countStars = stripped.match(/count\(\s*\*\s*\)/gi) || [];
    if (starMatches.length > countStars.length) {
      violations.push(`star select on wide table materializes raw columns: ${text.slice(0, 160)}`);
    }
  }

  function checkRows(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        if (/^(metadata_json|event_json)$/i.test(key)) {
          violations.push(`result row materializes raw column "${key}"`);
          return;
        }
        if (typeof value === 'string' && value.length > 65536) {
          violations.push(`result row materializes a ${value.length}-byte string in "${key}"`);
          return;
        }
      }
    }
  }

  db.prepare = function wrappedPrepare(sql, ...rest) {
    const statement = originalPrepare(sql, ...rest);
    if (!checking) {
      return statement;
    }

    return new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') {
          return value;
        }
        if (prop === 'all' || prop === 'get' || prop === 'raw') {
          return function wrappedMethod(...methodArgs) {
            checkSql(sql);
            const rows = value.apply(target, methodArgs);
            if (prop === 'all') {
              checkRows(rows);
            }
            return rows;
          };
        }
        return value.bind(target);
      },
    });
  };

  return {
    begin() {
      checking = true;
    },
    end() {
      checking = false;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE helpers (raw TCP clients so real kernel backpressure applies).
// ---------------------------------------------------------------------------

function startSseServer(busOptions = {}) {
  const { createSseBus } = require('../../build/server/http/sse-bus');
  const bus = createSseBus(busOptions);
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/api/events')) {
      bus.openStream(req, res, {
        initialEvents: [{ eventName: 'hello', payload: { v: 1 } }],
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, bus, port: server.address().port });
    });
  });
}

// http.get gives a dechunked response Readable while the raw socket still
// applies real kernel-level backpressure when the Readable is paused or has
// no data listener.
function connectSseClient(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      resolve({ req, res });
    });
    req.once('error', reject);
  });
}

function destroySseClient(client) {
  try {
    if (client && client.req) client.req.destroy();
  } catch {}
  try {
    if (client && client.res && client.res.socket) client.res.socket.destroy();
  } catch {}
}

async function closeSseServer(server, clients = []) {
  for (const client of clients) {
    destroySseClient(client);
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    if (typeof timer.unref === 'function') timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function collectSseFrames(response, maxBytes = 64 * MIB) {
  const frames = [];
  let buffer = '';
  let totalBytes = 0;
  let ended = false;

  response.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      destroyResponse();
      return;
    }

    buffer += chunk.toString('utf8');

    // Parse complete SSE frames (terminated by a blank line).
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const frameText = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = [];
      let eventName = '';
      for (const line of frameText.split('\n')) {
        if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('event: ')) eventName = line.slice(7);
        else if (line.startsWith(':')) continue; // prelude / comment
      }
      if (dataLines.length > 0) {
        try {
          frames.push({ eventName, payload: JSON.parse(dataLines.join('\n')) });
        } catch {
          frames.push({ eventName, payload: null, raw: dataLines.join('\n').slice(0, 120) });
        }
      }
    }
  });

  function destroyResponse() {
    try {
      response.destroy();
    } catch {}
  }

  response.once('close', () => {
    ended = true;
  });

  return {
    response,
    frames,
    get totalBytes() {
      return totalBytes;
    },
    get ended() {
      return ended;
    },
  };
}

function buildBurstPayload(index, sizeBytes) {
  return { burst: index, blob: 'x'.repeat(sizeBytes) };
}

// ---------------------------------------------------------------------------
// Scenario: metrics-31d-bounded
// ---------------------------------------------------------------------------

async function runMetrics31dBounded(args, manifest) {
  const { buildAgentEvalReport } = require('../../build/server/domain/metrics/agent-eval-report');
  const { createChatAppStore } = require('../../build/lib/chat-app-store');

  const store = createChatAppStore({
    agentDir: args.workDir,
    sqlitePath: path.join(args.workDir, 'chat.sqlite'),
  });

  const violations = [];
  const guard = installProjectionGuard(store.db, violations);
  const sampler = createSampler();
  const interval = setInterval(() => sampleMemory(sampler), 50);
  interval.unref();

  try {
    // Warm-up with a tiny 1-day window so JIT/module costs are excluded.
    buildAgentEvalReport(store.db, { since: '2025-06-01', until: '2025-06-02' });
    gc();
    const baseline = process.memoryUsage();
    resetSamplerPeaks(sampler, baseline);

    const window = manifest.metricsWindow;
    guard.begin();
    const { value: report, durationMs } = timed(() =>
      buildAgentEvalReport(store.db, {
        since: window.since,
        until: window.until,
        databasePath: store.databasePath || null,
      })
    );
    guard.end();
    const peak = sampleMemory(sampler);

    const checks = [];
    checks.push(functionalCheck(
      'no raw metadata_json/event_json materialization during the report',
      violations.length === 0,
      violations.slice(0, 3).join(' | ')
    ));
    checks.push(functionalCheck(
      `report echoes window ${window.since}..${window.until}`,
      report.since === window.since && report.until === window.until
    ));

    // Exact aggregates against the manifest's expected metrics.
    const expected = manifest.expectedMetrics;
    const totalTurns = report.agents.reduce((sum, agent) => sum + agent.turns, 0);
    checks.push(functionalCheck(
      `total turns ${totalTurns} === expected ${expected.totalTurns}`,
      totalTurns === expected.totalTurns
    ));

    for (const expectedAgent of expected.agents) {
      const actual = report.agents.find((agent) => agent.agentId === expectedAgent.agentId);
      if (!actual) {
        checks.push(functionalCheck(`agent ${expectedAgent.agentId} present`, false));
        continue;
      }

      const fieldChecks = [
        ['turns', actual.turns, expectedAgent.turns],
        ['turnsCompleted', actual.turnsCompleted, expectedAgent.turnsCompleted],
        ['turnsFailed', actual.turnsFailed, expectedAgent.turnsFailed],
        ['missingExpectations', actual.missingExpectations, expectedAgent.missingExpectations],
        ['publicPostCount', actual.publicPostCount, expectedAgent.publicPostCount],
        ['privatePostCount', actual.privatePostCount, expectedAgent.privatePostCount],
        ['privateHandoffCount', actual.privateHandoffCount, expectedAgent.privateHandoffCount],
      ];
      for (const [label, actualValue, expectedValue] of fieldChecks) {
        if (actualValue !== expectedValue) {
          checks.push(functionalCheck(
            `${expectedAgent.agentId} ${label} ${actualValue} === ${expectedValue}`,
            false
          ));
        }
      }

      for (const key of ['sendPublic', 'sendPrivate']) {
        for (const subKey of ['tp', 'fp', 'fn', 'tn', 'required', 'forbidden']) {
          if (actual[key][subKey] !== expectedAgent[key][subKey]) {
            checks.push(functionalCheck(
              `${expectedAgent.agentId} ${key}.${subKey} ${actual[key][subKey]} === ${expectedAgent[key][subKey]}`,
              false
            ));
          }
        }
      }

      const expectedTools = new Map(expectedAgent.tools.map((tool) => [tool.tool, tool]));
      for (const tool of actual.tools) {
        const expectedTool = expectedTools.get(tool.tool);
        if (
          !expectedTool
          || tool.calls !== expectedTool.calls
          || tool.succeeded !== expectedTool.succeeded
          || tool.failed !== expectedTool.failed
        ) {
          checks.push(functionalCheck(
            `${expectedAgent.agentId} tool ${tool.tool} counts match`,
            false,
            `actual calls/succeeded/failed ${tool.calls}/${tool.succeeded}/${tool.failed}`
          ));
        }
      }
    }

    const expectedGlobalTools = new Map(expected.tools.map((tool) => [tool.tool, tool]));
    for (const tool of report.tools) {
      const expectedTool = expectedGlobalTools.get(tool.tool);
      if (
        !expectedTool
        || tool.calls !== expectedTool.calls
        || tool.succeeded !== expectedTool.succeeded
        || tool.failed !== expectedTool.failed
      ) {
        checks.push(functionalCheck(
          `global tool ${tool.tool} counts match`,
          false,
          `actual calls/succeeded/failed ${tool.calls}/${tool.succeeded}/${tool.failed}`
        ));
      }
    }
    checks.push(functionalCheck('exact aggregates verified', checks.every((check) => check.pass)));

    gc();
    const retained = process.memoryUsage();

    return {
      budgets: { rssDeltaMiB: 512, durationMs: 60_000 },
      metrics: memoryMetrics(baseline, sampler, {
        durationMs,
        peakHeapDeltaMiB: (sampler.maxHeapUsed - baseline.heapUsed) / MIB,
        postCallHeapUsedMiB: peak.heapUsed / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        retainedRssMiB: retained.rss / MIB,
      }),
      counts: {
        agents: report.agents.length,
        totalTurns,
        tools: report.tools.length,
      },
      checks,
    };
  } finally {
    clearInterval(interval);
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Scenario: sse-healthy-burst
// ---------------------------------------------------------------------------

async function runSseHealthyBurst(args) {
  const { server, bus, port } = await startSseServer({ keepAliveMs: 60_000 });
  const sampler = createSampler();
  const interval = setInterval(() => sampleMemory(sampler), 20);
  interval.unref();
  let client = null;

  try {
    gc();
    const baseline = process.memoryUsage();
    resetSamplerPeaks(sampler, baseline);

    client = await connectSseClient(port);
    const collector = collectSseFrames(client.res);
    await waitFor(() => collector.frames.some((frame) => frame.eventName === 'hello'), 5_000, 'initial hello event');

    // Track whether the bus observes backpressure during the burst.
    let maxBackpressuredClients = 0;
    const statsPoll = setInterval(() => {
      maxBackpressuredClients = Math.max(maxBackpressuredClients, bus.getStats().backpressuredClients);
    }, 5);
    statsPoll.unref();

    // Client pauses briefly: the burst overflows the socket buffers, the bus
    // sees write() === false and queues; the client then drains in time.
    client.res.pause();
    const BURST = 6;
    for (let index = 0; index < BURST; index += 1) {
      bus.broadcast('burst', buildBurstPayload(index, 256 * 1024));
      sampleMemory(sampler);
    }
    await sleep(400);
    client.res.resume();

    await waitFor(
      () => collector.frames.filter((frame) => frame.eventName === 'burst').length >= BURST,
      5_000,
      'all burst frames delivered'
    );
    clearInterval(statsPoll);

    // A post-burst event proves the client stayed connected end to end.
    bus.broadcast('after-burst', { marker: 'still-connected' });
    await waitFor(
      () => collector.frames.some((frame) => frame.eventName === 'after-burst'),
      5_000,
      'post-burst event'
    );

    const stats = bus.getStats();
    await sleep(200);
    const settled = bus.getStats();

    const burstFrames = collector.frames.filter((frame) => frame.eventName === 'burst');
    const order = burstFrames.map((frame) => (frame.payload ? frame.payload.burst : -1));
    const expectedOrder = Array.from({ length: BURST }, (_, index) => index);

    const checks = [
      functionalCheck(`client received all ${BURST} burst frames`, burstFrames.length === BURST),
      functionalCheck(`frames in order ${JSON.stringify(order)}`, JSON.stringify(order) === JSON.stringify(expectedOrder)),
      functionalCheck('each frame payload is the full 256 KiB blob', burstFrames.every(
        (frame) => frame.payload && frame.payload.blob && frame.payload.blob.length === 256 * 1024
      )),
      functionalCheck('client remained connected (post-burst event delivered)', collector.frames.some(
        (frame) => frame.eventName === 'after-burst' && frame.payload && frame.payload.marker === 'still-connected'
      )),
      functionalCheck(`queued frame bytes returned to zero (got ${settled.queuedFrameBytes})`, settled.queuedFrameBytes === 0),
      functionalCheck(`no backpressured clients after drain (got ${settled.backpressuredClients})`, settled.backpressuredClients === 0),
      functionalCheck(`client still registered (activeClients=${settled.activeClients})`, settled.activeClients === 1),
    ];

    const peak = process.memoryUsage();
    return {
      budgets: {},
      metrics: memoryMetrics(baseline, sampler, {
        peakHeapDeltaMiB: (sampler.maxHeapUsed - baseline.heapUsed) / MIB,
        maxBackpressuredClients,
        observedBackpressure: maxBackpressuredClients > 0,
        framesReceived: collector.frames.length,
        bytesReceivedMiB: collector.totalBytes / MIB,
        peakRssMiB: Math.max(sampler.maxRss, peak.rss) / MIB,
      }),
      counts: { burstFrames: burstFrames.length, activeClients: settled.activeClients },
      checks,
    };
  } finally {
    clearInterval(interval);
    await closeSseServer(server, client ? [client] : []);
  }
}

// ---------------------------------------------------------------------------
// Scenario: sse-blocked-client
// ---------------------------------------------------------------------------

async function runSseBlockedClient(args) {
  const { server, bus, port } = await startSseServer({ keepAliveMs: 60_000 });
  const sampler = createSampler();
  const interval = setInterval(() => sampleMemory(sampler), 20);
  interval.unref();
  let client = null;

  try {
    // Client that never reads: no data listener on the response Readable ->
    // the stream never flows -> kernel backpressure propagates to the
    // server's write buffer.
    client = await connectSseClient(port);

    gc();
    const baseline = process.memoryUsage();
    resetSamplerPeaks(sampler, baseline);

    const TOTAL = 10_000;
    const payload = buildBurstPayload(-1, 256 * 1024);
    let removalSeenAt = -1;

    for (let index = 0; index < TOTAL; index += 1) {
      bus.broadcast('blocked-burst', payload);
      if (index % 10 === 0) {
        sampleMemory(sampler);
        const stats = bus.getStats();
        if (removalSeenAt === -1 && stats.activeClients === 0) {
          removalSeenAt = index;
        }
      }
      // The test driver allocates a ~256 KiB frame string per broadcast
      // (JSON.stringify inside the bus). That churn is driver/bus
      // allocation noise, not retention: collect periodically so the RSS
      // budget measures what the bus actually retains (queue + socket
      // buffers) instead of uncollected large-object churn.
      if (index % 1_000 === 999) {
        gc();
      }
    }

    const afterBurst = bus.getStats();
    await waitFor(() => bus.getStats().activeClients === 0, 2_000, 'client removal');

    // Post-removal writes must not reach the removed client: broadcast
    // another 100 frames; any leaked write would add >= 25 MiB.
    for (let index = 0; index < 100; index += 1) {
      bus.broadcast('post-removal', payload);
    }
    await sleep(500);

    const finalStats = bus.getStats();

    // Now resume the response and count everything the client actually got.
    const received = await new Promise((resolve) => {
      const chunks = [];
      client.res.on('data', (chunk) => chunks.push(chunk));
      client.res.once('close', () => resolve(Buffer.concat(chunks)));
      client.res.once('end', () => {
        setTimeout(() => resolve(Buffer.concat(chunks)), 100);
      });
      client.res.resume();
      setTimeout(() => resolve(Buffer.concat(chunks)), 3_000);
    });
    destroySseClient(client);

    const receivedBytes = received.length;
    const receivedMiB = receivedBytes / MIB;

    const checks = [
      functionalCheck(
        `client dropped by byte budget (disconnects.byteBudget=${finalStats.disconnects.byteBudget}, drainTimeout=${finalStats.disconnects.drainTimeout})`,
        finalStats.disconnects.byteBudget === 1 && finalStats.disconnects.drainTimeout === 0
      ),
      functionalCheck(`no active clients after removal (got ${finalStats.activeClients})`, finalStats.activeClients === 0),
      functionalCheck(`zero queued bytes (got ${finalStats.queuedFrameBytes})`, finalStats.queuedFrameBytes === 0),
      functionalCheck(
        `no writes after removal: client received ${receivedMiB.toFixed(2)} MiB total (bound 4 MiB)`,
        receivedBytes < 4 * MIB
      ),
      functionalCheck('client socket actually ended', client.res.destroyed || finalStats.activeClients === 0),
    ];
    if (removalSeenAt !== -1) {
      checks.unshift(functionalCheck(
        `removal happened at the 2 MiB budget early in the burst (first observed after broadcast #${removalSeenAt})`,
        removalSeenAt < 200
      ));
    } else {
      checks.unshift(functionalCheck('removal observed during the burst', false));
    }

    const peak = process.memoryUsage();
    return {
      budgets: { rssDeltaMiB: 64 },
      metrics: memoryMetrics(baseline, sampler, {
        peakHeapDeltaMiB: (sampler.maxHeapUsed - baseline.heapUsed) / MIB,
        broadcasts: TOTAL + 100,
        removalFirstObservedAtBroadcast: removalSeenAt,
        receivedBytesMiB: receivedMiB,
        peakRssMiB: Math.max(sampler.maxRss, peak.rss) / MIB,
      }),
      counts: {
        byteBudgetDisconnects: finalStats.disconnects.byteBudget,
        drainTimeoutDisconnects: finalStats.disconnects.drainTimeout,
        activeClients: finalStats.activeClients,
      },
      checks,
    };
  } finally {
    clearInterval(interval);
    await closeSseServer(server, client ? [client] : []);
  }
}

// ---------------------------------------------------------------------------
// Scenario: sse-oversize-frame
// ---------------------------------------------------------------------------

async function runSseOversizeFrame(args) {
  const { server, bus, port } = await startSseServer({ keepAliveMs: 60_000 });
  let client = null;

  try {
    client = await connectSseClient(port);
    const collector = collectSseFrames(client.res, 8 * MIB); // hard cap: must never see the big frame
    await waitFor(() => collector.frames.some((frame) => frame.eventName === 'hello'), 5_000, 'initial hello event');

    // Single frame > 2 MiB: the client is removed BEFORE the frame is
    // written, even though its buffers are empty and it is draining.
    bus.broadcast('oversize', { blob: 'o'.repeat(2.5 * MIB) });
    await waitFor(() => bus.getStats().activeClients === 0, 2_000, 'oversize-frame removal');
    await sleep(300);

    const stats = bus.getStats();
    const checks = [
      functionalCheck(
        `oversize frame removed client before write (byteBudget=${stats.disconnects.byteBudget})`,
        stats.disconnects.byteBudget === 1
      ),
      functionalCheck(`no active clients (got ${stats.activeClients})`, stats.activeClients === 0),
      functionalCheck(
        `client received no part of the oversize frame (${collector.totalBytes} bytes total, bound 1 KiB)`,
        collector.totalBytes <= 1024
      ),
      functionalCheck('no oversize frame payload parsed', !collector.frames.some(
        (frame) => frame.eventName === 'oversize' || (frame.payload && frame.payload.blob)
      )),
    ];

    return {
      budgets: {},
      metrics: { clientBytes: collector.totalBytes },
      counts: { byteBudgetDisconnects: stats.disconnects.byteBudget },
      checks,
    };
  } finally {
    await closeSseServer(server, client ? [client] : []);
  }
}

// ---------------------------------------------------------------------------
// Scenario: sse-connect-cycles
// ---------------------------------------------------------------------------

async function runSseConnectCycles(args) {
  const { server, bus, port } = await startSseServer({ keepAliveMs: 30_000 });

  try {
    // Warmup connections first: libuv lazily creates a couple of internal
    // pipe handles on first socket activity that are unrelated to client
    // lifecycle. The baseline is taken after warmup so the drift check
    // measures per-cycle leaks, not lazy one-time handle creation.
    for (let warmup = 0; warmup < 3; warmup += 1) {
      const warmupClient = await connectSseClient(port);
      await waitFor(() => bus.getStats().activeClients >= 1, 2_000, 'warmup registration');
      destroySseClient(warmupClient);
      await waitFor(() => bus.getStats().activeClients === 0, 2_000, 'warmup removal');
    }
    await sleep(300);
    const baselineHandles = process.getActiveResourcesInfo().reduce((acc, type) => {
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});

    const CYCLES = 100;
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const client = await connectSseClient(port);
      // Wait until the server-side client is registered (prelude written).
      await waitFor(() => bus.getStats().activeClients >= 1, 2_000, `client registration (cycle ${cycle})`);
      destroySseClient(client);
      await waitFor(() => bus.getStats().activeClients === 0, 2_000, `client removal (cycle ${cycle})`);
    }

    // Settle: any cleanup timers drain.
    await sleep(500);

    const stats = bus.getStats();
    const afterHandles = process.getActiveResourcesInfo().reduce((acc, type) => {
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});

    const handleTypes = new Set([...Object.keys(baselineHandles), ...Object.keys(afterHandles)]);
    const handleDrift = [];
    let totalDrift = 0;
    for (const type of handleTypes) {
      const before = baselineHandles[type] || 0;
      const after = afterHandles[type] || 0;
      totalDrift += Math.max(0, after - before);
      if (type === 'TCPSocketWrap') {
        // Client sockets must close exactly: any survivor is a leak.
        if (after !== before) {
          handleDrift.push(`${type}: ${before} -> ${after}`);
        }
      } else if (after - before > 4) {
        // A per-cycle leak grows with the cycle count; a constant slack of
        // 4 tolerates lazy one-time libuv internals.
        handleDrift.push(`${type}: ${before} -> ${after}`);
      }
    }

    const checks = [
      functionalCheck(`zero active clients after 100 cycles (got ${stats.activeClients})`, stats.activeClients === 0),
      functionalCheck(`zero backpressured clients (got ${stats.backpressuredClients})`, stats.backpressuredClients === 0),
      functionalCheck(`zero queued frame bytes (got ${stats.queuedFrameBytes})`, stats.queuedFrameBytes === 0),
      functionalCheck(`zero writable bytes (got ${stats.writableBytes})`, stats.writableBytes === 0),
      functionalCheck(
        `no budget/timeout disconnects across cycles (byteBudget=${stats.disconnects.byteBudget}, drainTimeout=${stats.disconnects.drainTimeout})`,
        stats.disconnects.byteBudget === 0 && stats.disconnects.drainTimeout === 0
      ),
      functionalCheck(
        `no per-cycle handle/listener leak after 100 cycles (total drift ${totalDrift})${handleDrift.length ? `: ${handleDrift.join(', ')}` : ''}`,
        handleDrift.length === 0
      ),
    ];

    return {
      budgets: {},
      metrics: { cycles: CYCLES },
      counts: { activeClients: stats.activeClients },
      checks,
    };
  } finally {
    await closeSseServer(server, []);
  }
}

// ---------------------------------------------------------------------------
// Scenario: concurrent-metrics-sse
// ---------------------------------------------------------------------------

async function runConcurrentMetricsSse(args, manifest) {
  const { createServerApp } = require('../../build/server/app/create-server');

  const findFreePort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const freePort = probe.address().port;
        probe.close(() => resolve(freePort));
      });
      probe.on('error', reject);
    });

  const port = await findFreePort();
  // Isolation: never let the acceptance-style app attach to any external
  // delivery channel (the ambient environment may carry Feishu credentials).
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.FEISHU_CONNECTION_MODE;
  const app = createServerApp({
    host: '127.0.0.1',
    port,
    agentDir: args.workDir,
    sqlitePath: path.join(args.workDir, 'chat.sqlite'),
    projectDir: args.workDir,
    executeConversationAgent: async ({ agent, completedReplies }) => {
      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'concurrent load stub reply',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const sampler = createSampler();
  const interval = setInterval(() => sampleMemory(sampler), 50);
  interval.unref();
  const clients = [];

  const window = manifest.metricsWindow;
  const metricsUrl = (query) => `http://127.0.0.1:${port}/api/metrics/agent?${query}`;
  // One full-window report (the heavy bounded request, plan budget 512 MiB
  // for a single report) plus lighter concurrent load: agent-filtered and
  // sub-window reports, and invalid windows that must 400. The scenario
  // proves metrics + SSE interference-freedom, not multiplication of the
  // single-request bound.
  const validQueries = [
    `since=${window.since}&until=${window.until}`,
    `since=${window.since}&until=${window.until}&agentId=role-family-glm`,
    `since=${window.since}&until=${window.until}&agentId=role-family-gpt`,
    `since=2025-06-05&until=2025-06-12`,
    `since=2025-06-10T00:00:00Z&until=2025-06-20T00:00:00Z`,
  ];
  const invalidQueries = [
    '', // missing both
    `since=${window.since}`, // one-sided
    `until=${window.until}`, // one-sided
    `since=2025-01-01&until=2025-09-30`, // oversized
  ];

  try {
    await new Promise((resolve, reject) => {
      app.start((error) => (error ? reject(error) : resolve()));
    });

    // Warm baseline: one valid metrics request + observability probe.
    const warmup = await fetch(metricsUrl(validQueries[0]));
    if (warmup.status !== 200) throw new Error(`warmup metrics request returned ${warmup.status}`);
    await warmup.json();
    const warmupStats = await fetch(`http://127.0.0.1:${port}/api/runtime/stats`).then((response) => response.json());
    if (!warmupStats || !warmupStats.counters || !warmupStats.counters.sse) {
      throw new Error('runtime stats endpoint missing sse counters');
    }
    // Seeded conversations may legitimately hold queue states with pending
    // user messages; the workload must not add new ones.
    const baselineActiveQueues = warmupStats.counters.turns ? Number(warmupStats.counters.turns.activeQueues) || 0 : 0;
    gc();
    const baseline = process.memoryUsage();
    resetSamplerPeaks(sampler, baseline);

    // SSE clients on the real server.
    const SSE_CLIENTS = 4;
    const collectors = [];
    for (let index = 0; index < SSE_CLIENTS; index += 1) {
      const sseClient = await connectSseClient(port);
      clients.push(sseClient);
      collectors.push(collectSseFrames(sseClient.res));
    }
    await waitFor(
      () => collectors.every((collector) => collector.frames.some((frame) => frame.eventName === 'runtime_state')),
      5_000,
      'initial runtime_state events'
    );

    const statsDuring = await fetch(`http://127.0.0.1:${port}/api/runtime/stats`).then((response) => response.json());
    if (statsDuring.counters.sse.activeClients !== SSE_CLIENTS) {
      throw new Error(
        `expected ${SSE_CLIENTS} active SSE clients via runtime stats, got ${statsDuring.counters.sse.activeClients}`
      );
    }

    // Fire everything concurrently: 6 valid metrics + 4 invalid windows in
    // parallel with a sequential broadcast driver (message deletions on the
    // sse-driver conversation; each deletion broadcasts
    // conversation_messages_deleted + conversation_summary_updated). Deletion
    // POSTs run sequentially because they share one mutation lease.
    const MESSAGE_DELETIONS = 8;
    const deletionUrl = `http://127.0.0.1:${port}/api/conversations/synthetic-conversation-sse-driver/messages/delete`;
    const deletableMessageIds = Array.from(
      { length: MESSAGE_DELETIONS },
      (_, index) => `synthetic-sse-driver-message-${String(index).padStart(5, '0')}`
    );
    const start = process.hrtime.bigint();

    const [validResponses, invalidResponses, deletionStatuses] = await Promise.all([
      Promise.all(validQueries.map((query) => fetch(metricsUrl(query)))),
      Promise.all(invalidQueries.map((query) => fetch(metricsUrl(query)))),
      (async () => {
        const statuses = [];
        for (const messageId of deletableMessageIds) {
          const response = await fetch(deletionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageIds: [messageId] }),
          });
          statuses.push(response.status);
        }
        return statuses;
      })(),
    ]);
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

    const validBodies = await Promise.all(validResponses.map((response) => response.json()));
    const invalidBodies = await Promise.all(invalidResponses.map((response) => response.json()));

    const checks = [];
    checks.push(functionalCheck(
      `all ${validResponses.length} valid metrics requests returned 200`,
      validResponses.every((response) => response.status === 200)
    ));
    checks.push(functionalCheck(
      `all ${invalidResponses.length} invalid window requests returned 400`,
      invalidResponses.every((response) => response.status === 400)
    ));
    checks.push(functionalCheck(
      'invalid windows carry the stable error code',
      invalidBodies.every((body) => body && body.code === 'metrics_agent_window_invalid')
    ));
    checks.push(functionalCheck(
      `all ${MESSAGE_DELETIONS} broadcast-driver deletions succeeded`,
      deletionStatuses.every((status) => status === 200)
    ));

    const expectedTotalTurns = manifest.expectedMetrics.totalTurns;
    const fullWindowBody = validBodies[0];
    checks.push(functionalCheck(
      `full-window report total turns ${expectedTotalTurns}`,
      fullWindowBody.agents.reduce((sum, agent) => sum + agent.turns, 0) === expectedTotalTurns
    ));
    const glmBody = validBodies[1];
    const expectedGlm = manifest.expectedMetrics.agents.find((agent) => agent.agentId === 'role-family-glm');
    checks.push(functionalCheck(
      'filtered agent report matches expected turns',
      expectedGlm && glmBody.agents.length === 1 && glmBody.agents[0].turns === expectedGlm.turns
    ));

    // Every SSE client must have received every deletion broadcast, in
    // order.
    await waitFor(
      () => collectors.every(
        (collector) => collector.frames.filter((frame) => frame.eventName === 'conversation_messages_deleted').length
          >= MESSAGE_DELETIONS
      ),
      10_000,
      'all deletion broadcasts on every client'
    );

    for (let index = 0; index < collectors.length; index += 1) {
      const deletions = collectors[index].frames.filter((frame) => frame.eventName === 'conversation_messages_deleted');
      const deletedIds = deletions.map(
        (frame) => (frame.payload && Array.isArray(frame.payload.deletedMessageIds) ? frame.payload.deletedMessageIds[0] : '')
      );
      checks.push(functionalCheck(
        `sse client ${index} received all ${MESSAGE_DELETIONS} deletion broadcasts in order`,
        JSON.stringify(deletedIds) === JSON.stringify(deletableMessageIds),
        `got ${JSON.stringify(deletedIds.slice(0, 3))}...`
      ));
    }

    // Close clients, settle, verify counters via the real observability
    // endpoint.
    for (const sseClient of clients) {
      destroySseClient(sseClient);
    }
    await waitFor(
      async () => {
        const settled = await fetch(`http://127.0.0.1:${port}/api/runtime/stats`).then((response) => response.json());
        return settled.counters.sse.activeClients === 0;
      },
      5_000,
      'sse counters settle to zero'
    );

    const settledStats = await fetch(`http://127.0.0.1:${port}/api/runtime/stats`).then((response) => response.json());
    checks.push(functionalCheck(
      `runtime stats: sse clients settle to zero (got ${settledStats.counters.sse.activeClients})`,
      settledStats.counters.sse.activeClients === 0
    ));
    checks.push(functionalCheck(
      `runtime stats: turns settle (activeTurns=${settledStats.counters.turns.activeTurns}, activeQueues=${settledStats.counters.turns.activeQueues} <= baseline ${baselineActiveQueues})`,
      settledStats.counters.turns
        && settledStats.counters.turns.activeTurns === 0
        && settledStats.counters.turns.activeAgentSlots === 0
        && settledStats.counters.turns.activeQueues <= baselineActiveQueues
    ));

    await sleep(250);
    gc();
    const retained = process.memoryUsage();

    return {
      budgets: { rssDeltaMiB: 512 },
      metrics: memoryMetrics(baseline, sampler, {
        durationMs,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        retainedHeapDeltaMiB: (retained.heapUsed - baseline.heapUsed) / MIB,
        retainedRssMiB: retained.rss / MIB,
        retainedRssDeltaMiB: (retained.rss - baseline.rss) / MIB,
      }),
      counts: {
        validMetrics: validResponses.length,
        invalidMetrics: invalidResponses.length,
        broadcastDeletions: MESSAGE_DELETIONS,
        sseClients: SSE_CLIENTS,
      },
      checks,
    };
  } finally {
    clearInterval(interval);
    for (const sseClient of clients) {
      destroySseClient(sseClient);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      if (typeof timer.unref === 'function') timer.unref();
      app.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario: goal-workload-stability
// ---------------------------------------------------------------------------

async function runGoalWorkloadStability(args) {
  const { createTurnOrchestrator } = require('../../build/server/domain/conversation/turn-orchestrator');
  const { createChatAppStore } = require('../../build/lib/chat-app-store');

  const sqlitePath = path.join(args.workDir, 'goal-workload.sqlite');
  const store = createChatAppStore({ agentDir: args.workDir, sqlitePath });

  const executed = [];
  const orchestrator = createTurnOrchestrator({
    store,
    skillRegistry: { listSkills() { return []; }, resolveSkills() { return []; } },
    modeStore: { get() { return null; } },
    agentToolBridge: {},
    host: '127.0.0.1',
    port: 0,
    agentDir: args.workDir,
    sqlitePath,
    toolBaseUrl: 'http://127.0.0.1:0',
    agentToolScriptPath: path.join(args.workDir, 'agent-chat-tools.js'),
    sessionGoalAutoContinueMaxTurns: 20,
    executeConversationAgent: async ({ agent, completedReplies }) => {
      executed.push(agent.id);
      completedReplies.push({
        agentId: agent.id,
        senderName: agent.name,
        content: 'workload reply',
        status: 'completed',
      });
      return { stopTurn: false };
    },
  });

  const sampler = createSampler();
  const interval = setInterval(() => sampleMemory(sampler), 50);
  interval.unref();

  const CYCLES = 15; // 15 x 20 continuation turns = 300 turns
  const TURNS_PER_CYCLE = 20;

  // Each cycle gets a fresh conversation with a fresh active goal: this
  // mirrors the production goal-continuation engine (one long-running goal
  // conversation after another) without queue-state carryover between
  // cycles, and exercises queue settlement for retired conversations.
  function createWorkloadConversation(index) {
    const conversationId = `goal-workload-conversation-${index}`;
    store.createConversation({
      id: conversationId,
      title: `Goal Workload ${index}`,
      participants: ['role-family-gpt', 'role-family-glm'],
      metadata: {
        sessionGoal: {
          objective: 'Gate workload objective',
          status: 'active',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
      },
    });
    for (let messageIndex = 0; messageIndex < 4; messageIndex += 1) {
      store.createMessage({
        id: `goal-workload-${index}-seed-${messageIndex}`,
        conversationId,
        turnId: `goal-workload-${index}-seed-turn`,
        role: messageIndex % 2 === 0 ? 'user' : 'assistant',
        agentId: messageIndex % 2 === 0 ? null : 'role-family-gpt',
        content: `seed message ${messageIndex}`,
        status: 'completed',
        metadata: {},
        createdAt: `2026-08-24T00:0${messageIndex}:00.000Z`,
      });
    }
    return conversationId;
  }

  try {
    // Warm-up cycle + gc -> warm baseline.
    const warmupConversation = createWorkloadConversation('warmup');
    const warmup = orchestrator.scheduleGoalContinuation(warmupConversation);
    if (!warmup.scheduled) throw new Error(`warmup continuation not scheduled: ${warmup.reason}`);
    await waitFor(() => executed.length >= TURNS_PER_CYCLE, 30_000, 'warmup cycle turns');
    await waitFor(
      () => {
        const stats = orchestrator.getRuntimeStats();
        return stats.activeTurns === 0 && stats.activeQueues === 0;
      },
      10_000,
      'warmup quiescence'
    );
    gc();
    const baseline = process.memoryUsage();
    resetSamplerPeaks(sampler, baseline);

    const executedAtWarmup = executed.length;

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const conversationId = createWorkloadConversation(cycle);
      const scheduled = orchestrator.scheduleGoalContinuation(conversationId);
      if (!scheduled.scheduled) {
        throw new Error(`cycle ${cycle} continuation not scheduled: ${scheduled.reason}`);
      }
      const target = executedAtWarmup + (cycle + 1) * TURNS_PER_CYCLE;
      await waitFor(() => executed.length >= target, 60_000, `cycle ${cycle} turns`);
      await waitFor(
        () => {
          const stats = orchestrator.getRuntimeStats();
          return stats.activeTurns === 0 && stats.activeQueues === 0;
        },
        10_000,
        `cycle ${cycle} quiescence`
      );
      sampleMemory(sampler);
    }

    const totalTurns = executed.length - executedAtWarmup;

    // Counters must settle to exactly zero after the whole workload.
    await sleep(300);
    const stats = orchestrator.getRuntimeStats();

    const checks = [
      functionalCheck(
        `all ${CYCLES * TURNS_PER_CYCLE} continuation turns executed (got ${totalTurns})`,
        totalTurns === CYCLES * TURNS_PER_CYCLE
      ),
      functionalCheck(`activeTurns settle to zero (got ${stats.activeTurns})`, stats.activeTurns === 0),
      functionalCheck(`activeQueues settle to zero (got ${stats.activeQueues})`, stats.activeQueues === 0),
      functionalCheck(`activeAgentSlots settle to zero (got ${stats.activeAgentSlots})`, stats.activeAgentSlots === 0),
    ];

    gc();
    const retained = process.memoryUsage();

    return {
      budgets: { retainedHeapDeltaMiB: 32 },
      metrics: {
        warmBaselineHeapUsedMiB: baseline.heapUsed / MIB,
        baselineRssMiB: baseline.rss / MIB,
        peakHeapUsedMiB: sampler.maxHeapUsed / MIB,
        peakRssMiB: sampler.maxRss / MIB,
        retainedHeapUsedMiB: retained.heapUsed / MIB,
        retainedRssMiB: retained.rss / MIB,
        samples: sampler.samples,
        turns: totalTurns,
      },
      counts: { turns: totalTurns, cycles: CYCLES },
      checks,
    };
  } finally {
    clearInterval(interval);
    store.close();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const manifest = args.manifestPath
    ? JSON.parse(fs.readFileSync(args.manifestPath, 'utf8'))
    : null;

  const scenarios = {
    'metrics-31d-bounded': () => runMetrics31dBounded(args, manifest),
    'sse-healthy-burst': () => runSseHealthyBurst(args),
    'sse-blocked-client': () => runSseBlockedClient(args),
    'sse-oversize-frame': () => runSseOversizeFrame(args),
    'sse-connect-cycles': () => runSseConnectCycles(args),
    'concurrent-metrics-sse': () => runConcurrentMetricsSse(args, manifest),
    'goal-workload-stability': () => runGoalWorkloadStability(args),
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
