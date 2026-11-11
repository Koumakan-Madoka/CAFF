// Short-lived TCP forwarder for the installer: Docker bridge -> the approved
// host loopback proxy only. No logging, request interpretation or direct fallback.
const net = require('node:net'), { host, port } = require('./host-proxy.cjs');
async function withDependencyProxy(gateway, work, { connect = () => net.connect({ host, port }) } = {}) {
  if (!net.isIPv4(gateway) || gateway === '0.0.0.0' || gateway.startsWith('127.')) throw Error('evaluation_dependency_proxy_invalid');
  const sockets = new Set();
  const relay = net.createServer(incoming => {
    if (sockets.size >= 64) { incoming.destroy(); return; }
    let outgoing;
    try { outgoing = connect(); } catch { incoming.destroy(); return; }
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket); socket.setTimeout(120000);
      socket.on('timeout', () => { incoming.destroy(); outgoing.destroy(); });
      socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
      socket.on('close', () => sockets.delete(socket));
    }
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  try {
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, gateway, resolve); });
    return await work('http://' + gateway + ':' + relay.address().port);
  } finally {
    for (const s of sockets) s.destroy();
    if (relay.listening) await new Promise(resolve => relay.close(resolve));
  }
}
module.exports = { withDependencyProxy };
