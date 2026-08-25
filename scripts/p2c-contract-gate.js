#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const { generateSyntheticSeed } = require('./p2c-expand/synthetic-seed');

const MIB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 100;
const BUDGET = {
  durationMs: 30_000,
  heapDeltaMiB: 128,
  rssDeltaMiB: 220,
  retainedHeapDeltaMiB: 40,
  contractDatabaseDeltaMiB: 32,
  databaseGrowthRatio: 0.7,
  pagePayloadKiB: 256,
  ssePayloadKiB: 16,
};

function parseArgs(argv) {
  const options = {
    outDir: path.join('.tmp', 'p2c-contract-gate'),
    regenSeed: false,
    baseSeedDir: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--out') options.outDir = argv[++index];
    else if (argv[index] === '--regen-seed') options.regenSeed = true;
    else if (argv[index] === '--base-seed') options.baseSeedDir = argv[++index];
  }
  return options;
}

function copySqliteFiles(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir)) {
    if (entry.startsWith('chat.sqlite') || entry === 'shape-manifest.json') {
      fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
    }
  }
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

async function runChild(workDir, manifestPath) {
  const env = { ...process.env, CAFF_DISABLE_ENV_LOCAL: '1' };
  delete env.FEISHU_APP_ID;
  delete env.FEISHU_APP_SECRET;
  delete env.FEISHU_VERIFICATION_TOKEN;
  delete env.FEISHU_ENCRYPT_KEY;
  const child = spawn(process.execPath, [
    '--expose-gc',
    path.join(__dirname, 'p2c-contract', 'gate-child.js'),
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
      if (Number.isFinite(rss)) rssSamples.push(rss);
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

function evaluate(run) {
  const checks = [];
  if (run.exitCode !== 0 || !run.result || run.result.ok !== true) {
    checks.push({
      name: 'scenario completed',
      pass: false,
      detail: run.result && run.result.error || run.stderr || `exit ${run.exitCode}`,
    });
    if (run.result && Array.isArray(run.result.checks)) checks.push(...run.result.checks);
    return { pass: false, checks };
  }

  checks.push(...run.result.checks.map((check) => ({
    name: check.name,
    pass: Boolean(check.pass),
    detail: check.detail || '',
  })));
  const metrics = run.result.metrics;
  const heapDelta = metrics.peakHeapUsedMiB - metrics.baselineHeapUsedMiB;
  const retainedHeapDelta = metrics.retainedHeapUsedMiB - metrics.baselineHeapUsedMiB;
  const rssPeaks = [metrics.peakRssMiB, run.externalPeakRssMiB].filter(Number.isFinite);
  const peakRss = rssPeaks.length > 0 ? Math.max(...rssPeaks) : NaN;
  const rssDelta = peakRss - metrics.baselineRssMiB;
  const contractDatabaseDeltaMiB = metrics.contractDatabaseDeltaBytes / MIB;
  const databaseGrowthRatio = metrics.contractDatabaseDeltaBytes / metrics.expandDatabaseDeltaBytes;
  checks.push({ name: `duration ${metrics.durationMs.toFixed(1)}ms <= ${BUDGET.durationMs}ms`, pass: metrics.durationMs <= BUDGET.durationMs });
  checks.push({ name: `heap delta ${heapDelta.toFixed(1)}MiB <= ${BUDGET.heapDeltaMiB}MiB`, pass: heapDelta <= BUDGET.heapDeltaMiB });
  checks.push({
    name: `RSS delta ${rssDelta.toFixed(1)}MiB <= ${BUDGET.rssDeltaMiB}MiB`,
    pass: Number.isFinite(rssDelta) && rssDelta <= BUDGET.rssDeltaMiB,
  });
  checks.push({
    name: `retained heap delta ${retainedHeapDelta.toFixed(1)}MiB <= ${BUDGET.retainedHeapDeltaMiB}MiB`,
    pass: retainedHeapDelta <= BUDGET.retainedHeapDeltaMiB,
  });
  checks.push({
    name: `Contract DB delta ${contractDatabaseDeltaMiB.toFixed(1)}MiB <= ${BUDGET.contractDatabaseDeltaMiB}MiB`,
    pass: contractDatabaseDeltaMiB > 0 && contractDatabaseDeltaMiB <= BUDGET.contractDatabaseDeltaMiB,
  });
  checks.push({
    name: `Contract/Expand DB growth ratio ${databaseGrowthRatio.toFixed(3)} <= ${BUDGET.databaseGrowthRatio}`,
    pass: Number.isFinite(databaseGrowthRatio) && databaseGrowthRatio <= BUDGET.databaseGrowthRatio,
  });
  checks.push({
    name: `message page ${(metrics.pagePayloadBytes / 1024).toFixed(1)}KiB <= ${BUDGET.pagePayloadKiB}KiB`,
    pass: metrics.pagePayloadBytes <= BUDGET.pagePayloadKiB * 1024,
  });
  checks.push({
    name: `message SSE ${(metrics.ssePayloadBytes / 1024).toFixed(1)}KiB <= ${BUDGET.ssePayloadKiB}KiB`,
    pass: metrics.ssePayloadBytes <= BUDGET.ssePayloadKiB * 1024,
  });
  return { pass: checks.every((check) => check.pass), checks };
}

async function main() {
  const options = parseArgs(process.argv);
  const outDir = path.resolve(options.outDir);
  const seedDir = path.join(outDir, 'seed');
  const manifestPath = path.join(seedDir, 'shape-manifest.json');
  if (options.regenSeed) fs.rmSync(seedDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  if (!manifest) {
    if (options.baseSeedDir) {
      copySqliteFiles(path.resolve(options.baseSeedDir), seedDir);
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      process.stdout.write('gate: generating P2C-Contract production-shape seed; this can take several minutes...\n');
      manifest = generateSyntheticSeed({ outputDir: seedDir });
    }
  }

  if (manifest.messages !== 15052) throw new Error(`seed message count ${manifest.messages} !== 15052`);
  if (manifest.metadataBytes < 350 * MIB || manifest.metadataBytes > 410 * MIB) {
    throw new Error(`seed metadata shape ${(manifest.metadataBytes / MIB).toFixed(1)}MiB is outside 350-410MiB`);
  }
  if (!manifest.p2cExpand || manifest.p2cExpand.integrityCheck !== 'ok' || manifest.p2cExpand.foreignKeyViolations !== 0) {
    throw new Error('seed is missing accepted P2C-Expand shape evidence');
  }

  process.stdout.write(
    `gate: seed ${manifest.messages} messages, ${(manifest.metadataBytes / MIB).toFixed(1)}MiB metadata, `
    + `${manifest.p2cExpand.legacySnapshotRows} legacy object snapshots\n`
  );
  const startedAt = new Date().toISOString();
  const workDir = path.join(outDir, 'run-contract');
  fs.rmSync(workDir, { recursive: true, force: true });
  copySqliteFiles(seedDir, workDir);
  const run = await runChild(workDir, manifestPath);
  const evaluation = evaluate(run);
  for (const check of evaluation.checks) {
    process.stdout.write(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` -- ${check.detail}` : ''}\n`);
  }

  const report = {
    gate: 'p2c-contract-message-metadata',
    startedAt,
    finishedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    pass: evaluation.pass,
    seed: {
      messages: manifest.messages,
      conversations: manifest.conversations,
      metadataBytes: manifest.metadataBytes,
      maxSingleMetadataBytes: manifest.maxSingleMetadataBytes,
      largestConversation: manifest.largestConversation,
      dbSizeBytes: manifest.dbSizeBytes,
      p2cExpand: manifest.p2cExpand,
    },
    scenario: {
      pass: evaluation.pass,
      checks: evaluation.checks,
      metrics: run.result && run.result.metrics || null,
      counts: run.result && run.result.counts || null,
      externalRss: { samples: run.externalRssSamples, peakRssMiB: run.externalPeakRssMiB },
      stderr: run.stderr ? run.stderr.split('\n').slice(-20) : [],
      error: run.result && run.result.error || null,
    },
  };
  const reportPath = path.join(outDir, 'gate-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  fs.rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(`gate: ${evaluation.pass ? 'ALL PASS' : 'FAILED'}\nreport: ${reportPath}\n`);
  process.exitCode = evaluation.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack || error)}\n`);
  process.exitCode = 1;
});
