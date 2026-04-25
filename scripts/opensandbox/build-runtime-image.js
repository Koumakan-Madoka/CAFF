const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
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

function stableStringify(value) {
  if (value == null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    return JSON.stringify(String(value));
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashJsonValue(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function readJsonFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || '').trim());
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`JSON file does not exist: ${resolvedPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`JSON file must contain an object: ${resolvedPath}`);
  }
  return { path: resolvedPath, data: parsed };
}

function sanitizeImageSegment(value, fallback = 'env') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

function normalizePackageToken(value) {
  const normalized = String(value || '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9+._:@/-]*$/u.test(normalized) ? normalized : '';
}

function normalizePackageList(value) {
  const rawList = Array.isArray(value) ? value : [value];
  const result = [];
  for (const entry of rawList) {
    const normalized = normalizePackageToken(entry);
    if (normalized) {
      result.push(normalized);
    }
  }
  return [...new Set(result)];
}

function dockerfileLabelValue(value) {
  return JSON.stringify(String(value || '').trim());
}

function shellLine(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeEnvironmentManifest(input) {
  const manifest = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const skillId = normalizeText(manifest.skillId || manifest.skill_id, 'skill');
  const envProfile = normalizeText(manifest.envProfile || manifest.env_profile || manifest.profile, 'default');
  const baseImage = normalizePackageToken(manifest.baseImage || manifest.base_image || manifest.baseImageRef || manifest.base_image_ref) || DEFAULT_BASE_IMAGE;
  const installSteps = Array.isArray(manifest.installSteps)
    ? manifest.installSteps
    : Array.isArray(manifest.install_steps)
      ? manifest.install_steps
      : [];
  const verifyCommands = Array.isArray(manifest.verifyCommands)
    ? manifest.verifyCommands
    : manifest.verify && Array.isArray(manifest.verify.commands)
      ? manifest.verify.commands
      : [];

  const aptPackages = [];
  const pipPackages = [];
  const commandSteps = [];

  for (const step of installSteps) {
    if (!step || typeof step !== 'object') {
      continue;
    }
    const type = normalizeText(step.type || step.kind).toLowerCase();
    if (type === 'apt' || type === 'apt-get' || type === 'debian-package') {
      const names = normalizePackageList(step.packages || step.package || step.name);
      const version = normalizePackageToken(step.version);
      for (const name of names) {
        aptPackages.push(version ? `${name}=${version}` : name);
      }
      continue;
    }
    if (type === 'pip' || type === 'python-package') {
      const names = normalizePackageList(step.packages || step.package || step.name);
      const version = normalizePackageToken(step.version);
      for (const name of names) {
        pipPackages.push(version ? `${name}==${version}` : name);
      }
      continue;
    }
    if (type === 'command' || type === 'shell') {
      const command = shellLine(step.command || step.run);
      if (command) {
        commandSteps.push(command);
      }
    }
  }

  return {
    raw: manifest,
    skillId,
    envProfile,
    baseImage,
    baseImageDigest: normalizeText(manifest.baseImageDigest || manifest.base_image_digest),
    testingMdHash: normalizeText(manifest.testingMdHash || manifest.testing_md_hash),
    buildCaseId: normalizeText(manifest.buildCaseId || manifest.build_case_id),
    manifestHash: normalizeText(manifest.manifestHash || manifest.manifest_hash) || hashJsonValue(manifest),
    image: normalizeText(manifest.image || manifest.imageRef || manifest.image_ref),
    imageDigest: normalizeText(manifest.imageDigest || manifest.image_digest),
    aptPackages: [...new Set(aptPackages.filter(Boolean))],
    pipPackages: [...new Set(pipPackages.filter(Boolean))],
    commandSteps,
    verifyCommands: verifyCommands.map((entry) => shellLine(entry)).filter(Boolean),
  };
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
    'ENV PIP_BREAK_SYSTEM_PACKAGES=1 \\',
    '    PIP_DISABLE_PIP_VERSION_CHECK=1',
    'RUN apt-get update \\',
    '  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv python-is-python3 \\',
    '  && rm -rf /var/lib/apt/lists/* \\',
    '  && python --version \\',
    '  && python -m pip --version',
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

function writeEnvironmentDockerfile(dockerfilePath, config) {
  const manifest = normalizeEnvironmentManifest(config.manifest);
  const lines = [
    `ARG BASE_IMAGE=${manifest.baseImage}`,
    'FROM ${BASE_IMAGE}',
    `LABEL caff.skill-test.environment.skill-id=${dockerfileLabelValue(manifest.skillId)}`,
    `LABEL caff.skill-test.environment.profile=${dockerfileLabelValue(manifest.envProfile)}`,
    `LABEL caff.skill-test.environment.manifest-hash=${dockerfileLabelValue(manifest.manifestHash)}`,
    `LABEL caff.skill-test.environment.testing-md-hash=${dockerfileLabelValue(manifest.testingMdHash)}`,
    `LABEL caff.skill-test.environment.build-case-id=${dockerfileLabelValue(manifest.buildCaseId)}`,
    'ENV PIP_BREAK_SYSTEM_PACKAGES=1 \\',
    '    PIP_DISABLE_PIP_VERSION_CHECK=1',
  ];

  if (manifest.aptPackages.length > 0) {
    lines.push(
      'RUN apt-get update \\',
      `  && apt-get install -y --no-install-recommends ${manifest.aptPackages.join(' ')} \\`,
      '  && rm -rf /var/lib/apt/lists/*'
    );
  }

  if (manifest.pipPackages.length > 0) {
    lines.push(
      `RUN python -m pip install --no-cache-dir ${manifest.pipPackages.join(' ')}`
    );
  }

  for (const command of manifest.commandSteps) {
    lines.push(`RUN ${command}`);
  }

  for (const command of manifest.verifyCommands) {
    lines.push(`RUN ${command}`);
  }

  fs.writeFileSync(dockerfilePath, `${lines.join('\n')}\n`, 'utf8');
  return manifest;
}

function resolveEnvironmentImageTag(manifest, explicitTag = '') {
  const normalizedTag = normalizeText(explicitTag);
  if (normalizedTag) {
    return normalizedTag;
  }
  if (manifest.image) {
    return manifest.image;
  }
  const skillId = sanitizeImageSegment(manifest.skillId, 'skill');
  const envProfile = sanitizeImageSegment(manifest.envProfile, 'default');
  return `caff-skill-env-${skillId}:${envProfile}-${manifest.manifestHash.slice(0, 12)}`;
}

function buildEnvironmentImage(config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-opensandbox-env-'));
  const dockerfilePath = path.join(tempDir, 'Dockerfile');
  const manifest = writeEnvironmentDockerfile(dockerfilePath, config);
  const tag = resolveEnvironmentImageTag(manifest, config.tag);
  const dockerArgs = ['build', '-t', tag];

  let buildSucceeded = false;

  try {
    if (process.platform === 'win32') {
      const wslDistro = normalizeText(config.wslDistro, DEFAULT_WSL_DISTRO);
      const wslTempDir = resolveWslPath(tempDir, wslDistro);
      runCommand('wsl.exe', ['-d', wslDistro, '-u', 'root', '-e', 'docker', ...dockerArgs, wslTempDir]);
    } else {
      runCommand('docker', [...dockerArgs, tempDir]);
    }

    buildSucceeded = true;
    return { tag, manifest, dockerfilePath };
  } finally {
    if (buildSucceeded) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } else {
      console.error(`[opensandbox] Environment build context kept for debugging: ${tempDir}`);
    }
  }
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
const environmentManifestPath = normalizeText(flags['environment-manifest'] || flags['env-manifest']);
const wslDistro = normalizeText(flags['wsl-distro'], DEFAULT_WSL_DISTRO);

if (environmentManifestPath) {
  const manifestFile = readJsonFile(environmentManifestPath);
  const environmentBuild = buildEnvironmentImage({
    manifest: manifestFile.data,
    tag: normalizeText(flags.tag),
    wslDistro,
  });

  console.log('\n[opensandbox] Skill environment image built successfully.');
  console.log(`  manifest: ${manifestFile.path}`);
  console.log(`  skill: ${environmentBuild.manifest.skillId}`);
  console.log(`  profile: ${environmentBuild.manifest.envProfile}`);
  console.log(`  image: ${environmentBuild.tag}`);
  console.log(`  manifest hash: ${environmentBuild.manifest.manifestHash}`);
  if (environmentBuild.manifest.testingMdHash) {
    console.log(`  TESTING.md hash: ${environmentBuild.manifest.testingMdHash}`);
  }
  console.log('\n[opensandbox] Bind ordinary execution cases to this image via environmentConfig.asset; do not use docker commit as the shared source of truth.');
  process.exit(0);
}

const includeProject = normalizeBoolean(flags['include-project'], false);
const tag = normalizeText(flags.tag, includeProject ? DEFAULT_CAFF_IMAGE_TAG : DEFAULT_RUNTIME_IMAGE_TAG);
const baseImage = normalizeText(flags['base-image'], DEFAULT_BASE_IMAGE);
const runtimeDir = normalizeText(flags['runtime-dir'], DEFAULT_RUNTIME_DIR);
const projectDir = normalizeText(flags['project-dir'], DEFAULT_PROJECT_DIR);
const piVersion = normalizeText(flags['pi-version'], 'latest');
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
console.log('  python toolchain: python3 + pip + venv');
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
