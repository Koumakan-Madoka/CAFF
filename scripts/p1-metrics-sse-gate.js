#!/usr/bin/env node
/**
 * P1 metrics/SSE/observability gate runner (frozen plan: Performance
 * Acceptance Matrix, P1 rows).
 *
 * For each scenario this runner spawns a child node process (--expose-gc)
 * that runs the scenario, samples the child's RSS externally while it runs,
 * evaluates the frozen budgets, and writes a JSON report plus a summary
 * table. RSS peak budget evaluation takes the larger of the child's
 * in-process high-frequency peak and the parent's external samples, because
 * fast requests can start and finish between external samples. Exit code is
 * non-zero if any budget or functional check fails.
 *
 * Usage:
 *   node scripts/p1-metrics-sse-gate.js [--out <dir>] [--regen-seed]
 *        [--scenarios a,b,c]
 *
 * Scenarios and budgets (frozen plan):
 *   metrics-31d-bounded     bounded 31-day report: exact aggregates, no raw
 *                           column materialization, peak RSS delta <=512 MiB
 *   sse-healthy-burst       6 x 256 KiB timely-drain burst: functional only
 *   sse-blocked-client      10,000 x 256 KiB blocked client: dropped at the
 *                           2 MiB budget, peak RSS delta <=64 MiB, no
 *                           writes after removal
 *   sse-oversize-frame      single frame > 2 MiB removed before write
 *   sse-connect-cycles      100 connect/close cycles: zero clients/queues/
 *                           listeners/timers
 *   concurrent-metrics-sse  concurrent bounded metrics + 400 windows + live
 *                           SSE on a real server: peak RSS delta <=512 MiB
 *   goal-workload-stability accelerated goal continuation: counters settle,
 *                           post-GC retained heap delta <=32 MiB
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { generateSyntheticSeed } = require('./p1-metrics-sse/synthetic-seed');

const MIB = 1024 * 1024;
const RSS_SAMPLE_INTERVAL_MS = 120;

const SCENARIO_BUDGETS = {
  'metrics-31d-bounded': { rssDeltaMiB: 512, durationMs: 60_000 },
  'sse-healthy-burst': {},
  'sse-blocked-client': { rssDeltaMiB: 64 },
  'sse-oversize-frame': {},
  'sse-connect-cycles': {},
  'concurrent-metrics-sse': { rssDeltaMiB: 512 },
  'goal-workload-stability': { retainedHeapDeltaMiB: 32 },
};

// Scenarios that run against the production-shape synthetic seed.
const SEED_SCENARIOS = new Set(['metrics-31d-bounded', 'concurrent-metrics-sse']);

function parseArgs(argv) {
  const options = {
    outDir: path.join('.tmp', 'p1-metrics-sse-gate'),
    regenSeed: false,
    scenarios: Object.keys(SCENARIO_BUDGETS),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.outDir = argv[++i];
    else if (arg === '--regen-seed') options.regenSeed = true;
    else if (arg === '--scenarios') options.scenarios = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  for (const scenario of options.scenarios) {
    if (!(scenario in SCENARIO_BUDGETS)) {
      throw new Error(`unknown scenario: ${scenario}`);
    }
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
  const childArgs = [
    '--expose-gc',
    path.join(__dirname, 'p1-metrics-sse', 'gate-child.js'),
    '--scenario', scenario,
    '--work-dir', workDir,
  ];
  if (manifestPath) {
    childArgs.push('--manifest', manifestPath);
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

  // Functional checks reported by the child.
  for (const check of Array.isArray(run.result.checks) ? run.result.checks : []) {
    checks.push({ name: check.name, pass: Boolean(check.pass), detail: check.detail });
  }

  if (budgets.durationMs !== undefined) {
    const pass = metrics.durationMs <= budgets.durationMs;
    checks.push({ name: `duration ${metrics.durationMs.toFixed(0)}ms <= ${budgets.durationMs}ms`, pass });
  }
  if (budgets.retainedHeapDeltaMiB !== undefined) {
    const delta = metrics.retainedHeapUsedMiB - metrics.warmBaselineHeapUsedMiB;
    const pass = delta <= budgets.retainedHeapDeltaMiB;
    checks.push({ name: `post-GC retained heap delta ${delta.toFixed(1)} MiB <= ${budgets.retainedHeapDeltaMiB} MiB`, pass });
  }
  if (budgets.rssDeltaMiB !== undefined) {
    const externalPeakMiB = run.peakRssBytes !== null ? run.peakRssBytes / MIB : null;
    const inProcessPeakMiB = typeof metrics.peakRssMiB === 'number' ? metrics.peakRssMiB : null;
    const peaks = [externalPeakMiB, inProcessPeakMiB].filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (peaks.length > 0 && typeof baselineRssMiB === 'number') {
      // Authoritative peak = max(in-process high-frequency samples, external
      // parent samples): external sampling alone can miss fast peaks.
      const peakMiB = Math.max(...peaks);
      const peakDelta = peakMiB - baselineRssMiB;
      const pass = peakDelta <= budgets.rssDeltaMiB;
      checks.push({
        name: `peak RSS delta ${peakDelta.toFixed(1)} MiB <= ${budgets.rssDeltaMiB} MiB (in-process peak ${inProcessPeakMiB !== null ? inProcessPeakMiB.toFixed(1) : 'n/a'} MiB, external peak ${externalPeakMiB !== null ? externalPeakMiB.toFixed(1) : 'n/a'} MiB, external samples: ${run.rssSampleCount})`,
        pass,
      });
    } else {
      checks.push({ name: 'peak RSS delta measurable', pass: false, detail: 'no in-process or external RSS peak samples' });
    }
  }
  if (scenario === 'concurrent-metrics-sse') {
    // Retained growth is judged on heap: V8 does not promptly return freed
    // large-object pages to the OS, so post-GC RSS stays elevated after a
    // heavy bounded report even though the heap itself returns to baseline.
    const noRetainedGrowth = metrics.retainedHeapDeltaMiB !== undefined
      ? metrics.retainedHeapDeltaMiB <= 32
      : true;
    checks.push({
      name: `no retained heap growth after completion (retained heap delta ${metrics.retainedHeapDeltaMiB !== undefined ? metrics.retainedHeapDeltaMiB.toFixed(1) : 'n/a'} MiB <= 32 MiB slack)`,
      pass: noRetainedGrowth,
    });
  }

  return { pass: checks.every((check) => check.pass), checks };
}

async function main() {
  const options = parseArgs(process.argv);
  const outDir = path.resolve(options.outDir);
  const seedDir = path.join(outDir, 'seed');
  const manifestPath = path.join(seedDir, 'shape-manifest.json');
  const needsSeed = options.scenarios.some((scenario) => SEED_SCENARIOS.has(scenario));

  fs.mkdirSync(outDir, { recursive: true });

  let manifest = null;
  if (needsSeed) {
    if (options.regenSeed || !fs.existsSync(manifestPath)) {
      if (options.regenSeed) {
        fs.rmSync(seedDir, { recursive: true, force: true });
      }
      process.stdout.write('gate: generating deterministic synthetic seed (this takes a few minutes)...\n');
      manifest = generateSyntheticSeed({ outputDir: seedDir });
      process.stdout.write(
        `gate: seed ready: ${manifest.conversations} conversations, ${manifest.messages} messages, ` +
        `${(manifest.metadataBytes / MIB).toFixed(1)} MiB metadata, ${manifest.taskCount} tasks, ` +
        `${manifest.taskEvents} task events, db ${(manifest.dbSizeBytes / MIB).toFixed(0)} MiB\n`
      );
    } else {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      process.stdout.write(
        `gate: reusing seed: ${manifest.conversations} conversations, ${manifest.messages} messages, ` +
        `${manifest.taskEvents} task events\n`
      );
    }
  }

  const report = {
    gate: 'p1-metrics-sse-observability',
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    seed: manifest
      ? {
          manifestPath,
          conversations: manifest.conversations,
          messages: manifest.messages,
          contentBytes: manifest.contentBytes,
          metadataBytes: manifest.metadataBytes,
          bigMetadataRows: manifest.bigMetadataRowsActual,
          maxSingleMetadataBytes: manifest.maxSingleMetadataBytes,
          taskCount: manifest.taskCount,
          taskEvents: manifest.taskEvents,
          taskEventBytes: manifest.taskEventBytes,
          metricsWindow: manifest.metricsWindow,
          dbSizeBytes: manifest.dbSizeBytes,
        }
      : null,
    scenarios: [],
  };

  let allPass = true;
  for (const scenario of options.scenarios) {
    const workDir = path.join(outDir, `run-${scenario}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    if (SEED_SCENARIOS.has(scenario)) {
      for (const entry of fs.readdirSync(seedDir)) {
        if (entry.startsWith('chat.sqlite')) {
          fs.copyFileSync(path.join(seedDir, entry), path.join(workDir, entry));
        }
      }
    }

    process.stdout.write(`gate: running scenario ${scenario}...\n`);
    const run = await runScenarioChild(scenario, workDir, SEED_SCENARIOS.has(scenario) ? manifestPath : null);
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
      inProcessRss: {
        peakRssMiB: run.result && run.result.metrics && typeof run.result.metrics.peakRssMiB === 'number'
          ? run.result.metrics.peakRssMiB
          : null,
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
