// Explicit host safety inventory, NOT provider authorization or discovery.
// No subprocess commands, refresh use, source writeback, credential logs or DB
// access. JEV must be injected into this trusted process, not read from 3100.
const fs = require('node:fs'), path = require('node:path');
const { readPrivateJson } = require('./codex-transport.cjs');
const fail = () => Object.assign(Error('evaluation_known_keys_unavailable'), { code: 'evaluation_known_keys_unavailable' });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function readKnownKeyValues(config, { env = process.env } = {}) {
  try {
    if (!object(config) || Object.keys(config).sort().join(',') !== 'jevSource,sandboxRoot' || config.jevSource !== 'TYPESAFE_API_KEY'
      || !path.isAbsolute(config.sandboxRoot || '') || path.basename(config.sandboxRoot) !== '.pi-sandbox') throw Error();
    const root = path.resolve(config.sandboxRoot), st = fs.lstatSync(root);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(root) !== root) throw Error();
    if (typeof env.TYPESAFE_API_KEY !== 'string' || !env.TYPESAFE_API_KEY.trim()) throw Error();
    const values = new Set(), add = v => { if (typeof v === 'string' && v) values.add(v); };
    const models = readPrivateJson(path.join(root, 'models.json')), auth = readPrivateJson(path.join(root, 'auth.json'));
    if (!object(models) || !object(models.providers || {}) || !object(auth)) throw Error();
    for (const provider of Object.values(models.providers || {})) {
      if (!object(provider) || provider.apiKey === undefined || provider.apiKey === '') continue;
      const value = provider.apiKey;
      if (typeof value !== 'string' || value.startsWith('!')) throw Error();
      if (value.startsWith('$')) {
        if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) || typeof env[value.slice(1)] !== 'string' || !env[value.slice(1)]) throw Error();
        add(env[value.slice(1)]);
      } else add(value);
    }
    const walk = entry => {
      if (!object(entry) && !Array.isArray(entry)) return;
      for (const [key, value] of Object.entries(entry)) {
        // Refresh values are compared as inert known bytes only, never used to
        // authenticate/refresh a session or sent to any provider endpoint.
        if (/^(?:key|token|api_?key|access|refresh|access_?token|refresh_?token)$/i.test(key)) add(value);
        if (object(value) || Array.isArray(value)) walk(value);
      }
    };
    walk(auth);
    add(env.TYPESAFE_API_KEY);
    return Object.defineProperty({}, 'values', { value: Object.freeze([...values].sort()) });
  } catch { throw fail(); }
}
module.exports = { readKnownKeyValues };
