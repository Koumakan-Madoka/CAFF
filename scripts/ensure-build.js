const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = process.cwd();
const serverEntrypoint = path.resolve(ROOT_DIR, 'build', 'lib', 'app-server.js');

if (fs.existsSync(serverEntrypoint)) {
  process.exit(0);
}

const relativeEntrypoint = path.relative(ROOT_DIR, serverEntrypoint) || serverEntrypoint;
console.log(`[prestart] Missing ${relativeEntrypoint}. Running npm run build...`);

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

if (!fs.existsSync(serverEntrypoint)) {
  console.error(`[prestart] Build completed but ${relativeEntrypoint} is still missing.`);
  process.exit(1);
}

