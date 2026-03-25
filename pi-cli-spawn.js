const fs = require('node:fs');
const path = require('node:path');

const PI_CLI_RELATIVE_PATH = path.join('node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js');

function tryCreateDirectPiNodeSpawnSpec(piCommandPath, piArgs) {
  const normalizedPath = String(piCommandPath || '').trim();

  if (!normalizedPath || !path.isAbsolute(normalizedPath)) {
    return null;
  }

  const shimDir = path.dirname(normalizedPath);
  const cliPath = path.join(shimDir, PI_CLI_RELATIVE_PATH);

  if (!fs.existsSync(cliPath)) {
    return null;
  }

  const bundledNodePath = path.join(shimDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const command = fs.existsSync(bundledNodePath) ? bundledNodePath : process.execPath;

  return {
    command,
    args: [cliPath, ...piArgs],
  };
}

module.exports = {
  tryCreateDirectPiNodeSpawnSpec,
};
