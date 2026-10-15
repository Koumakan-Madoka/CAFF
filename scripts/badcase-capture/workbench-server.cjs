// Isolated operator composition. No production server imports this module, no
// automatic CLI/config-file loader, and no browser-supplied filesystem/daemon paths.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createScriptedWorkbench } = require('./scripted-workbench.cjs');
const { createBadcaseEvaluationsController } = require('../../build/server/api/badcase-evaluations-controller');
const { createLocalAdminGuard } = require('../../build/server/http/local-admin-guard');
async function startScriptedWorkbenchServer(options) {
  const workbench = createScriptedWorkbench(options);
  const projects = [...new Set(options.materials.map(m => m.projectId))].map(id => ({ id }));
  const csrfToken = crypto.randomBytes(32).toString('hex');
  let authority;
  const common = { host: '127.0.0.1', getAuthority: () => authority, csrfToken, issuePrefix: 'badcase_evaluation' };
  const guard = createLocalAdminGuard(common);
  const controller = createBadcaseEvaluationsController({ ...common, service: workbench.admin, workbench,
    projectManager: { listProjects: () => projects } });
  // Fixed static allowlist; never join URL paths into the filesystem.
  const assets = new Map(['/shared/api-client.js', '/shared/badcase-workbench.js'].map(url =>
    [url, fs.readFileSync(path.resolve(__dirname, '../../public', url.slice(1)))]));
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Offline scripted workbench</title><label>项目 <select id="project"></select></label><div id="panel"></div><script src="/shared/api-client.js"></script><script src="/shared/badcase-workbench.js"></script><script src="/boot.js"></script></html>';
  const boot = `(async()=>{const b=await CaffShared.fetchJson('/api/bootstrap');const s=document.querySelector('#project');for(const p of b.projects){const o=document.createElement('option');o.value=p.id;o.textContent=p.id;s.append(o);}const panel=CaffShared.createScriptedWorkbenchPanel({root:document.querySelector('#panel'),fetchJson:CaffShared.fetchJson});s.onchange=()=>panel.select(s.value?{id:s.value}:null);await panel.select(s.value?{id:s.value}:null);})().catch(()=>{document.querySelector('#panel').textContent='工作台不可用';});`;
  const server = http.createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      guard.assertRead(req);
      const pathname = new URL(req.url, 'http://local').pathname;
      if (await controller({ req, res, pathname })) return;
      if (req.method === 'GET') {
        if (pathname === '/api/bootstrap') return json({ projects, localAdmin: { modelProviders: { enabled: true, csrfToken } } });
        if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
        if (pathname === '/boot.js' || assets.has(pathname)) {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); return res.end(pathname === '/boot.js' ? boot : assets.get(pathname));
        }
      }
      json({}, 404);
    } catch (e) { json({ issues: e.issues || [{ code: 'badcase_evaluation_unavailable' }] }, e.statusCode || 503); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  authority = `127.0.0.1:${server.address().port}`;
  return { url: `http://${authority}`, async close() {
    // Not cancellation. In-flight handlers finish; the caller owns lifecycle and
    // must not tear down the dedicated daemon while a task is still executing.
    await new Promise((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); });
  } };
}
module.exports = { startScriptedWorkbenchServer };
