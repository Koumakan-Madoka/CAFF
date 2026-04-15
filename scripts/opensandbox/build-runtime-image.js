const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = process.cwd();
const DEFAULT_BASE_IMAGE = 'node:20-bookworm';
const DEFAULT_RUNTIME_DIR = '/opt/caff-skill-test/runtime';
const DEFAULT_PROJECT_DIR = '/opt/caff-skill-test/project';
const DEFAULT_RUNTIME_IMAGE_TAG = 'caff-skill-test-runtime:local';
const DEFAULT_CAFF_IMAGE_TAG = 'caff-skill-test-caff:local';
const DEFAULT_WSL_DISTRO = 'Debian';
const PROJECT_EXCLUDED_TOP_LEVEL_DIRS = new Set([
  '.pi-sandbox',
  '.trellis',
  '.tmp',
  '.cache',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);
const PROJECT_EXCLUDED_FILE_NAMES = new Set([
  '.env.local',
  '.env.development.local',
  '.env.production.local',
]);
const PROJECT_EXCLUDED_FILE_SUFFIXES = [
  '.sqlite',
  '.sqlite-shm',
  '.sqlite-wal',
  '.db',
  '.db-shm',
  '.db-wal',
  '.log',
];

function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const result = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token || !token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function ensureBuildArtifact(buildArtifactPath) {
  if (fs.existsSync(buildArtifactPath)) {
    return;
  }

  console.log(`[opensandbox] Missing ${path.relative(ROOT_DIR, buildArtifactPath)}. Running npm run build...`);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  runCommand(npmCommand, ['run', 'build'], { cwd: ROOT_DIR });

  if (!fs.existsSync(buildArtifactPath)) {
    throw new Error(`Build completed but artifact is still missing: ${buildArtifactPath}`);
  }
}

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized ? normalized : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function resolveWslPath(windowsPath, distro) {
  const result = spawnSync('wsl.exe', ['-d', distro, '-e', 'wslpath', '-a', windowsPath], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(`Failed to run wslpath: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`wslpath failed (status ${result.status}): ${stderr || 'unknown error'}`);
  }

  return String(result.stdout || '').trim();
}

function buildDockerArgs(config) {
  const args = ['build', '-t', config.tag];

  if (config.baseImage) {
    args.push('--build-arg', `BASE_IMAGE=${config.baseImage}`);
  }

  if (config.runtimeDir) {
    args.push('--build-arg', `PREBAKED_RUNTIME_DIR=${config.runtimeDir}`);
  }

  if (config.includeProject && config.projectDir) {
    args.push('--build-arg', `PREBAKED_PROJECT_DIR=${config.projectDir}`);
  }

  if (config.piVersion) {
    args.push('--build-arg', `PI_CODING_AGENT_VERSION=${config.piVersion}`);
  }

  return args;
}

function writeRuntimeDockerfile(dockerfilePath, config) {
  const lines = [
    `ARG BASE_IMAGE=${DEFAULT_BASE_IMAGE}`,
    'FROM ${BASE_IMAGE}',
    `ARG PREBAKED_RUNTIME_DIR=${DEFAULT_RUNTIME_DIR}`,
    `ARG PREBAKED_PROJECT_DIR=${DEFAULT_PROJECT_DIR}`,
    'ARG PI_CODING_AGENT_VERSION=latest',
    'RUN mkdir -p "${PREBAKED_RUNTIME_DIR}"',
    'COPY open-sandbox-runner.js "${PREBAKED_RUNTIME_DIR}/open-sandbox-runner.js"',
    'COPY agent-chat-tools.js "${PREBAKED_RUNTIME_DIR}/agent-chat-tools.js"',
    'RUN npm --prefix "${PREBAKED_RUNTIME_DIR}" install --omit=dev --no-audit --no-fund "@mariozechner/pi-coding-agent@${PI_CODING_AGENT_VERSION}" \\',
    '  && ln -s "${PREBAKED_RUNTIME_DIR}/node_modules/@mariozechner/pi-coding-agent" "${PREBAKED_RUNTIME_DIR}/pi-coding-agent"',
  ];

  if (config.includeProject) {
    lines.push(
      'COPY project/ "${PREBAKED_PROJECT_DIR}/"',
      'WORKDIR "${PREBAKED_PROJECT_DIR}"',
      'RUN npm ci --no-audit --no-fund && npm run build',
      'WORKDIR /'
    );
  }

  fs.writeFileSync(dockerfilePath, `${lines.join('\n')}\n`, 'utf8');
}

function shouldCopyProjectSource(sourcePath, options = {}) {
  const includeGitMetadata = options.includeGitMetadata === true;
  const relativePath = path.relative(ROOT_DIR, sourcePath).replace(/\\/g, '/');
  if (!relativePath) {
    return true;
  }
  if (relativePath.startsWith('../') || relativePath === '..') {
    return false;
  }

  const segments = relativePath.split('/');
  const topLevelDir = segments[0];
  if (PROJECT_EXCLUDED_TOP_LEVEL_DIRS.has(topLevelDir)) {
    return false;
  }
  if (topLevelDir === '.git' && !includeGitMetadata) {
    return false;
  }

  const fileName = segments[segments.length - 1];
  if (PROJECT_EXCLUDED_FILE_NAMES.has(fileName)) {
    return false;
  }
  if (/^\.env\./u.test(fileName) && fileName !== '.env.example') {
    return false;
  }

  let stat = null;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) {
    return false;
  }
  if (stat.isDirectory()) {
    return true;
  }

  const lowerFileName = fileName.toLowerCase();
  return !PROJECT_EXCLUDED_FILE_SUFFIXES.some((suffix) => lowerFileName.endsWith(suffix));
}

function copyProjectSourceToContext(contextDir, options = {}) {
  const targetDir = path.join(contextDir, 'project');
  console.log(
    `[opensandbox] Copying CAFF source into Docker build context${options.includeGitMetadata ? ' (with .git metadata)' : ''}...`
  );
  fs.cpSync(ROOT_DIR, targetDir, {
    recursive: true,
    dereference: false,
    filter(sourcePath) {
      return shouldCopyProjectSource(sourcePath, options);
    },
  });
  return targetDir;
}

function buildRuntimeImage(config) {
  const runnerPath = path.resolve(ROOT_DIR, 'server', 'domain', 'skill-test', 'open-sandbox-runner.js');
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`Missing sandbox runner asset: ${runnerPath}`);
  }

  const chatToolsPath = path.resolve(ROOT_DIR, 'build', 'lib', 'agent-chat-tools.js');
  ensureBuildArtifact(chatToolsPath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-opensandbox-runtime-'));
  const dockerfilePath = path.join(tempDir, 'Dockerfile');

  fs.copyFileSync(runnerPath, path.join(tempDir, 'open-sandbox-runner.js'));
  fs.copyFileSync(chatToolsPath, path.join(tempDir, 'agent-chat-tools.js'));
  if (config.includeProject) {
    copyProjectSourceToContext(tempDir, {
      includeGitMetadata: config.includeGitMetadata,
    });
  }
  writeRuntimeDockerfile(dockerfilePath, config);

  let buildSucceeded = false;

  try {
    if (process.platform === 'win32') {
      const wslDistro = normalizeText(config.wslDistro, DEFAULT_WSL_DISTRO);
      const wslTempDir = resolveWslPath(tempDir, wslDistro);
      const dockerArgs = buildDockerArgs(config);
      runCommand('wsl.exe', ['-d', wslDistro, '-u', 'root', '-e', 'docker', ...dockerArgs, wslTempDir]);
    } else {
      const dockerArgs = buildDockerArgs(config);
      runCommand('docker', [...dockerArgs, tempDir]);
    }

    buildSucceeded = true;
  } finally {
    if (buildSucceeded) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.error(`[opensandbox] Build context kept for debugging: ${tempDir}`);
    }
  }
}

const flags = parseArgs(process.argv);
const includeProject = normalizeBoolean(flags['include-project'], false);
const tag = normalizeText(flags.tag, includeProject ? DEFAULT_CAFF_IMAGE_TAG : DEFAULT_RUNTIME_IMAGE_TAG);
const baseImage = normalizeText(flags['base-image'], DEFAULT_BASE_IMAGE);
const runtimeDir = normalizeText(flags['runtime-dir'], DEFAULT_RUNTIME_DIR);
const projectDir = normalizeText(flags['project-dir'], DEFAULT_PROJECT_DIR);
const piVersion = normalizeText(flags['pi-version'], 'latest');
const wslDistro = normalizeText(flags['wsl-distro'], DEFAULT_WSL_DISTRO);
const includeGitMetadata = includeProject
  ? normalizeBoolean(flags['include-git'], true)
  : normalizeBoolean(flags['include-git'], false);

buildRuntimeImage({
  tag,
  baseImage,
  runtimeDir,
  projectDir,
  piVersion,
  wslDistro,
  includeProject,
  includeGitMetadata,
});

console.log(`\n[opensandbox] ${includeProject ? 'CAFF source image' : 'Runtime image'} built successfully.`);
console.log(`  image: ${tag}`);
console.log(`  runtime dir: ${runtimeDir}`);
if (includeProject) {
  console.log(`  project dir: ${projectDir}`);
  console.log(`  git metadata: ${includeGitMetadata ? 'included' : 'excluded'}`);
}
console.log('\n[opensandbox] Next: set the following in .env.local (then restart CAFF):');
console.log(`  CAFF_SKILL_TEST_OPENSANDBOX_IMAGE=${tag}`);
console.log(`  CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_RUNTIME_DIR=${runtimeDir}`);
if (includeProject) {
  console.log(`  CAFF_SKILL_TEST_OPENSANDBOX_PREBAKED_PROJECT_DIR=${projectDir}`);
}
