// Supported Windows classification environment only. Never discover/read a
// global/system config, interpret injected Git settings, or change the host's
// configuration to make a capture pass. An existing differently configured
// runtime is unsupported; the operator must choose its environment explicitly.
export function supportsWindowsGitEnvironment(env: any = process.env): boolean {
  if (!env || typeof env !== 'object') return false;
  // Git for Windows treats NUL as the empty device. Require explicit disabling
  // of both ambient layers, not an absent path that could appear later.
  if (env.GIT_CONFIG_NOSYSTEM !== '1' || env.GIT_CONFIG_GLOBAL !== 'NUL') return false;
  return Object.keys(env).every(name => !name.toUpperCase().startsWith('GIT_')
    || ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_BASH_PATH'].includes(name));
}
