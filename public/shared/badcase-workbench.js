// @ts-check
// Opt-in isolated operator page only; not loaded by the production projects page.
(function registerScriptedWorkbench() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createScriptedWorkbenchPanel = function ({ root, fetchJson, confirm = text => window.confirm(text) }) {
    let project = '', generation = 0, csrf = '', pending = false, preview = null, approved = false, attempted = false;
    root.innerHTML = `<h3>专用离线 Docker 工作台（脚本替身）</h3>
      <p>仅运行固定 write/read/edit/bash 诊断任务，不执行捕获的原始请求。无真实推理、非忠实回放、非付费许可；两种角色可能产生相同结果。</p>
      <label>操作者预配置材料 <select data-work-material></select></label>
      <label>每个角色重复次数 <input data-work-repetitions type="number" min="1" max="10" value="1"></label>
      <button data-work-preview type="button">1. 核验材料并预览</button>
      <p>预览会读取归档并保留保护引用；取消不释放引用。下方展示角色正文、固定 hash 评分规则与完整计划，不展示捕获请求/会话正文。镜像字段是声明，非来源认证。</p>
      <pre data-work-review style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <button data-work-approve type="button">2. 确认保存（不运行）</button>
      <button data-work-start type="button">3. 显式启动专用 Docker</button>
      <label>批准 ID（自行保留）<input data-work-id autocomplete="off"></label>
      <button data-work-read type="button">查询持久报告</button>
      <button data-work-archive type="button">查询已保存人审材料</button>
      <p>确认时另存角色正文、评分规则与摘要；查询不依赖当前材料注册，也不恢复启动权限。旧批准可能缺少人审归档；查询失败不代表原报告丢失。</p>
      <pre data-work-report style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <p data-work-status role="status" aria-live="polite"></p>
      <p>5分钟内完成确认和启动。断开页面不取消任务，失败/结果未知不自动重试，请凭 ID 查询。重启丢失启动票据但保留报告，不恢复旧任务。null 费用是未知，不是零；reserved 不证明进程已停止。所有完整回放资格仍为 false。本机同 OS 用户可模拟请求。</p>`;
    const el = name => root.querySelector(`[data-work-${name}]`);
    const notice = value => { el('status').textContent = value; };
    function controls() {
      const disabled = !project || !csrf || pending;
      for (const n of ['material', 'repetitions', 'id', 'read', 'archive']) el(n).disabled = disabled;
      el('preview').disabled = disabled || !el('material').value;
      el('approve').disabled = disabled || !preview;
      el('start').disabled = disabled || !preview || !approved || attempted;
      root.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
    function clear() { preview = null; approved = false; attempted = false; el('review').textContent = ''; }
    function envelope(r, id) {
      if (!r || r.projectId !== id || r.mode !== 'offline-scripted-declaration' || r.launchAvailable !== false
        || r.materialVerified !== false || r.paidAuthorization !== false) throw Error('invalid_response');
    }
    function report(r, id, approvalId, planHash) {
      envelope(r, id);
      if (r.report?.approval?.approvalId !== approvalId || (planHash && r.report.approval.planHash !== planHash)
        || r.report.ledger?.executionVerified !== false || r.report.ledger?.strictEvalEligible !== false) throw Error('invalid_report');
      el('report').textContent = JSON.stringify(r.report, null, 2);
    }
    async function select(value) {
      const seq = ++generation; project = value?.id || ''; csrf = ''; pending = Boolean(project); clear();
      el('material').replaceChildren(); el('id').value = ''; el('report').textContent = ''; controls();
      if (!project) { notice('未选择项目'); return; }
      const id = project; notice('读取专用工作台…');
      try {
        const b = await fetchJson('/api/bootstrap');
        if (seq !== generation) return;
        const admin = b.localAdmin?.modelProviders;
        if (admin?.enabled !== true || !admin.csrfToken) throw Error('unavailable');
        const r = await fetchJson(`/api/projects/${encodeURIComponent(id)}/badcase-evaluations/materials`);
        if (seq !== generation) return;
        if (r.projectId !== id || r.mode !== 'offline-scripted-workbench' || r.paidAuthorization !== false
          || !Array.isArray(r.materials) || r.materials.length > 64 || r.materials.some(m => !/^[A-Za-z0-9_-]{1,128}$/.test(m.id))) throw Error('invalid_materials');
        for (const m of r.materials) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.id; el('material').append(o); }
        csrf = admin.csrfToken; notice('尚未预览或启动。');
      } catch { if (seq === generation) notice('专用工作台不可用，未启动。'); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function act(action) {
      if (el(action).disabled) return;
      const seq = generation, id = project, base = `/api/projects/${encodeURIComponent(id)}/badcase-evaluations`;
      let body, url, approvalId, planHash;
      try {
        if (action === 'preview') {
          clear(); body = { materialId: el('material').value, repetitions: Number(el('repetitions').value) }; url = base + '/material-preview';
        } else if (action === 'read' || action === 'archive') {
          if (action === 'archive') clear();
          approvalId = el('id').value.trim(); if (!/^[a-f0-9-]{36}$/.test(approvalId)) throw Error('invalid_id');
          url = base + (action === 'archive' ? '/reviews/' : '/records/') + encodeURIComponent(approvalId);
        } else {
          if (!preview || Date.now() >= preview.expiresAt) { clear(); notice('预览已过期，请重新预览。'); controls(); return; }
          const p = preview;
          if (!confirm(`${action === 'start' ? '启动专用 Docker 脚本诊断；非真实模型评测' : '仅保存声明，不启动'}。\n项目 ${id}\n批准 ${p.approvalId}\n计划 ${p.plan.planHash}\n审阅 ${p.reviewHash}\n确认已核对角色、固定评分规则、次数、超时及预留单位？`)) return;
          if (seq !== generation) return;
          approvalId = p.approvalId; planHash = p.plan.planHash;
          body = { confirmed: true, approvalId, planHash, reviewHash: p.reviewHash };
          url = base + (action === 'start' ? '/start' : '/material-approve');
          if (action === 'start') attempted = true;
        }
        pending = true; el('report').textContent = ''; notice('处理中；关闭页面不取消运行…'); controls();
        const r = await fetchJson(url, (action === 'read' || action === 'archive') ? undefined : { method: 'POST', body, headers: { 'X-CAFF-CSRF-Token': csrf } });
        if (seq !== generation) return;
        envelope(r, id);
        if (action === 'preview') {
          if (!r.plan?.spec || !Array.isArray(r.plan.runs) || !/^[a-f0-9]{64}$/.test(r.plan.planHash)
            || !/^[a-f0-9]{64}$/.test(r.reviewHash) || r.review?.planHash !== r.plan.planHash
            || r.review?.realModel !== false || r.review?.faithfulReplay !== false
            || r.materialId !== body.materialId || r.plan.spec.repetitions !== body.repetitions
            || !/^[a-f0-9-]{36}$/.test(r.approvalId) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now()) throw Error('invalid_preview');
          preview = r; el('id').value = r.approvalId;
          el('review').textContent = JSON.stringify({ expiresAt: r.expiresAt, reviewHash: r.reviewHash, review: r.review, plan: r.plan }, null, 2);
          notice('材料预览完成，未保存、未启动。');
        } else {
          report(r, id, approvalId, planHash);
          if (action === 'archive') {
            const a = r.reviewArchive;
            if (!a || a.schemaVersion !== 1 || a.projectId !== id || a.approvalId !== approvalId
              || a.review?.planHash !== r.report.approval.planHash || a.expiresAt !== r.report.approval.expiresAt
              || !/^[a-f0-9]{64}$/.test(a.reviewHash) || a.review.realModel !== false || a.review.faithfulReplay !== false) throw Error('invalid_archive');
            clear(); el('review').textContent = JSON.stringify(a, null, 2);
          }
          if (action === 'approve') approved = r.report.consumed === false;
          notice(action === 'approve' ? '声明已保存，未启动。' : action === 'start' ? '启动请求已返回，请核对逐次报告；不代表真实复现。' : '只读查询完成。');
        }
      } catch {
        if (seq === generation) { if (action === 'preview') clear(); notice('操作失败或结果未知；不自动重试。保留批准 ID 查询。'); }
      } finally { if (seq === generation) { pending = false; controls(); } }
    }
    for (const n of ['material', 'repetitions', 'id']) el(n).addEventListener(n === 'material' ? 'change' : 'input', () => { clear(); controls(); });
    for (const n of ['preview', 'approve', 'start', 'read', 'archive']) el(n).addEventListener('click', () => { void act(n); });
    controls(); return { select };
  };
})();
