// Operator-owned page runtime selection; never accepted from HTTP input.
// Config stores image/backend/auth-directory selection only, not credentials.
const fs = require('node:fs'), path = require('node:path');
const fail = code => Object.assign(Error(code), { code });
function readPageRuntimeConfig(configFile) {
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
  return config;
}
async function runPageInduction(input, { configFile } = {}, dependencies = {}) {
  const config = readPageRuntimeConfig(configFile);
  const readKey = dependencies.readKey || require('./direct-model.cjs').readCaffDeepseekKey;
  return (dependencies.induct || require('./wiki-induction.cjs').inductWikiCases)({
    store: input.store, expectedRevision: input.expectedRevision, confirmed: true, image: config.image,
    ...(config.dockerBackend === undefined ? {} : { dockerBackend: config.dockerBackend }),
  }, { readKey: () => readKey({ ...process.env, PI_CODING_AGENT_DIR: config.credentialDir }),
    readDiagnosticValues: () => require('./wiki-diagnostics.cjs').readDiagnosticValues({ ...process.env, PI_CODING_AGENT_DIR: config.credentialDir }),
  });
}
// Host-only, explicit single-shot action. Uses the SAME operator runtime/auth
// selection as preclassification; no Docker/tools, credential copy or writeback.
async function runPageDehydration(input, { configFile } = {}, dependencies = {}) {
  const { preparePageDehydration, recommendDehydration } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration-runner');
  const prepared = preparePageDehydration(input); // preflight before config/auth/network
  const config = readPageRuntimeConfig(configFile), env = { ...process.env, PI_CODING_AGENT_DIR: config.credentialDir };
  const key = (dependencies.readKey || require('./direct-model.cjs').readCaffDeepseekKey)(env);
  const knownKeyValues = [...(dependencies.readKnownValues || require('./wiki-diagnostics.cjs').readDiagnosticValues)(env), key];
  const { buildDehydrationRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration');
  const built = buildDehydrationRequest({ caseRecord: input.store.read().cases.find(c => c.id === input.caseId), bundle: input.store.readCaseTrace(input.caseId), cause: prepared.cause, knownKeyValues });
  const dispatcher = (dependencies.createDispatcher || (uri => new (require('undici').ProxyAgent)({ uri })))('http://127.0.0.1:17890');
  try {
    const client = require('../../build/server/domain/runtime/badcase-capture/wiki-dehydration-client').createDehydrationClient({ key, maxRequests: 1,
      fetchImpl: (url, options) => (dependencies.fetch || require('undici').fetch)(url, { ...options, dispatcher }) });
    return await recommendDehydration({ ...prepared, approvedRequestHash: built.requestHash }, { client, knownKeyValues, retryPolicy: 'manual' });
  } finally { await dispatcher.destroy(); }
}
module.exports = { runPageInduction, runPageDehydration, readPageRuntimeConfig };
