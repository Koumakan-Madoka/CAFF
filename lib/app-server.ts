const { createServerApp } = require('../server/app/create-server');

function main() {
  const app = createServerApp();
  app.start(() => {
    const status = typeof app.getStatus === 'function' ? app.getStatus() : {};
    process.stdout.write(`Local chat app running at http://${app.host}:${app.port}\n`);
    process.stdout.write(`SQLite database: ${app.store.databasePath}\n`);
    process.stdout.write(`Provider: ${status.provider || '—'} | Model: ${status.model || '—'}\n`);
    process.stdout.write(`Optional: Feishu=${status.feishuEnabled ? 'enabled' : 'disabled'}, OpenSandbox=${status.openSandboxAvailable ? 'available' : 'unavailable'}\n`);
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
