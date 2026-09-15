const { createServerApp } = require('../server/app/create-server');

// ESM-only module; tsc's commonjs output would rewrite a plain dynamic
// import() into require(), so import through an opaque function (same
// pattern as subscription-login's pi-ai import).
const dynamicImport = Function('specifier', 'return import(specifier)');

async function installProxyRouting() {
  try {
    const module = await dynamicImport('./proxy-routing.mjs');
    const result = module.installProxyOnlyRoutingDispatcher();
    if (result.installed) {
      const hosts = (result.hosts || [])
        .map((entry: any) => entry.hostname)
        .join(', ');
      process.stdout.write(`Proxy routing: enabled for [${hosts}]; all other hosts connect directly\n`);
    } else if (result.reason === 'no_proxy_url') {
      process.stderr.write('PROXY_ONLY_HOSTS is set but HTTP(S)_PROXY is not configured; outbound requests stay direct\n');
    }
  } catch (error) {
    process.stderr.write(`Proxy routing setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function main() {
  await installProxyRouting();

  const app = createServerApp();
  app.start(() => {
    const health = app.getHealthStatus();
    const baseUrl = `http://${health.core.host}:${health.core.port}`;
    const feishu = health.optional.feishu;
    process.stdout.write(`Local chat app running at ${baseUrl}\n`);
    process.stdout.write(`SQLite database: ${app.store.databasePath}\n`);
    process.stdout.write(
      `Chat defaults: ${health.chat.availableDefaultRoleCount}/${health.chat.defaultRoleCount} ready\n`
    );
    process.stdout.write(
      `Feishu: configured=${feishu.configured}, mode=${feishu.connectionMode}, long-connection-sdk=${feishu.longConnectionSdkAvailable ? 'available' : 'unavailable'}\n`
    );
    process.stdout.write(`Health: ${baseUrl}/api/health\n`);
  });

  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    app.close(() => {
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  void main();
}

export { main };
