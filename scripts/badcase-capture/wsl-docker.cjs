// Explicit trusted Windows-host Docker transport. Only checked material and
// mailbox bytes cross stdin; account access and provider networking stay here.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const fail = code => Object.assign(Error(code), { code });
function validateWslDockerBackend(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'distribution,kind' || value.kind !== 'windows-wsl-v1'
    || typeof value.distribution !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.distribution)) throw fail('evaluation_wsl_backend_invalid');
  return { kind: value.kind, distribution: value.distribution };
}
function wslLaunchEnvironment(inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) if (typeof value === 'string'
    && /^(?:PATH|SYSTEMROOT|WINDIR|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)$/i.test(key)) env[key] = value;
  return env;
}
function createWslDockerRunner(backend, options = {}) {
  const selected = validateWslDockerBackend(backend);
  if ((options.platform ?? process.platform) !== 'win32') throw fail('evaluation_wsl_host_required');
  const env = wslLaunchEnvironment(options.env), launch = options.spawn || spawn;
  // --exec bypasses all shells/profiles; env -i also removes distro-side env.
  // Explicit empty HOME/config prevent ambient Docker contexts/config/creds.
  const prefix = ['--distribution', selected.distribution, '--exec', '/usr/bin/env', '-i',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/nonexistent',
    'DOCKER_CONFIG=/nonexistent/caff-evaluation-docker', 'docker', '--context', 'default'];
  return async (args, settings = {}) => {
    if (settings.key !== undefined) throw fail('evaluation_wsl_credentials_forbidden');
    const maxOutput = settings.maxOutput ?? 1048576, timeoutMs = settings.timeoutMs ?? 15000;
    if (!Array.isArray(args) || args.some(s => typeof s !== 'string' || s.includes('\0'))
      || !Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > 8388736
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2705000
      || settings.outputFile !== undefined && !path.isAbsolute(settings.outputFile)
      || settings.inputFile !== undefined && (!path.isAbsolute(settings.inputFile) || settings.input !== undefined)) throw fail('evaluation_wsl_transport_invalid');
    return new Promise((resolve, reject) => {
      const output = { stdout: [], stderr: [] }; let size = 0, failure = '', done = false, inputStream, outputFd;
      try { if (settings.outputFile) outputFd = fs.openSync(settings.outputFile, 'wx', 0o600); } catch (e) { reject(e); return; }
      let child;
      try { child = launch('wsl.exe', [...prefix, ...args], { env: { ...env }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { if (outputFd !== undefined) fs.closeSync(outputFd); resolve({ code: null, stdout: '', stderr: '', failure: 'spawn' }); return; }
      const stop = reason => { failure ||= reason; child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
        if (name === 'stdout' && outputFd !== undefined) { try { fs.writeSync(outputFd, bytes); } catch { stop('artifact_write'); } return; }
        size += bytes.length; if (size > maxOutput) { stop('output_limit'); return; } output[name].push(bytes);
      });
      child.on('error', () => { failure ||= 'spawn'; });
      child.on('close', code => {
        if (done) return; done = true; clearTimeout(timer); inputStream?.destroy(); if (outputFd !== undefined) fs.closeSync(outputFd);
        resolve({ code, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), ...(failure ? { failure } : {}) });
      });
      child.stdin.on('error', () => {});
      if (settings.inputFile) { inputStream = fs.createReadStream(settings.inputFile); inputStream.on('error', () => stop('input')); inputStream.pipe(child.stdin); }
      else child.stdin.end(settings.input || '');
    });
  };
}
module.exports = { validateWslDockerBackend, createWslDockerRunner, wslLaunchEnvironment };
