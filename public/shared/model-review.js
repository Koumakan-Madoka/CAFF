// @ts-check
// Dedicated operator surface, not loaded by production pages. No start action.
(function () {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createModelReviewPanel = function ({ root, fetchJson, confirm = text => window.confirm(text) }) {
    let csrf = '', pending = false, ticket = null;
    root.innerHTML = `<h3>模型配置审核（仅保存，不运行）</h3>
      <p>受信操作者提供计划与出口声明；材料、角色正文及评分规则真实性未核验。确认不是付费许可，不能启动模型或 Docker。既有离线批准不在此升级。</p>
      <label>项目 ID（历史查询可手填）<input data-model-project autocomplete="off"></label>
      <button data-model-list type="button">读取预配置条目</button>
      <label>条目<select data-model-entry></select></label>
      <button data-model-preview type="button">1. 完整配置预览</button>
      <p>请核对完整计划及以下绑定正文：主机/IP/路径、模型与参数、上下文/输出上限、费率、每 run 请求数、两角色各重复次数、逐次/总预算与时限。金额单位 micro-USD（1 USD = 1000000 micro-USD）；声明费率非供应商账单，预留/超时不保证供应商停止计费。</p>
      <pre data-model-review style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <button data-model-approve type="button">2. 确认保存（不运行）</button>
      <label>批准 ID（自行保留）<input data-model-id autocomplete="off"></label>
      <button data-model-read type="button">查询已保存完整配置与报告</button>
      <pre data-model-report style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
      <p data-model-status role="status"></p>
      <p>预览5分钟内有效；重启丢失票据但保留历史正文。失败不自动重试；凭项目与批准 ID 查询。仅信任同 OS 用户，本机进程可模拟确认；这不是抵御同宿主 agent shell 的认证。</p>`;
    const el = n => root.querySelector(`[data-model-${n}]`);
    const notice = s => { el('status').textContent = s; };
    function controls() {
      for (const n of ['project', 'entry', 'id', 'list', 'read', 'preview', 'approve']) el(n).disabled = pending || !csrf;
      el('approve').disabled = pending || !csrf || !ticket;
      el('preview').disabled = pending || !csrf || !el('entry').value;
    }
    function clear() { ticket = null; el('review').textContent = ''; }
    function valid(r, project) {
      if (!r || r.projectId !== project || r.mode !== 'model-configuration-review' || r.launchAvailable !== false
        || r.paidAuthorization !== false || r.materialVerified !== false || r.executionVerified !== false || r.strictEvalEligible !== false) throw Error('invalid');
    }
    const project = () => { const p = el('project').value.trim(); if (!/^[A-Za-z0-9_-]{1,128}$/.test(p)) throw Error('invalid'); return p; };
    async function act(action) {
      if (el(action).disabled) return;
      let p;
      try {
        p = project(); const base = '/api/model-review/' + encodeURIComponent(p); let url, body;
        if (action === 'list') { clear(); el('entry').replaceChildren(); url = base + '/entries'; }
        else if (action === 'preview') { clear(); body = { entryId: el('entry').value }; url = base + '/preview'; }
        else if (action === 'read') {
          clear(); const value = el('id').value.trim(); if (!/^[a-f0-9-]{36}$/.test(value)) throw Error('invalid');
          url = base + '/records/' + encodeURIComponent(value);
        } else {
          if (!ticket || Date.now() >= ticket.expiresAt || ticket.projectId !== p) { clear(); throw Error('stale'); }
          if (!confirm(`仅保存配置声明，不启动或授权付费。\n项目 ${p}\n批准 ${ticket.approvalId}\n计划 ${ticket.plan.planHash}\n配置 ${ticket.binding.bindingHash}\n已核对完整设置、工具定义（如有）、费率、次数、预算和目的地？`)) return;
          body = { confirmed: true, approvalId: ticket.approvalId, planHash: ticket.plan.planHash, bindingHash: ticket.binding.bindingHash };
          url = base + '/approve';
        }
        pending = true; controls(); el('report').textContent = ''; notice('处理中…');
        const r = await fetchJson(url, body ? { method: 'POST', body, headers: { 'X-CAFF-CSRF-Token': csrf } } : undefined);
        valid(r, p);
        if (action === 'list') {
          if (!Array.isArray(r.entries) || r.entries.length > 64 || r.entries.some(e => !/^[A-Za-z0-9_-]{1,128}$/.test(e.id))) throw Error('invalid');
          for (const e of r.entries) { const o = document.createElement('option'); o.value = e.id; o.textContent = e.id; el('entry').append(o); }
          notice('尚未预览或保存。');
        } else if (action === 'preview') {
          if (!r.plan?.spec || !r.binding?.config || r.entryId !== body.entryId || r.plan.spec.model.settingsHash !== r.binding.bindingHash
            || !/^[a-f0-9]{64}$/.test(r.plan.planHash) || !/^[a-f0-9]{64}$/.test(r.binding.bindingHash)
            || !/^[a-f0-9-]{36}$/.test(r.approvalId) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now()) throw Error('invalid');
          ticket = r; el('id').value = r.approvalId; el('review').textContent = JSON.stringify(r, null, 2); notice('仅预览，未保存。');
        } else {
          if (r.report?.approval?.approvalId !== (body?.approvalId || el('id').value.trim())
            || r.report?.ledger?.spec?.model.settingsHash !== r.binding?.bindingHash
            || (body && (r.report.approval.planHash !== body.planHash || r.binding.bindingHash !== body.bindingHash))) throw Error('invalid');
          el('report').textContent = JSON.stringify(r, null, 2); notice(action === 'approve' ? '配置声明已保存，未运行。' : '只读查询完成。');
        }
      } catch { if (action === 'preview') clear(); notice('操作失败或结果未知，不自动重试；保留 ID 查询。'); }
      finally { pending = false; controls(); }
    }
    for (const n of ['project', 'entry', 'id']) el(n).addEventListener(n === 'entry' ? 'change' : 'input', () => {
      clear(); if (n === 'project') el('entry').replaceChildren(); el('report').textContent = ''; controls();
    });
    for (const n of ['list', 'preview', 'approve', 'read']) el(n).addEventListener('click', () => { void act(n); });
    controls();
    return { async load() {
      try {
        const b = await fetchJson('/api/bootstrap'), admin = b.localAdmin?.modelProviders;
        if (admin?.enabled !== true || !admin.csrfToken || !Array.isArray(b.projects)) throw Error('invalid');
        csrf = admin.csrfToken; el('project').value = b.projects[0] || ''; controls();
        if (el('project').value) await act('list'); else notice('没有预配置项目；可输入历史项目 ID 查询。');
      } catch { notice('审核页面不可用。'); }
    } };
  };
})();
