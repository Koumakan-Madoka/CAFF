// @ts-check
(function registerOfflineEvaluations() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseEvaluationPanel = function (options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirm = options.confirm || (text => window.confirm(text));
    let project = null, generation = 0, csrf = '', pending = false, preview = null;
    root.innerHTML = `<h3>离线对照批准与报告（预览）</h3>
      <p class="muted">仅脚本模型 caff-offline-scripted/tool-loop-v1，无真实推理。仅保存同一 OS 用户的批准声明，不启动 Docker，不授权付费；本机 shell 可模拟请求。
      配置中的摘要是声明，尚未核验现场、角色正文、模型配置或评分规则。复制受信离线计划的 spec JSON（不是完整 plan）；勿粘贴凭据、私有内容或路径。</p>
      <label>离线计划 spec JSON<textarea data-eval-spec rows="6" spellcheck="false"></textarea></label>
      <div class="button-row"><button type="button" data-eval-preview>1. 预览配置</button><button type="button" data-eval-approve>2. 确认保存声明（不运行）</button></div>
      <pre data-eval-plan style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <label>批准 ID（请自行保留）<input data-eval-id autocomplete="off" /></label>
      <button type="button" data-eval-read>查询逐次报告（不运行）</button>
      <pre data-eval-report style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <p data-eval-status role="status" aria-live="polite"></p>
      <p class="muted">预览 5 分钟失效；重启后需重新预览才能保存，已有记录可凭 ID 查询。切换项目不撤销已发送请求。
      尚无自动派发、结果列表或删除/配额回收；结果由受信离线协调器写入。报告资格始终未验证，不代表真实 badcase 已复现。</p>`;
    const el = name => root.querySelector(`[data-eval-${name}]`);
    const notice = text => { el('status').textContent = text; };
    function controls() {
      const disabled = !project || !csrf || pending;
      for (const name of ['spec', 'id', 'preview', 'read']) el(name).disabled = disabled;
      el('approve').disabled = disabled || !preview || Date.now() >= preview.expiresAt;
      root.setAttribute('aria-busy', pending ? 'true' : 'false');
    }
    function clearPreview() { preview = null; el('plan').textContent = ''; }
    function validEnvelope(r, id) {
      if (!r || r.projectId !== id || r.mode !== 'offline-scripted-declaration' || r.launchAvailable !== false
        || r.paidAuthorization !== false || r.materialVerified !== false) throw Error('invalid_offline_response');
    }
    function showReport(r, id, approvalId, planHash) {
      validEnvelope(r, id);
      if (!r.report?.ledger || r.report.approval?.approvalId !== approvalId
        || (planHash && r.report.approval.planHash !== planHash)
        || r.report.ledger.executionVerified !== false || r.report.ledger.strictEvalEligible !== false) throw Error('invalid_offline_response');
      el('id').value = r.report.approval.approvalId;
      el('report').textContent = `声明状态：${r.report.dispatchState}；原因：${r.report.reason || '无'}\n费用单位：micro-USD；null 表示未知，不是 0。reserved 表示未结算，不证明进程已停止。\n` + JSON.stringify(r.report, null, 2);
    }
    async function select(value) {
      const seq = ++generation;
      project = value ? { id: value.id } : null; csrf = ''; pending = Boolean(project); clearPreview();
      el('spec').value = ''; el('id').value = ''; el('report').textContent = '';
      notice(project ? '读取本地管理权限…' : '未选择项目'); controls();
      if (!project) return;
      try {
        const b = await fetchJson('/api/bootstrap');
        if (seq !== generation) return;
        const admin = b.localAdmin?.modelProviders;
        if (admin?.enabled !== true || !admin.csrfToken) throw Error('local_admin_unavailable');
        csrf = admin.csrfToken; notice('尚未预览或保存任何批准声明。');
      } catch { if (seq === generation) notice('本地管理不可用；未保存声明。'); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function act(action) {
      if (el(action).disabled) return;
      const id = project.id, seq = generation, base = `/api/projects/${encodeURIComponent(id)}/badcase-evaluations`;
      let body, url, expectedId = '', expectedHash = '';
      try {
        if (action === 'preview') {
          body = { spec: JSON.parse(el('spec').value) }; url = base + '/preview'; clearPreview();
        } else if (action === 'approve') {
          if (!preview || Date.now() >= preview.expiresAt) { clearPreview(); notice('预览已过期，请重新预览。'); controls(); return; }
          const p = preview;
          if (!confirm(`仅保存项目 ${id} 的离线声明，不启动任务或付费。\n批准 ID：${p.approvalId}\n计划摘要：${p.plan.planHash}\n到期：${new Date(p.expiresAt).toISOString()}\n以下配置摘要未经现场核验；确认已核对页面完整配置？`)) return;
          // A supplied confirmation callback may switch project; never route old approval into new scope.
          if (seq !== generation) return;
          expectedId = p.approvalId; expectedHash = p.plan.planHash;
          body = { confirmed: true, approvalId: p.approvalId, planHash: p.plan.planHash }; url = base + '/approve';
        } else {
          const approvalId = el('id').value.trim();
          if (!/^[a-f0-9-]{36}$/.test(approvalId)) throw Error('invalid_id');
          expectedId = approvalId; url = base + '/records/' + encodeURIComponent(approvalId);
        }
        pending = true; el('report').textContent = ''; notice('处理中…'); controls();
        const r = await fetchJson(url, action === 'read' ? undefined : { method: 'POST', body, headers: { 'X-CAFF-CSRF-Token': csrf } });
        if (seq !== generation) return;
        validEnvelope(r, id);
        if (action === 'preview') {
          if (!r.plan?.spec || !/^[a-f0-9]{64}$/.test(r.plan.planHash) || !/^[a-f0-9-]{36}$/.test(r.approvalId)
            || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now()) throw Error('invalid_offline_preview');
          preview = r; el('id').value = r.approvalId;
          el('plan').textContent = `到期：${new Date(r.expiresAt).toISOString()}；共 ${r.plan.runs.length} 次\n` + JSON.stringify(r.plan, null, 2);
          notice('仅预览，未保存。核对模型/次数/超时/预算单位/所有摘要后再确认。');
        } else { showReport(r, id, expectedId, expectedHash); notice(action === 'approve' ? '批准声明已保存；未启动任务。' : '只读查询完成。'); }
      } catch {
        if (seq === generation) {
          if (action === 'preview') clearPreview();
          // No automatic POST retry; retain ID after a lost response for read-only reconciliation.
          notice('操作失败或结果未知；未自动重试。请保留批准 ID 并查询；需要新配置时重新预览。');
        }
      } finally { if (seq === generation) { pending = false; controls(); } }
    }
    el('spec').addEventListener('input', () => { clearPreview(); controls(); });
    for (const action of ['preview', 'approve', 'read']) el(action).addEventListener('click', () => { void act(action); });
    controls();
    return { select };
  };
})();
