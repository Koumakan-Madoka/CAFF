// Isolated review-only composition. No production import, executor or credential
// callback. CLI uses an operator-owned JSON registry; never browser-supplied paths.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createModelReviewService } = require('../../build/server/domain/runtime/badcase-capture/model-review');
const { createLocalAdminGuard } = require('../../build/server/http/local-admin-guard');
const { readRawRequestBody } = require('../../build/server/http/request-body');
async function startModelReviewServer(options) {
  const service = createModelReviewService(options); // validate before listening or writing
  const csrfToken = crypto.randomBytes(32).toString('hex'); let authority;
  const guard = createLocalAdminGuard({ host: '127.0.0.1', getAuthority: () => authority, csrfToken, issuePrefix: 'model_review' });
  const assets = new Map(['/shared/api-client.js', '/shared/model-review.js'].map(url =>
    [url, fs.readFileSync(path.resolve(__dirname, '../../public', url.slice(1)))]));
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模型配置审核（不可启动）</title><div id="panel"></div><script src="/shared/api-client.js"></script><script src="/shared/model-review.js"></script><script src="/boot.js"></script></html>';
  const boot = 'CaffShared.createModelReviewPanel({root:document.querySelector("#panel"),fetchJson:CaffShared.fetchJson}).load();';
  const errors = { model_review_invalid: 422, model_review_missing: 404, model_review_busy: 429,
    model_review_stale: 409, model_review_clock_invalid: 409, model_review_record_invalid: 409 };
  const server = http.createServer(async (req, res) => {
    const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      guard.assertRead(req);
      const pathname = new URL(req.url, 'http://local').pathname;
      if (req.method === 'GET') {
        if (pathname === '/api/bootstrap') return json({ projects: service.projects(), localAdmin: { modelProviders: { enabled: true, csrfToken } } });
        if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
        if (pathname === '/boot.js' || assets.has(pathname)) {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(pathname === '/boot.js' ? boot : assets.get(pathname));
        }
      }
      const m = pathname.match(/^\/api\/model-review\/([A-Za-z0-9_-]{1,128})\/(entries|preview|approve|records\/([a-f0-9-]{36}))$/);
      if (!m) return json({}, 404);
      const read = m[2] === 'entries' || m[2].startsWith('records/');
      if (req.method !== (read ? 'GET' : 'POST')) return json({}, 404);
      if (!read) guard.assertMutation(req);
      let body = null;
      if (!read) {
        const bytes = await readRawRequestBody(req, { bodyLimit: 2048 }), text = bytes.toString('utf8');
        if (!Buffer.from(text).equals(bytes)) return json({ issues: [{ code: 'model_review_invalid' }] }, 400);
        try { body = JSON.parse(text); } catch { return json({ issues: [{ code: 'model_review_invalid' }] }, 400); }
      }
      return json(m[2] === 'entries' ? service.list(m[1]) : read ? service.read(m[1], m[3])
        : m[2] === 'preview' ? service.preview(m[1], body) : service.approve(m[1], body));
    } catch (e) {
      // No exception text, supplied configuration or storage paths in responses.
      if (e.statusCode && e.issues) return json({ issues: e.issues }, e.statusCode);
      if (e.statusCode === 413) return json({ issues: [{ code: 'model_review_body_limit' }] }, 413);
      const code = Object.hasOwn(errors, e.code || '') ? e.code : 'model_review_unavailable';
      return json({ issues: [{ code }] }, errors[code] || 503);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  authority = `127.0.0.1:${server.address().port}`;
  return { url: `http://${authority}`, async close() {
    await new Promise((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); });
  } };
}
function readRegistry(file) {
  if (!path.isAbsolute(file)) throw Error('invalid');
  const st = fs.lstatSync(file, { bigint: true }); if (!st.isFile() || st.size < 2n || st.size > 262144n) throw Error('invalid');
  const fd = fs.openSync(file, 'r');
  try {
    const actual = fs.fstatSync(fd, { bigint: true });
    if (!actual.isFile() || actual.dev !== st.dev || actual.ino !== st.ino || actual.size !== st.size) throw Error('invalid');
    const size = Number(st.size); // bounded size, never rounded device/inode
    const buffer = Buffer.alloc(size + 1); let n = 0;
    while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, n); if (!got) break; n += got; }
    const bytes = buffer.subarray(0, n), text = bytes.toString('utf8');
    if (n !== size || !Buffer.from(text).equals(bytes)) throw Error('invalid');
    return JSON.parse(text);
  } finally { fs.closeSync(fd); }
}
module.exports = { startModelReviewServer, readRegistry };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--root' || args[2] !== '--registry' || !path.isAbsolute(args[1])) throw Error('invalid');
    const server = await startModelReviewServer({ root: args[1], entries: readRegistry(args[3]) });
    console.log(JSON.stringify({ url: server.url, mode: 'model-configuration-review', launchAvailable: false, paidAuthorization: false }));
    let closing = false;
    const stop = () => { if (!closing) { closing = true; server.close().catch(() => { process.exitCode = 1; }); } };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  })().catch(() => { console.error('model_review_start_failed'); process.exitCode = 1; });
}
