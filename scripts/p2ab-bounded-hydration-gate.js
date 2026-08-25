#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const { generateSyntheticSeed } = require('./p2ab-bounded-hydration/synthetic-seed');

const MIB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 100;
const BUDGETS = {
  'main-turn': { durationMs: 10_000, heapDeltaMiB: 64, rssDeltaMiB: 128, retainedHeapDeltaMiB: 32 },
  'goal-300': { durationMs: 60_000, heapDeltaMiB: 128, rssDeltaMiB: 256, retainedHeapDeltaMiB: 32 },
  'concurrent-turns': { durationMs: 30_000, heapDeltaMiB: 192, rssDeltaMiB: 320, retainedHeapDeltaMiB: 32 },
  'restart-recovery': { durationMs: 20_000, heapDeltaMiB: 64, rssDeltaMiB: 128, retainedHeapDeltaMiB: 32 },
  'side-snapshot': { durationMs: 10_000, heapDeltaMiB: 64, rssDeltaMiB: 128, retainedHeapDeltaMiB: 32 },
  'deletion-reconcile': { durationMs: 5_000, heapDeltaMiB: 32, rssDeltaMiB: 64, retainedHeapDeltaMiB: 16 },
};

function parseArgs(argv) {
  const options = {
    outDir: path.join('.tmp', 'p2ab-bounded-hydration-gate'),
    regenSeed: false,
    scenarios: Object.keys(BUDGETS),
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--out') options.outDir = argv[++index];
    else if (argv[index] === '--regen-seed') options.regenSeed = true;
    else if (argv[index] === '--scenarios') {
      options.scenarios = String(argv[++index] || '').split(',').map((value) => value.trim()).filter(Boolean);
    }
  }
  for (const scenario of options.scenarios) {
    if (!BUDGETS[scenario]) throw new Error(`unknown scenario: ${scenario}`);
  }
  return options;
}

function sampleWindows(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const line = String(stdout).split('\n').find((entry) => entry.includes('"'));
      if (!line) return resolve(null);
      const columns = line.split('","').map((value) => value.replace(/^"|"$/g, ''));
      const match = String(columns[columns.length - 1] || '').match(/^([\d,.]+)\s*K/i);
      if (!match) return resolve(null);
      return resolve(Number(match[1].replace(/[,.]/g, '')) * 1024);
    });
  });
}

async function sampleLinux(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

async function runChild(scenario, workDir, manifestPath) {
  const env = { ...process.env, CAFF_DISABLE_ENV_LOCAL: '1' };
  delete env.FEISHU_APP_ID;
  delete env.FEISHU_APP_SECRET;
  delete env.FEISHU_VERIFICATION_TOKEN;
  delete env.FEISHU_ENCRYPT_KEY;
  const child = spawn(process.execPath, [
    '--expose-gc',
    path.join(__dirname, 'p2ab-bounded-hydration', 'gate-child.js'),
    '--scenario', scenario,
    '--work-dir', workDir,
    '--manifest', manifestPath,
  ], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const rssSamples = [];
  let sampling = true;
  const sampleLoop = (async () => {
    while (sampling && child.exitCode === null) {
      const rss = process.platform === 'win32' ? await sampleWindows(child.pid) : await sampleLinux(child.pid);
      if (typeof rss === 'number' && Number.isFinite(rss)) rssSamples.push(rss);
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
    }
  })();
  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', (error) => {
      stderr += String(error && error.stack || error);
      resolve(1);
    });
  });
  sampling = false;
  await sampleLoop;
  const jsonLine = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{')).pop();
  let result = null;
  try { result = jsonLine ? JSON.parse(jsonLine) : null; } catch {}
  return {
    exitCode,
    result,
    stderr: stderr.trim(),
    externalPeakRssMiB: rssSamples.length > 0 ? Math.max(...rssSamples) / MIB : null,
    externalRssSamples: rssSamples.length,
  };
}

function evaluate(scenario, run) {
  const budget = BUDGETS[scenario];
  const checks = [];
  if (run.exitCode !== 0 || !run.result || run.result.ok !== true) {
    checks.push({
      name: 'scenario completed',
      pass: false,
      detail: run.result && run.result.error || run.stderr || `exit ${run.exitCode}`,
    });
    return { pass: false, checks };
  }
  for (const check of Array.isArray(run.result.checks) ? run.result.checks : []) {
    checks.push({ name: check.name, pass: Boolean(check.pass), detail: check.detail || '' });
  }
  const metrics = run.result.metrics;
  const heapDelta = metrics.peakHeapUsedMiB - metrics.baselineHeapUsedMiB;
  const retainedHeapDelta = metrics.retainedHeapUsedMiB - metrics.baselineHeapUsedMiB;
  const rssPeaks = [metrics.peakRssMiB, run.externalPeakRssMiB]
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const peakRss = rssPeaks.length > 0 ? Math.max(...rssPeaks) : NaN;
  const rssDelta = peakRss - metrics.baselineRssMiB;
  checks.push({ name: `duration ${metrics.durationMs.toFixed(1)}ms <= ${budget.durationMs}ms`, pass: metrics.durationMs <= budget.durationMs });
  checks.push({ name: `heap delta ${heapDelta.toFixed(1)}MiB <= ${budget.heapDeltaMiB}MiB`, pass: heapDelta <= budget.heapDeltaMiB });
  checks.push({
    name: `RSS delta ${rssDelta.toFixed(1)}MiB <= ${budget.rssDeltaMiB}MiB (in-process ${metrics.peakRssMiB.toFixed(1)}MiB, external ${run.externalPeakRssMiB === null ? 'n/a' : run.externalPeakRssMiB.toFixed(1)}MiB)`,
    pass: Number.isFinite(rssDelta) && rssDelta <= budget.rssDeltaMiB,
  });
  checks.push({
    name: `post-GC retained heap delta ${retainedHeapDelta.toFixed(1)}MiB <= ${budget.retainedHeapDeltaMiB}MiB`,
    pass: retainedHeapDelta <= budget.retainedHeapDeltaMiB,
  });
  return { pass: checks.every((check) => check.pass), checks };
}

async function main() {
  const options = parseArgs(process.argv);
  const outDir = path.resolve(options.outDir);
  const seedDir = path.join(outDir, 'seed');
  const manifestPath = path.join(seedDir, 'shape-manifest.json');
  fs.mkdirSync(outDir, { recursive: true });
  if (options.regenSeed) fs.rmSync(seedDir, { recursive: true, force: true });
  let manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  if (!manifest || !manifest.p2ab) {
    process.stdout.write('gate: generating P2A+B production-shape seed; this can take several minutes...\n');
    manifest = generateSyntheticSeed({ outputDir: seedDir });
  }
  if (manifest.messages !== 15052) throw new Error(`seed message count ${manifest.messages} !== 15052`);
  if (manifest.metadataBytes < 350 * MIB || manifest.metadataBytes > 410 * MIB) {
    throw new Error(`seed metadata shape ${(manifest.metadataBytes / MIB).toFixed(1)}MiB is outside 350-410MiB`);
  }
  if (manifest.p2ab.integrityCheck !== 'ok') throw new Error(`seed integrity_check=${manifest.p2ab.integrityCheck}`);
  process.stdout.write(
    `gate: seed ${manifest.messages} messages, ${(manifest.metadataBytes / MIB).toFixed(1)}MiB metadata, ` +
    `${manifest.p2ab.privateMessages} private rows, max ${(manifest.maxSingleMetadataBytes / 1024).toFixed(1)}KiB\n`
  );

  const report = {
    gate: 'p2ab-bounded-conversation-hydration',
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    seed: {
      messages: manifest.messages,
      conversations: manifest.conversations,
      metadataBytes: manifest.metadataBytes,
      maxSingleMetadataBytes: manifest.maxSingleMetadataBytes,
      largestConversation: manifest.largestConversation,
      digestDistribution: manifest.digestDistribution,
      privateMessages: manifest.p2ab.privateMessages,
      fixtures: manifest.p2ab,
      dbSizeBytes: manifest.dbSizeBytes,
    },
    scenarios: [],
  };
  let allPass = true;
  for (const scenario of options.scenarios) {
    const workDir = path.join(outDir, `run-${scenario}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    for (const entry of fs.readdirSync(seedDir)) {
      if (entry.startsWith('chat.sqlite')) {
        fs.copyFileSync(path.join(seedDir, entry), path.join(workDir, entry));
      }
    }
    process.stdout.write(`gate: ${scenario}\n`);
    const run = await runChild(scenario, workDir, manifestPath);
    const evaluation = evaluate(scenario, run);
    allPass = allPass && evaluation.pass;
    for (const check of evaluation.checks) {
      process.stdout.write(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` -- ${check.detail}` : ''}\n`);
    }
    report.scenarios.push({
      scenario,
      pass: evaluation.pass,
      checks: evaluation.checks,
      metrics: run.result && run.result.metrics || null,
      counts: run.result && run.result.counts || null,
      projections: run.result && run.result.projections || null,
      externalRss: { samples: run.externalRssSamples, peakRssMiB: run.externalPeakRssMiB },
      stderr: run.stderr ? run.stderr.split('\n').slice(-20) : [],
      error: run.result && run.result.error || null,
    });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  report.finishedAt = new Date().toISOString();
  report.pass = allPass;
  const reportPath = path.join(outDir, 'gate-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`gate: ${allPass ? 'ALL PASS' : 'FAILED'}\nreport: ${reportPath}\n`);
  process.exitCode = allPass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack || error)}\n`);
  process.exitCode = 1;
});
