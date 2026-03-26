const { spawn } = require('node:child_process');

function canSpawnProcess() {
  try {
    const child = spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    try {
      child.kill();
    } catch {}

    return true;
  } catch (error) {
    return !(error && error.code === 'EPERM');
  }
}

function shouldRequireSpawn() {
  const value = process.env.CAFF_REQUIRE_SPAWN;
  return value && value !== '0' && String(value).toLowerCase() !== 'false';
}

const SPAWN_AVAILABLE = canSpawnProcess();

function requireSpawn(t, message = 'child_process.spawn is not permitted in this environment') {
  if (SPAWN_AVAILABLE) {
    return true;
  }

  if (shouldRequireSpawn()) {
    throw new Error(message);
  }

  t.skip(message);
  return false;
}

module.exports = { SPAWN_AVAILABLE, requireSpawn };

