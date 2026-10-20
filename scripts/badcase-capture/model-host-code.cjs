// Trusted, repository-owned CommonJS source inventory. This does not execute the
// operator or dependencies. Only literal relative require calls and Node builtins
// are allowed; unsupported dependency forms fail closed, not silently omitted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isBuiltin } = require('node:module');
const fail = () => { throw Error('model_host_code_invalid'); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function captureHostCode() {
  const root = fs.realpathSync(path.resolve(__dirname, '../..'));
  function inventory() {
    const files = new Map();
    function visit(file) {
      file = path.resolve(file);
      // Current compiled relative imports omit only .js. Do not resolve through
      // package.json, directory mains or symlink aliases outside this inventory.
      if (!path.extname(file)) file += '.js';
      const name = path.relative(root, file).split(path.sep).join('/');
      if (name.startsWith('../') || path.isAbsolute(name) || !/\.(?:cjs|js)$/.test(name)
        || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) fail();
      if (files.has(name)) return;
      if (files.size >= 256) fail();
      const bytes = fs.readFileSync(file);
      if (bytes.length > 1048576) fail();
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) fail();
      files.set(name, hash(bytes));
      // Conservative scan: literals inside embedded code are included too. This
      // is not a JS parser or an integrity boundary against a malicious author.
      // New dynamic imports/requires need an explicit reviewed inventory design.
      const refs = [...text.matchAll(/\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)];
      if (refs.length !== [...text.matchAll(/\brequire\s*\(/g)].length || /\bimport\s*(?:\(|[{'"*])/.test(text)) fail();
      for (const [, , ref] of refs) {
        if (isBuiltin(ref)) continue;
        if (!ref.startsWith('./') && !ref.startsWith('../')) fail();
        visit(path.resolve(path.dirname(file), ref));
      }
    }
    // Includes the caller's operator, preparation/scoring, auth, protocol,
    // accounting, cleanup and lazy recovery imports, not just loaded children.
    visit(__filename);
    visit(path.join(root, 'scripts/badcase-capture/model-evaluation-operator.cjs'));
    visit(path.join(root, 'scripts/badcase-capture/model-evaluation.cjs'));
    // The new native-SDK gateway/credential-free routing are reviewed host code
    // too. Old inventories/approvals cannot silently launch the new supervisor.
    visit(path.join(root, 'scripts/badcase-capture/approved-sdk-model-gateway.cjs'));
    return Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  const files = inventory(), encoded = JSON.stringify(files);
  return { files: Object.freeze(files), verify() {
    try { if (JSON.stringify(inventory()) !== encoded) fail(); } catch { fail(); }
  } };
}
module.exports = { captureHostCode };
