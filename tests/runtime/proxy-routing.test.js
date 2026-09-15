const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PROXY_ROUTING_MODULE = path.join(ROOT_DIR, 'lib', 'proxy-routing.mjs');
const PI_SDK_HOST_MODULE = path.join(ROOT_DIR, 'lib', 'pi-sdk-host.mjs');
const SDK_ENTRY_PATH = path.join(
  ROOT_DIR, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'
);

async function loadProxyRoutingModule() {
  return import(`${pathToFileURL(PROXY_ROUTING_MODULE).href}?test=${Date.now()}-${Math.random()}`);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function startHitCountingProxy() {
  return new Promise(async (resolve, reject) => {
    const hits = { count: 0 };
    const proxy = net.createServer((socket) => {
      hits.count += 1;
      socket.destroy();
    });
    proxy.once('error', reject);
    await new Promise((listenResolve) => proxy.listen(0, '127.0.0.1', listenResolve));
    resolve({ proxy, hits, port: proxy.address().port });
  });
}

function startHitCountingDirectServer() {
  return new Promise(async (resolve, reject) => {
    const hits = { count: 0 };
    const server = http.createServer((req, res) => {
      hits.count += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('direct');
    });
    server.once('error', reject);
    await new Promise((listenResolve) => server.listen(0, '127.0.0.1', listenResolve));
    resolve({ server, hits, port: server.address().port });
  });
}

function runChildScript(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

test('parseProxyOnlyHosts normalizes entries like undici NO_PROXY', async () => {
  const { parseProxyOnlyHosts } = await loadProxyRoutingModule();

  assert.deepEqual(parseProxyOnlyHosts(''), []);
  assert.deepEqual(parseProxyOnlyHosts(undefined), []);
  assert.deepEqual(parseProxyOnlyHosts('  , , '), []);

  assert.deepEqual(parseProxyOnlyHosts('foo.com'), [{ hostname: 'foo.com', port: 0 }]);
  assert.deepEqual(parseProxyOnlyHosts('a.com,b.com'), [
    { hostname: 'a.com', port: 0 },
    { hostname: 'b.com', port: 0 },
  ]);
  assert.deepEqual(parseProxyOnlyHosts('a.com b.com'), [
    { hostname: 'a.com', port: 0 },
    { hostname: 'b.com', port: 0 },
  ]);
  // Leading dot / wildcard-dot forms are stripped to the bare domain.
  assert.deepEqual(parseProxyOnlyHosts('.foo.com'), [{ hostname: 'foo.com', port: 0 }]);
  assert.deepEqual(parseProxyOnlyHosts('*.foo.com'), [{ hostname: 'foo.com', port: 0 }]);
  // Port suffix is captured, casing is normalized.
  assert.deepEqual(parseProxyOnlyHosts('FOO.com:8443'), [{ hostname: 'foo.com', port: 8443 }]);
});

test('matchesProxyOnlyHost covers self and subdomains only', async () => {
  const { parseProxyOnlyHosts, matchesProxyOnlyHost } = await loadProxyRoutingModule();
  const entries = parseProxyOnlyHosts('foo.com,bar.org:8443');

  assert.equal(matchesProxyOnlyHost('foo.com', entries), true);
  assert.equal(matchesProxyOnlyHost('a.foo.com', entries), true);
  assert.equal(matchesProxyOnlyHost('deep.a.foo.com', entries), true);
  // Not a subdomain: sibling prefix, parent, or unrelated host.
  assert.equal(matchesProxyOnlyHost('xfoo.com', entries), false);
  assert.equal(matchesProxyOnlyHost('com', entries), false);
  assert.equal(matchesProxyOnlyHost('foo.com.evil.net', entries), false);
  assert.equal(matchesProxyOnlyHost('baz.com', entries), false);
  assert.equal(matchesProxyOnlyHost('', entries), false);

  // Port-specific entries match only that port.
  assert.equal(matchesProxyOnlyHost('bar.org', entries, 8443), true);
  assert.equal(matchesProxyOnlyHost('bar.org', entries, 443), false);
  assert.equal(matchesProxyOnlyHost('sub.bar.org', entries, 8443), true);

  // Case-insensitive hostnames.
  assert.equal(matchesProxyOnlyHost('A.FOO.COM', entries), true);
});

test('extractOriginHost keeps IPv6 brackets and resolves default ports', async () => {
  const { extractOriginHost } = await loadProxyRoutingModule();

  assert.deepEqual(extractOriginHost('https://a.foo.com/'), {
    protocol: 'https:',
    hostname: 'a.foo.com',
    port: 443,
  });
  assert.deepEqual(extractOriginHost('http://a.foo.com:8080/x'), {
    protocol: 'http:',
    hostname: 'a.foo.com',
    port: 8080,
  });
  assert.deepEqual(extractOriginHost(new URL('http://[::1]:9000/x')), {
    protocol: 'http:',
    hostname: '[::1]',
    port: 9000,
  });
  assert.equal(extractOriginHost('not a url'), null);
});

test('installProxyOnlyRoutingDispatcher is inert when unconfigured or missing a proxy URL', async () => {
  const { installProxyOnlyRoutingDispatcher } = await loadProxyRoutingModule();

  // No PROXY_ONLY_HOSTS: fully disabled, no global mutation.
  const disabled = installProxyOnlyRoutingDispatcher({
    env: { HTTPS_PROXY: 'http://127.0.0.1:1' },
  });
  assert.equal(disabled.installed, false);
  assert.equal(disabled.reason, 'disabled');

  // PROXY_ONLY_HOSTS set but no proxy URL: refused with an actionable reason.
  const noProxy = installProxyOnlyRoutingDispatcher({
    env: { PROXY_ONLY_HOSTS: 'foo.com' },
  });
  assert.equal(noProxy.installed, false);
  assert.equal(noProxy.reason, 'no_proxy_url');

  // Whitespace-only value behaves like unset.
  const blank = installProxyOnlyRoutingDispatcher({
    env: { PROXY_ONLY_HOSTS: '  ', HTTP_PROXY: 'http://127.0.0.1:1' },
  });
  assert.equal(blank.installed, false);
  assert.equal(blank.reason, 'disabled');
});

test('routing dispatcher sends whitelisted hosts to the proxy and everything else direct', async () => {
  const proxy = await startHitCountingProxy();
  const direct = await startHitCountingDirectServer();

  const childScript = `
    const { createRequire } = await import('node:module');
    const req = createRequire(process.argv[1]);
    req('undici'); // SDK undici graph load clobbers the legacy global dispatcher symbol

    const module = await import(process.argv[2]);
    const result = module.installProxyOnlyRoutingDispatcher();
    if (!result.installed) {
      console.log(JSON.stringify({ phase: 'error', message: 'install failed', result }));
      process.exit(3);
    }

    const proxied = await fetch('http://proxied.example/some/path', { redirect: 'manual' }).catch(() => 'failed');
    const directResponse = await fetch('http://127.0.0.1:' + process.argv[3] + '/').catch(() => null);
    console.log(JSON.stringify({
      phase: 'done',
      proxiedOutcome: typeof proxied === 'string' ? proxied : proxied.status,
      directStatus: directResponse ? directResponse.status : 'failed',
    }));
  `;

  try {
    const { code, stdout, stderr } = await runChildScript(
      childScript,
      [SDK_ENTRY_PATH, pathToFileURL(PROXY_ROUTING_MODULE).href, String(direct.port)],
      {
        PROXY_ONLY_HOSTS: 'proxied.example',
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: '',
      }
    );

    assert.equal(code, 0, `child exited with ${code}: ${stdout}\nstderr: ${stderr}`);
    const done = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.phase === 'done');
    assert.ok(done, `child did not reach done phase: ${stdout}`);
    // The whitelisted host must have gone through the proxy exactly once
    // (the proxy destroys the socket, so the fetch itself fails — expected).
    assert.equal(proxy.hits.count, 1, `expected exactly one proxy hit, got ${proxy.hits.count}`);
    assert.equal(done.proxiedOutcome, 'failed');
    // The non-whitelisted local request must have gone direct and succeeded.
    assert.equal(done.directStatus, 200);
    assert.equal(direct.hits.count, 1, `expected exactly one direct hit, got ${direct.hits.count}`);
  } finally {
    proxy.proxy.close();
    direct.server.close();
  }
});

test('PROXY_ONLY_HOSTS defers the env-proxy repair in the SDK host', async () => {
  const proxy = await startHitCountingProxy();
  const direct = await startHitCountingDirectServer();

  const childScript = `
    const { createRequire } = await import('node:module');
    const req = createRequire(process.argv[1]);
    req('undici'); // SDK undici graph load clobbers the legacy global dispatcher symbol

    const host = await import(process.argv[2]);
    host.repairEnvProxyGlobalDispatcher();
    // If the repair had installed an EnvHttpProxyAgent (full proxy routing),
    // this probe would go through the proxy; deferred, it fails fast on
    // direct DNS and never reaches the proxy.
    await fetch('http://defer-probe.example/', { redirect: 'manual' }).catch(() => {});

    const module = await import(process.argv[3]);
    const result = module.installProxyOnlyRoutingDispatcher();
    const proxied = await fetch('http://proxied.example/', { redirect: 'manual' }).catch(() => 'failed');
    const directResponse = await fetch('http://127.0.0.1:' + process.argv[4] + '/').catch(() => null);
    console.log(JSON.stringify({
      phase: 'done',
      installed: result.installed,
      proxiedOutcome: typeof proxied === 'string' ? proxied : proxied.status,
      directStatus: directResponse ? directResponse.status : 'failed',
    }));
  `;

  try {
    const { code, stdout, stderr } = await runChildScript(
      childScript,
      [
        SDK_ENTRY_PATH,
        pathToFileURL(PI_SDK_HOST_MODULE).href,
        pathToFileURL(PROXY_ROUTING_MODULE).href,
        String(direct.port),
      ],
      {
        // NODE_USE_ENV_PROXY is on, so the repair would normally install an
        // EnvHttpProxyAgent — PROXY_ONLY_HOSTS must defer to the routing
        // dispatcher instead.
        NODE_USE_ENV_PROXY: '1',
        PROXY_ONLY_HOSTS: 'proxied.example',
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: 'localhost,127.0.0.1',
      }
    );

    assert.equal(code, 0, `child exited with ${code}: ${stdout}\nstderr: ${stderr}`);
    const done = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.phase === 'done');
    assert.ok(done, `child did not reach done phase: ${stdout}`);
    assert.equal(done.installed, true);
    // Exactly one proxy hit proves both the deferral (the pre-install probe
    // stayed direct) and the whitelist routing (the post-install fetch went
    // through the proxy).
    assert.equal(proxy.hits.count, 1, `expected exactly one proxy hit, got ${proxy.hits.count}`);
    assert.equal(done.directStatus, 200);
    assert.equal(direct.hits.count, 1, `expected exactly one direct hit, got ${direct.hits.count}`);
  } finally {
    proxy.proxy.close();
    direct.server.close();
  }
});

test('server app installs proxy routing at startup when configured', async () => {
  const port = await findFreePort();
  const tempDir = path.join(
    require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'caff-proxy-routing-'))
  );

  const child = spawn(process.execPath, ['build/lib/app-server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CHAT_APP_HOST: '127.0.0.1',
      CHAT_APP_PORT: String(port),
      PI_CODING_AGENT_DIR: tempDir,
      PI_SQLITE_PATH: path.join(tempDir, 'proxy-routing.sqlite'),
      FEISHU_APP_ID: '',
      FEISHU_APP_SECRET: '',
      FEISHU_CONNECTION_MODE: 'webhook',
      PROXY_ONLY_HOSTS: 'auth.openai.com,chatgpt.com',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });

  const started = await new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const poll = async () => {
      if (child.exitCode !== null) {
        resolve(false);
        return;
      }
      if (stdout.includes('Proxy routing: enabled')) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });

  child.kill();
  await new Promise((resolve) => child.on('exit', resolve));
  require('node:fs').rmSync(tempDir, { recursive: true, force: true });

  assert.ok(started, `server did not report proxy routing startup: ${stdout}`);
  assert.match(stdout, /Proxy routing: enabled for \[auth\.openai\.com, chatgpt\.com\]/u);
});
