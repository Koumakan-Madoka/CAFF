// Private failure-only diagnostics. Never an event, model input, HTTP field or
// evaluation artifact. Same-OS-user trust, not a security boundary against the
// operator. Default-on, exclusive files under an actually git-ignored .tmp.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { redactFileSecrets } = require('../../build/server/domain/runtime/badcase-capture/secrets');
const root = path.resolve(__dirname, '../..');
const fail = () => Object.assign(Error('wiki_diagnostic_storage_invalid'), { code: 'wiki_diagnostic_storage_invalid' });
function readDiagnosticValues(env = process.env) {
  // Only the explicitly selected host profile and in-memory environment. No
  // production DB/service access, provider discovery, refresh use or writes.
  const values = new Set();
  const add = v => { if (typeof v === 'string' && v) values.add(v); };
  for (const [name, value] of Object.entries(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i.test(name)) add(value);
  if (env.PI_CODING_AGENT_DIR) {
    for (const name of ['models.json', 'auth.json']) {
      const file = path.join(env.PI_CODING_AGENT_DIR, name);
      if (!fs.existsSync(file)) continue;
      const object = require('./codex-transport.cjs').readPrivateJson(file);
      if (name === 'models.json') for (const p of Object.values(object.providers || {})) {
        if (typeof p?.apiKey !== 'string' || !p.apiKey || p.apiKey.startsWith('!')) continue;
        if (p.apiKey.startsWith('$')) { const v = env[p.apiKey.slice(1)]; if (!v) throw fail(); add(v); }
        else add(p.apiKey);
      }
      else for (const p of Object.values(object)) {
        // Refresh fields are deliberately neither inspected nor used.
        add(p?.access); add(p?.accessToken); add(p?.apiKey); add(p?.key);
      }
    }
  }
  return [...values];
}
function writeWikiDiagnostic(details, { directory = path.join(root, '.tmp', 'private-wikiskill-diagnostics'), knownValues = [] } = {}) {
  const tmp = path.join(root, '.tmp'), relative = path.relative(tmp, directory);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw fail();
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', path.relative(root, directory) + '/'], { cwd: root, stdio: 'ignore', windowsHide: true });
    // Existing ancestors must be real directories, not redirects out of .tmp.
    let cursor = root;
    for (const part of path.relative(root, directory).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
      const st = fs.lstatSync(cursor); if (!st.isDirectory() || st.isSymbolicLink()) throw Error();
    }
    const needles = [...new Set(knownValues.flatMap(v => [v, JSON.stringify(v).slice(1, -1), Buffer.from(v).toString('base64')]))];
    const safe = redactFileSecrets(Buffer.from(details.modelOutput || ''), needles);
    // Allow only static validator paths/rules. Never persist an Error, stack,
    // rejected value, source case prose, absolute path, or provider error body.
    const issue = details.validationIssue;
    const field = /^[A-Za-z0-9_.\[\]]{1,200}$/.test(issue?.field || '') ? issue.field : 'response';
    const rule = /^[a-z0-9_]{1,100}$/.test(issue?.rule || '') ? issue.rule : 'validation_failed';
    const record = { kind: 'private-wikiskill-validation-v1', createdAt: new Date().toISOString(),
      phase: details.phase === 'preclassification' ? 'preclassification' : 'induction',
      validationIssue: { field, rule }, redactionCount: safe.redactionCount, modelOutput: safe.content.toString('utf8') };
    const serialized = JSON.stringify(record, null, 2) + '\n';
    if (needles.some(v => serialized.includes(v))) throw Error();
    const file = path.join(directory, crypto.randomUUID() + '.json'), fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { throw fail(); }
}
module.exports = { writeWikiDiagnostic, readDiagnosticValues };
