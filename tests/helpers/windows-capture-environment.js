// Explicit environment for self-owned Windows fixture runtimes only. Never
// imported by production code. Restore every Git variable after this test;
// do not rewrite a user's files/config or silently configure a real instance.
function isolateWindowsCaptureEnvironment(t) {
  if (process.platform !== 'win32') return;
  const gitKeys = () => Object.keys(process.env).filter(key => key.toUpperCase().startsWith('GIT_'));
  const previous = Object.fromEntries(gitKeys().map(key => [key, process.env[key]]));
  for (const key of gitKeys()) delete process.env[key];
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = 'NUL';
  t.after(() => {
    for (const key of gitKeys()) delete process.env[key];
    Object.assign(process.env, previous);
  });
}
module.exports = { isolateWindowsCaptureEnvironment };
