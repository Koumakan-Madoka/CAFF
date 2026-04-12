const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = process.cwd();
const requiredBuildArtifacts = [
  path.resolve(ROOT_DIR, 'build', 'lib', 'app-server.js'),
  path.resolve(ROOT_DIR, 'build', 'lib', 'env-local-loader.js'),
];

function findMissingArtifacts() {
  return requiredBuildArtifacts.filter((artifactPath) => !fs.existsSync(artifactPath));
}

function formatArtifactList(artifactPaths) {
  return artifactPaths
    .map((artifactPath) => path.relative(ROOT_DIR, artifactPath) || artifactPath)
    .join(', ');
}

const missingArtifacts = findMissingArtifacts();

if (missingArtifacts.length === 0) {
  process.exit(0);
}

const relativeMissingArtifacts = formatArtifactList(missingArtifacts);
const omitValue = String(process.env.npm_config_omit || '');
const omit = new Set(
  omitValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
);
const isProduction =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production' ||
  String(process.env.npm_config_production || '').toLowerCase() === 'true' ||
  omit.has('dev');
const tscPath = path.resolve(
  ROOT_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);
const canBuild = fs.existsSync(tscPath);

if (isProduction || !canBuild) {
  console.error(`[prestart] Missing build artifacts: ${relativeMissingArtifacts}.`);
  console.error('[prestart] Build artifacts are required to start with production-only dependencies.');
  console.error('[prestart] Build first (with dev deps) via: npm run build');
  console.error('[prestart] Or for local dev: npm run start:dev');
  process.exit(1);
}

console.log(`[prestart] Missing build artifacts: ${relativeMissingArtifacts}. Running npm run build...`);

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'build'], {
  cwd: ROOT_DIR,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`[prestart] Failed to run ${npmCommand}: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

const missingArtifactsAfterBuild = findMissingArtifacts();

if (missingArtifactsAfterBuild.length > 0) {
  console.error(
    `[prestart] Build completed but artifacts are still missing: ${formatArtifactList(missingArtifactsAfterBuild)}.`
  );
  process.exit(1);
}
