const { createServerApp } = require('../server/app/create-server');

function main() {
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
  main();
}

export { main };
