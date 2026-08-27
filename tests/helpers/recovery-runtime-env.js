const RECOVERY_RUNTIME_ENV_KEYS = Object.freeze([
  'CAFF_RECOVERY_ENABLED',
  'CAFF_RECOVERY_PROVIDER',
  'CAFF_RECOVERY_MODEL',
  'CAFF_RECOVERY_THINKING',
  'CAFF_RECOVERY_TIMEOUT_MS',
  'CAFF_DIGEST_PROVIDER',
  'CAFF_DIGEST_MODEL',
  'CAFF_DIGEST_THINKING',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_THINKING',
]);

function withClearedRecoveryRuntimeEnvironment(callback, env = process.env) {
  const previous = new Map();
  for (const key of RECOVERY_RUNTIME_ENV_KEYS) {
    previous.set(key, {
      present: Object.prototype.hasOwnProperty.call(env, key),
      value: env[key],
    });
    delete env[key];
  }

  try {
    return callback();
  } finally {
    for (const [key, entry] of previous) {
      if (entry.present) {
        env[key] = entry.value;
      } else {
        delete env[key];
      }
    }
  }
}

module.exports = {
  RECOVERY_RUNTIME_ENV_KEYS,
  withClearedRecoveryRuntimeEnvironment,
};
