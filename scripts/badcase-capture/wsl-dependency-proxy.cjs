// Trusted Windows-only installer relay. Inspect the explicitly selected WSL
// NAT route without a shell/profile, then bind only a Windows-owned private IP.
// No account/WSL environment discovery, model request or direct fallback.
const cp = require('node:child_process'), os = require('node:os'), net = require('node:net');
const { validateWslDockerBackend, wslLaunchEnvironment } = require('./wsl-docker.cjs');
const { withDependencyProxy } = require('./dependency-proxy.cjs');
const fail = code => Object.assign(Error(code), { code });
function inspectWslDependencyGateway(backend, options = {}) {
  const selected = validateWslDockerBackend(backend);
  if ((options.platform ?? process.platform) !== 'win32') throw fail('evaluation_wsl_host_required');
  try {
    const text = (options.execFileSync || cp.execFileSync)('wsl.exe', ['--distribution', selected.distribution, '--exec', '/usr/bin/env', '-i',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/nonexistent', 'ip', '-4', 'route', 'show', 'default'],
    { env: wslLaunchEnvironment(options.env), shell: false, windowsHide: true, timeout: 15000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const match = /^default via ([0-9.]+) dev [A-Za-z0-9_.-]+(?: [A-Za-z0-9./ -]+)?$/.exec(text.trim());
    const address = match?.[1], octets = address?.split('.').map(Number);
    if (!net.isIPv4(address || '') || !(octets[0] === 10 || octets[0] === 192 && octets[1] === 168
      || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)) throw Error();
    const owned = Object.values((options.networkInterfaces || os.networkInterfaces)()).flat().some(item =>
      item?.family === 'IPv4' && item.address === address && item.internal === false);
    if (!owned) throw Error();
    return address;
  } catch { throw fail('evaluation_dependency_proxy_unavailable'); }
}
async function withWslDependencyProxy(backend, work, options = {}) {
  const gateway = inspectWslDependencyGateway(backend, options);
  return (options.withDependencyProxy || withDependencyProxy)(gateway, work);
}
module.exports = { inspectWslDependencyGateway, withWslDependencyProxy };
