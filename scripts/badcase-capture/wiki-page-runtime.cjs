// Operator-owned page runtime selection; never accepted from HTTP input.
// Config stores image/backend/auth-directory selection only, not credentials.
const fs = require('node:fs'), path = require('node:path');
const fail = code => Object.assign(Error(code), { code });
async function runPageInduction(input, { configFile } = {}, dependencies = {}) {
  if (configFile === undefined) throw fail('wiki_runtime_config_required');
  let config;
  try {
    if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) throw Error();
    const stat = fs.lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error();
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (!config || Array.isArray(config) || Object.keys(config).some(k => !['image', 'dockerBackend', 'credentialDir'].includes(k))
      || !config.image || typeof config.image.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(config.image.imageId)
      || !['amd64', 'arm64'].includes(config.image.architecture)
      || typeof config.credentialDir !== 'string' || !path.isAbsolute(config.credentialDir)) throw Error();
    if (config.dockerBackend !== undefined) require('./wsl-docker.cjs').validateWslDockerBackend(config.dockerBackend);
  } catch { throw fail('wiki_runtime_config_invalid'); }
  const readKey = dependencies.readKey || require('./direct-model.cjs').readCaffDeepseekKey;
  return (dependencies.induct || require('./wiki-induction.cjs').inductWikiCases)({
    store: input.store, expectedRevision: input.expectedRevision, confirmed: true, image: config.image,
    ...(config.dockerBackend === undefined ? {} : { dockerBackend: config.dockerBackend }),
  }, { readKey: () => readKey({ ...process.env, PI_CODING_AGENT_DIR: config.credentialDir }),
    readDiagnosticValues: () => require('./wiki-diagnostics.cjs').readDiagnosticValues({ ...process.env, PI_CODING_AGENT_DIR: config.credentialDir }),
  });
}
module.exports = { runPageInduction };
