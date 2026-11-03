// Capture helpers parse independently authorized Git metadata; they do not run
// git or consume ambient Git config. Keep any Git selectors/config overrides
// out of THEIR child environment without changing the service/agent runtime.
// This is configuration isolation, not a general subprocess/secret sandbox.
export function createWindowsCaptureEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.toUpperCase().startsWith('GIT_')) child[name] = value;
  }
  // Git for Windows treats NUL as the empty device. No global/system file is
  // read if a future trusted helper needs a Git child; no host file is changed.
  return { ...child, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' };
}
