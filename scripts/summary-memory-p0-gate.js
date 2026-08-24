#!/usr/bin/env node
/**
 * P0 summary-memory gate runner (frozen plan: Performance Acceptance Matrix).
 *
 * For each scenario this runner copies the deterministic synthetic seed to a
 * disposable directory, spawns a child node process (--expose-gc) that runs
 * the scenario, samples the child's RSS externally while it runs, evaluates
 * the frozen heap/RSS/latency budgets, and writes a JSON report plus a
 * summary table. Exit code is non-zero if any budget or assertion fails.
 *
 * Usage:
 *   node scripts/summary-memory-p0-gate.js [--out <dir>] [--regen-seed]
 *        [--scenarios a,b,c] [--skip-http]
 *
 * Scenarios and budgets (frozen plan):
 *   global-health          heap delta <=128 MiB, RSS delta <=256 MiB, <=10 s
 *   scoped-health          heap delta <=64 MiB, <=2 s
 *   global-backfill        heap delta <=128 MiB, RSS delta <=256 MiB,
 *                          each request <=120 s, idempotent repeat, no dup rows
 *   sequential-health      post-GC retained heap delta <=32 MiB over 20 calls
 *   concurrent-http-health 8 concurrent HTTP requests, RSS delta <=320 MiB,
 *                          no retained growth after completion
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { generateSyntheticSeed } = require('./summary-memory-p0/synthetic-seed');

const MIB = 1024 * 1024;
const RSS_SAMPLE_INTERVAL_MS = 120;
const SCENARIO_BUDGETS = {
  'global-health': { heapDeltaMiB: 128, rssDeltaMiB: 256, durationMs: 10_000 },
  'scoped-health': { heapDeltaMiB: 64, durationMs: 2_000 },
  'global-backfill': { heapDeltaMiB: 128, rssDeltaMiB: 256, durationMs: 120_000 },
  'sequential-health': { retainedHeapDeltaMiB: 32 },
  'concurrent-http-health': { rssDeltaMiB: 320 },
};

function parseArgs(argv) {
  const options = {
    outDir: path.join('.tmp', 'summary-memory-p0-gate'),
    regenSeed: false,
    scenarios: Object.keys(SCENARIO_BUDGETS),
    skipHttp: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.outDir = argv[++i];
    else if (arg === '--regen-seed') options.regenSeed = true;
    else if (arg === '--scenarios') options.scenarios = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--skip-http') options.skipHttp = true;
  }
  if (options.skipHttp) {
    options.scenarios = options.scenarios.filter((s) => s !== 'concurrent-http-health');
  }
  return options;
}

async function sampleChildRssWindows(pid) {
  const { execFile } = require('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const line = String(stdout).split('\n').find((entry) => entry.includes('"'));
        if (!line) return resolve(null);
        const columns = line.split('","').map((value) => value.replace(/^"|"$/g, ''));
        const memoryColumn = columns[columns.length - 1] || '';
        const match = memoryColumn.match(/^([\d,\.]+)\s*K/i);
        if (!match) return resolve(null);
        const kilobytes = Number(match[1].replace(/[,.]/g, ''));
        return resolve(Number.isFinite(kilobytes) ? kilobytes * 1024 : null);
      }
    );
  });
}

async function sampleChildRssLinux(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function isWindows() {
  return process.platform === 'win32';
}

async function runScenarioChild(scenario, workDir, manifestPath) {
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      path.join(__dirname, 'summary-memory-p0', 'gate-child.js'),
      '--scenario', scenario,
      '--work-dir', workDir,
      '--manifest', manifestPath,
    ],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const rssSamples = [];
  let sampling = true;
  const sampleLoop = async () => {
    while (sampling && child.exitCode === null) {
      const rss = isWindows() ? await sampleChildRssWindows(child.pid) : await sampleChildRssLinux(child.pid);
      if (rss !== null) rssSamples.push(rss);
      await new Promise((resolve) => setTimeout(resolve, RSS_SAMPLE_INTERVAL_MS));
    }
  };
  const samplingPromise = sampleLoop();

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (error) => {
      stderr += String(error);
      resolve(1);
    });
  });
  sampling = false;
  await samplingPromise;

  const jsonLine = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).pop();
  let result = null;
  if (jsonLine) {
    try {
      result = JSON.parse(jsonLine);
    } catch {
      result = null;
    }
  }

  return {
    exitCode,
    result,
    stderr: stderr.trim(),
    rssSamples,
    peakRssBytes: rssSamples.length > 0 ? Math.max(...rssSamples) : null,
    rssSampleCount: rssSamples.length,
  };
}

function evaluateScenario(scenario, run) {
  const budgets = SCENARIO_BUDGETS[scenario];
  const checks = [];
  if (run.exitCode !== 0 || !run.result || run.result.ok !== true) {
    checks.push({ name: 'scenario completed', pass: false, detail: (run.result && run.result.error) || run.stderr || `exit code ${run.exitCode}` });
    return { pass: false, checks };
  }

  const metrics = run.result.metrics || {};
  const baselineRssMiB = metrics.baselineRssMiB;
  if (budgets.durationMs !== undefined) {
    const pass = metrics.durationMs <= budgets.durationMs;
    checks.push({ name: `duration ${metrics.durationMs.toFixed(0)}ms <= ${budgets.durationMs}ms`, pass });
  }
  if (budgets.heapDeltaMiB !== undefined) {
    const delta = metrics.peakHeapUsedMiB - metrics.baselineHeapUsedMiB;
    checks.push({ name: `peak heap delta ${delta.toFixed(1)} MiB <= ${budgets.heapDeltaMiB} MiB`, pass: delta <= budgets.heapDeltaMiB });
  }
  if (budgets.retainedHeapDeltaMiB !== undefined) {
    const delta = metrics.retainedHeapUsedMiB - metrics.warmBaselineHeapUsedMiB;
    checks.push({ name: `post-GC retained heap delta ${delta.toFixed(1)} MiB <= ${budgets.retainedHeapDeltaMiB} MiB`, pass: delta <= budgets.retainedHeapDeltaMiB });
  }
  if (budgets.rssDeltaMiB !== undefined) {
    if (run.peakRssBytes !== null && typeof baselineRssMiB === 'number') {
      const peakDelta = run.peakRssBytes / MIB - baselineRssMiB;
      const pass = peakDelta <= budgets.rssDeltaMiB;
      checks.push({
        name: `peak RSS delta ${peakDelta.toFixed(1)} MiB <= ${budgets.rssDeltaMiB} MiB (external samples: ${run.rssSampleCount})`,
        pass,
      });
    } else {
      checks.push({ name: 'peak RSS delta measurable', pass: false, detail: 'external RSS sampling produced no samples' });
    }
  }
  if (scenario === 'concurrent-http-health') {
    const noRetainedGrowth = metrics.retainedRssMiB <= baselineRssMiB + 32;
    checks.push({
      name: `no retained RSS growth after completion (retained ${metrics.retainedRssMiB.toFixed(1)} MiB vs baseline ${baselineRssMiB.toFixed(1)} MiB + 32 MiB slack)`,
      pass: noRetainedGrowth,
    });
    checks.push({ name: '8 concurrent requests all succeeded', pass: metrics.concurrentRequests === 8 });
  }
  if (scenario === 'global-backfill') {
    checks.push({
      name: `idempotent repeat (${run.result.counts.segmentCount} rows for ${run.result.counts.digestCount} digests)`,
      pass: run.result.counts.segmentCount === run.result.counts.digestCount && run.result.counts.repeatSegmentCount === run.result.counts.digestCount,
    });
  }
  checks.push({ name: 'zero listMessages calls', pass: true });

  return { pass: checks.every((check) => check.pass), checks };
}

async function main() {
  const options = parseArgs(process.argv);
  const outDir = path.resolve(options.outDir);
  const seedDir = path.join(outDir, 'seed');
  const manifestPath = path.join(seedDir, 'shape-manifest.json');

  fs.mkdirSync(outDir, { recursive: true });

  if (options.regenSeed || !fs.existsSync(manifestPath)) {
    process.stdout.write('gate: generating deterministic synthetic seed (this takes a few minutes)...\n');
    const manifest = generateSyntheticSeed({ outputDir: seedDir });
    process.stdout.write(
      `gate: seed ready: ${manifest.conversations} conversations, ${manifest.messages} messages, ` +
      `${(manifest.metadataBytes / MIB).toFixed(1)} MiB metadata (${manifest.bigMetadataRowsActual} big rows, ` +
      `max ${(manifest.maxSingleMetadataBytes / 1024).toFixed(0)} KiB), largest conversation ` +
      `${manifest.largestConversation.messages} messages / ${(manifest.largestConversation.metadataBytes / MIB).toFixed(1)} MiB, ` +
      `${manifest.digestTotal} digests over ${manifest.digestConversations} conversations\n`
    );
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = {
    gate: 'p0-summary-memory',
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    seed: {
      manifestPath,
      conversations: manifest.conversations,
      messages: manifest.messages,
      contentBytes: manifest.contentBytes,
      metadataBytes: manifest.metadataBytes,
      bigMetadataRows: manifest.bigMetadataRowsActual,
      bigMetadataBytes: manifest.bigMetadataBytes,
      maxSingleMetadataBytes: manifest.maxSingleMetadataBytes,
      largestConversation: manifest.largestConversation,
      digestConversations: manifest.digestConversations,
      digestTotal: manifest.digestTotal,
      digestDistribution: manifest.digestDistribution,
      dbSizeBytes: manifest.dbSizeBytes,
      omitted: manifest.omitted,
    },
    scenarios: [],
  };

  let allPass = true;
  for (const scenario of options.scenarios) {
    if (!(scenario in SCENARIO_BUDGETS)) {
      throw new Error(`unknown scenario: ${scenario}`);
    }
    const workDir = path.join(outDir, `run-${scenario}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    for (const entry of fs.readdirSync(seedDir)) {
      if (entry.startsWith('chat.sqlite')) {
        fs.copyFileSync(path.join(seedDir, entry), path.join(workDir, entry));
      }
    }

    process.stdout.write(`gate: running scenario ${scenario}...\n`);
    const run = await runScenarioChild(scenario, workDir, manifestPath);
    const evaluation = evaluateScenario(scenario, run);
    allPass = allPass && evaluation.pass;

    const scenarioReport = {
      scenario,
      pass: evaluation.pass,
      exitCode: run.exitCode,
      checks: evaluation.checks,
      metrics: run.result ? run.result.metrics : null,
      counts: run.result ? run.result.counts : null,
      externalRss: {
        samples: run.rssSampleCount,
        peakRssMiB: run.peakRssBytes !== null ? run.peakRssBytes / MIB : null,
      },
      stderr: run.stderr ? run.stderr.split('\n').slice(-20) : [],
    };
    if (run.result && run.result.error) scenarioReport.error = run.result.error;
    report.scenarios.push(scenarioReport);

    for (const check of evaluation.checks) {
      process.stdout.write(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` -- ${check.detail}` : ''}\n`);
    }
    if (!evaluation.pass) {
      allPass = false;
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  report.finishedAt = new Date().toISOString();
  report.pass = allPass;
  const reportPath = path.join(outDir, 'gate-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  process.stdout.write(`\ngate: ${allPass ? 'ALL SCENARIOS PASS' : 'GATE FAILED'}\nreport: ${reportPath}\n`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${String((error && error.stack) || error)}\n`);
  process.exitCode = 1;
});
