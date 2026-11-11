// Trusted host proxy, shared by model egress and credential-free npm installs.
// Fixed policy: no environment override, discovery or direct fallback.
const host = '127.0.0.1', port = 10090;
module.exports = Object.freeze({ host, port, url: 'http://' + host + ':' + port });
