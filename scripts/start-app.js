const path = require('node:path');

const { loadDotEnvLocal } = require('../build/lib/env-local-loader');

const projectRoot = path.resolve(__dirname, '..');
loadDotEnvLocal({
  cwd: projectRoot,
  env: process.env,
});

require('../build/lib/app-server').main();
