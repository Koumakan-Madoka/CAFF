// @ts-check
(function registerBadcaseWiki() {
  const shared = window.CaffShared || (window.CaffShared = {});
  shared.createBadcaseWikiPanel = function (options) {
    const root = options.root, fetchJson = options.fetchJson;
    const confirmAction = options.confirm || (message => window.confirm(message));
    root.innerHTML = `<div class="wsk-shell">
      <header class="top">
        <div class="title-row"><h1>WikiSkill</h1></div>
        <p class="lede">用例沉淀成知识库里的模式；通过审核的模式用来改写提示词和工具描述；评测结论再记回知识库，供下一轮参考。</p>
        <div class="next" role="status"><span class="next-label">下一步</span><span class="next-text" id="next-text">正在读取真实数据…</span><button type="button" class="btn small" id="next-go">去处理</button><button type="button" class="btn small ghost" id="wsk-refresh">刷新</button></div>
        <nav aria-label="WikiSkill 分区"><div class="tabs" role="tablist">
          <button type="button" class="tab" role="tab" id="tab-cases" data-tab="cases"><span class="t-name">用例</span><span class="t-count" id="cnt-cases"></span><span class="t-sub">原始经验</span></button><span class="arrow" aria-hidden="true">→</span>
          <button type="button" class="tab" role="tab" id="tab-wiki" data-tab="wiki"><span class="t-name">知识库</span><span class="t-count" id="cnt-wiki"></span><span class="t-sub">归纳出的模式</span></button><span class="arrow" aria-hidden="true">→</span>
          <button type="button" class="tab" role="tab" id="tab-targets" data-tab="targets"><span class="t-name">优化对象</span><span class="t-count" id="cnt-targets"></span><span class="t-sub">提示词与工具描述</span></button><span class="arrow" aria-hidden="true">→</span>
          <button type="button" class="tab" role="tab" id="tab-impact" data-tab="impact"><span class="t-name">评测记录</span><span class="t-count" id="cnt-impact"></span><span class="t-sub">效果与演进</span></button><span class="loop" aria-hidden="true">↺ 评测结论记回知识库</span>
        </div></nav>
      </header>
      <main>
        <section id="view-wiki" class="view" role="tabpanel" aria-labelledby="tab-wiki"><div class="split">
          <aside class="index" aria-label="知识库目录"><div class="inbox" id="wiki-inbox"></div>
            <label class="search"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"></path></svg><input id="wiki-q" type="search" placeholder="搜索模式、症状、准则或用例原话" autocomplete="off" aria-label="搜索知识库"><kbd aria-hidden="true">/</kbd></label>
            <div class="quick">试试 <button type="button" data-q="术语">术语</button><button type="button" data-q="暂停">暂停</button><button type="button" data-q="审批">审批</button><button type="button" data-q="分支">分支</button><button type="button" data-q="MVP">MVP</button></div>
            <div class="seg" role="radiogroup" aria-label="按审核状态筛选" id="wiki-seg"></div><p class="result-count" id="wiki-count"></p><ol class="entry-list" id="wiki-list"></ol><div class="case-hits" id="wiki-casehits" hidden></div><div class="coverage" id="wiki-coverage"></div>
          </aside><article class="page" id="wiki-page" aria-live="polite"><p class="muted-note">正在读取知识库…</p></article>
        </div></section>
        <section id="view-cases" class="view" role="tabpanel" aria-labelledby="tab-cases" hidden><div class="groups">
          <div class="toolbar"><label class="search"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"></path></svg><input id="cases-q" type="search" placeholder="搜索问题、期望、来源房间或回放任务" autocomplete="off" aria-label="搜索用例"><kbd aria-hidden="true">/</kbd></label>
            <label class="field">归属模式 <select id="cases-group"></select></label><label class="field">集合 <select id="cases-split"><option value="all">全部</option><option value="train">训练</option><option value="gate">门槛</option><option value="test">测试</option><option value="unallocated">待预分类</option></select></label><label class="check"><input type="checkbox" id="cases-replay"> 只看有回放题的</label><div class="seg" role="radiogroup" aria-label="显示方式" id="cases-mode"></div>
          </div><p class="summary" id="cases-summary"></p><div class="groups" id="cases-body"></div>
        </div></section>
        <section id="view-targets" class="view" role="tabpanel" aria-labelledby="tab-targets" hidden><div class="split"><aside class="index" id="targets-list" aria-label="优化对象"></aside><article class="page" id="target-page" aria-live="polite"></article></div></section>
        <section id="view-impact" class="view" role="tabpanel" aria-labelledby="tab-impact" hidden><div class="impact-grid"><section class="panel"><div id="execution-progress" aria-live="polite"></div><h2>对照评测</h2><div id="impact-runs"></div></section><section class="panel"><h2>演进记录</h2><p class="hint">每次归纳、审核、候选和评测结论都记在这里。下次生成候选时参考它，避开已经失败过的改法。</p><ol class="timeline" id="impact-log"></ol></section></div></section>
      </main>
    </div><div class="toast" id="toast" role="status" hidden></div>`;
    const $ = selector => root.querySelector(selector);
    const $$ = selector => [...root.querySelectorAll(selector)];
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ESC[char]);
    const terms = value => String(value || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hl = (value, ts) => {
      const text = String(value == null ? '' : value);
      if (!ts.length) return esc(text);
      const pattern = ts.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
      if (!pattern.length) return esc(text);
      const re = new RegExp(pattern.join('|'), 'gi'); let last = 0, output = '', match;
      while ((match = re.exec(text))) { output += esc(text.slice(last, match.index)) + '<mark>' + esc(match[0]) + '</mark>'; last = match.index + match[0].length; if (!match[0].length) re.lastIndex++; }
      return output + esc(text.slice(last));
    };
    const pad = n => String(n).padStart(2, '0');
    const fmt = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    const latest = list => list.filter(Boolean).sort().slice(-1)[0];
    const ENTRY_STATUS = { approved: ['已通过', 'ok'], draft: ['草稿 · 待审核', 'warn'], rejected: ['已驳回', 'bad'] };
    const CAND_STATUS = { draft: ['草稿 · 待你确认', 'warn'], confirmed: ['已确认 · 待评测', 'info'], evaluated: ['已评测', 'ok'], deprecated: ['已废弃', ''] };
    const CATEGORY = { reproduction: ['复现题', 'repro'], probe: ['探针题', 'probe'], control: ['防误伤题', 'control'] };
    const SPLIT = { train: '训练', gate: '门槛', test: '测试' };
    const displaySet = c => c.split === 'train' && c.evaluationStage === 'gate' ? '训练 · 本轮门槛' : (SPLIT[c.split] || '待预分类');
    const replayStage = replay => comparisonCase(replay)?.stage || caseById.get(replay.sourceCaseId)?.evaluationStage || (replay.split === 'test' ? 'test' : 'gate');
    function explainReason(reason) {
      return String(reason || '').replace(/entry-\d+/g, id => { const {entry,version} = findEntry(id); return entry ? `模式 ${version.entries.findIndex(e=>e.id===id)+1}（${entry.title}）` : '未识别模式'; });
    }
    const pill = (map, status) => { const [label, tone] = map[status] || [status, '']; return `<span class="pill ${tone}">${esc(label)}</span>`; };
    const catChip = replay => { const [label, cls] = CATEGORY[replay.category] || [replay.category, '']; return `<span class="chip cat ${cls}">${esc(label)}</span>`; };
    let D = null, versionId = '', generation = 0, pending = false, writable = false, toastTimer, progressTimer, progressPending = false, progressError = false;
    const state = { view: 'wiki', entryId: '', wikiQ: '', wikiStatus: 'all', casesQ: '', casesGroup: 'all', casesSplit: 'all', casesReplay: false, casesMode: 'group', focusCase: null, targetId: '', comparisonId: '' };
    const VIEWS = ['cases', 'wiki', 'targets', 'impact'];
    let caseById = new Map(), caseByN = new Map(), stateByCase = new Map(), entryById = new Map(), replayBySource = new Map(), targetById = new Map();
    const currentVersion = () => D?.versions.find(v => v.id === versionId) || D?.versions.at(-1) || null;
    const latestVersion = () => D?.versions.at(-1) || null;
    const entries = () => currentVersion()?.entries || [];
    const approvedEntries = () => (latestVersion()?.entries || []).filter(e => e.status === 'approved');
    const findEntry = (id, preferredVersion) => {
      const versions = preferredVersion ? [D?.versions.find(v => v.id === preferredVersion)] : [...(D?.versions || [])].reverse();
      for (const version of versions) { const entry = version?.entries.find(e => e.id === id); if (entry) return { entry, version }; }
      return { entry: null, version: null };
    };
    const entryChip = (id, preferredVersion, compact = false) => { const { entry, version } = findEntry(id, preferredVersion); if (!entry) return ''; const n = (version?.entries || []).findIndex(e => e.id === id) + 1;
      return `<a class="chip wiki" href="#${esc(id)}" data-entry="${esc(id)}" data-version="${esc(version?.id || '')}" title="模式 ${n} · ${esc(entry.title)}" aria-label="模式 ${n} · ${esc(entry.title)}">模式 ${n}${compact ? '' : ` · ${esc(entry.title)}`}</a>`; };
    const targetLabel = target => String(target?.title || '未命名目标').replace(/^工具描述 · /, '').replace(/^全局系统提示词 · /, '');
    const targetFull = target => target?.kind === 'global-system-prompt' ? '全局系统提示词（所有 agent 共用）' : `工具 ${targetLabel(target)} 的说明`;
    const globalTarget = () => D?.targets.find(t => t.kind === 'global-system-prompt');
    const candsFor = targetId => (D?.candidates || []).filter(c => c.kind === 'global-wiki-candidate-v1' && c.targetId === targetId);
    const activeCands = () => (D?.candidates || []).filter(c => c.kind === 'global-wiki-candidate-v1' && c.status !== 'deprecated');
    const pendingSuggestions = () => (D?.suggestions || []).filter(s => s.status === 'pending');
    const rawPending = () => (D?.cases || []).filter(c => ['pending', 'pending-preclassification'].includes(caseState(c).status));
    const preclassificationPending = () => (D?.cases || []).filter(c => c.split === null);
    const suggestionFor = c => pendingSuggestions().filter(s => s.caseId === c.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    function derive() {
      caseById = new Map((D?.cases || []).map(c => [c.id, c])); caseByN = new Map((D?.cases || []).map((c, i) => { c.n = c.displayNumber || i + 1; return [c.n, c]; }));
      stateByCase = new Map((D?.caseStates || []).map(s => [s.caseId, s])); entryById = new Map(entries().map((e, i) => { e.n = i + 1; return [e.id, e]; }));
      replayBySource = new Map((D?.replayCases || []).map(r => [r.sourceCaseId, r])); targetById = new Map((D?.targets || []).map(t => [t.id, t]));
      if (!entryById.has(state.entryId)) state.entryId = entries()[0]?.id || '';
      if (!targetById.has(state.targetId)) state.targetId = globalTarget()?.id || D?.targets[0]?.id || '';
    }
    function caseState(c) {
      if (c.split === null) return { caseId: c.id, status: 'pending-preclassification', memberships: [], reason: '', updatedAt: c.createdAt };
      const classification = stateByCase.get(c.id); if (c.preclassification && classification) return classification;
      if (c.split !== 'train') return { caseId: c.id, status: 'holdout', memberships: [], reason: `${SPLIT[c.split]}用例不参与归纳`, updatedAt: c.createdAt };
      const saved = stateByCase.get(c.id); if (saved) return saved;
      const memberships = (latestVersion()?.entries || []).filter(e => e.status === 'approved' && e.caseIds.includes(c.id)).map(e => ({ entryId: e.id, source: 'version', at: e.reviewedAt || latestVersion().createdAt }));
      return { caseId: c.id, status: memberships.length ? 'assigned' : 'pending', memberships, reason: '', updatedAt: c.createdAt };
    }
    const stateText = c => { const s = caseState(c); if (s.status === 'assigned') return `归入 ${s.memberships.map(m => entryChip(m.entryId)).join('、')}`; return { holdout: `${SPLIT[c.split]}，不参与归纳`, 'pending-preclassification': '待预分类', 'classification-pending': '归类待确认', 'classification-confirmed': '归类已确认', pending: '待归纳', suggested: '待归纳，有建议', unfit: '未能归类' }[s.status] || s.status; };
    function nextStep() {
      if (!D) return { text: '正在读取真实数据…', hash: 'wiki' };
      const draft = entries().find(e => e.status === 'draft'); if (draft) return { text: `审核知识库里的草稿模式「${draft.title}」`, hash: draft.id };
      const global = globalTarget(), globalDraft = (D.candidates || []).find(c => c.targetId === global?.id && c.status === 'draft');
      if (globalDraft) return { text: '确认全局提示词候选，然后开始对照评测', hash: 'targets', target: global.id };
      const suggested = pendingSuggestions().find(s => s.kind === 'assign'); if (suggested) return { text: '确认或调整模型给出的用例归属建议', hash: 'case-' + caseById.get(suggested.caseId)?.n };
      if (preclassificationPending().length) return { text: `预分类 ${preclassificationPending().length} 条新用例，然后按模式配额定组`, hash: 'cases', group: 'inbox' };
      if (rawPending().length) return { text: `用模型归纳 ${rawPending().length} 条待归纳用例；结果只保存为建议`, hash: 'cases', group: 'inbox' };
      if (!(D.comparisons || []).length) return { text: '查看评测计划与演进记录', hash: 'impact' };
      return { text: '查看逐题对照结果和演进记录', hash: 'impact' };
    }
    function toast(text) { const el = $('#toast'); el.textContent = text; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3600); }
    function go(hash) { if (!D) return; location.hash = hash; applyHash(); }
    function applyHash() {
      if (!D) return;
      const h = decodeURIComponent(location.hash.slice(1));
      if (VIEWS.includes(h)) state.view = h;
      else if ((D.versions || []).some(v => v.entries.some(e => e.id === h))) { state.view = 'wiki'; state.entryId = h; }
      else if (/^case-\d+$/.test(h) && caseByN.has(Number(h.slice(5)))) { Object.assign(state, { view: 'cases', casesQ: '', casesGroup: 'all', casesSplit: 'all', casesReplay: false, focusCase: Number(h.slice(5)) }); $('#cases-q').value = ''; }
      else state.view = 'wiki';
      render();
    }
    function renderHeader() {
      $('#cnt-cases').textContent = D ? `${D.cases.length} 条` : '—';
      $('#cnt-wiki').textContent = D ? `${entries().length} 条模式` : '—';
      $('#cnt-targets').textContent = D ? `${activeCands().length} 个候选` : '—';
      $('#cnt-impact').textContent = D ? `${(D.comparisons || []).length} 次评测${D.executions?.length ? ` · ${D.executions.length} 次命令执行` : ''}` : '—';
      $$('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === state.view)));
      const step = nextStep(); $('#next-text').textContent = step.text; const button = $('#next-go'); button.dataset.go = step.hash;
      if (step.target) button.dataset.target = step.target; else delete button.dataset.target;
      if (step.group) button.dataset.group = step.group; else delete button.dataset.group;
    }
    function render() {
      clearTimeout(progressTimer);
      renderHeader(); VIEWS.forEach(view => { $('#view-' + view).hidden = view !== state.view; });
      if (!D) { $('#wiki-list').innerHTML = ''; $('#wiki-page').innerHTML = '<p class="muted-note">尚未读取知识库。</p>'; $('#wiki-inbox').innerHTML = ''; $('#wiki-coverage').innerHTML = ''; return; }
      ({ wiki: renderWiki, cases: renderCases, targets: renderTargets, impact: renderImpact })[state.view](); controls();
      if (state.view === 'impact') scheduleProgress();
    }
    /* Knowledge base */
    function wikiMatch(entry, ts) {
      if (!ts.length) return { ok: true, why: [] };
      const fields = [['标题', entry.title], ['失败模式', entry.failureMode], ['症状', entry.symptoms], ['根因', entry.rootCauseHypothesis], ['准则', entry.guideline]]
        .concat(entry.caseIds.map(id => { const c = caseById.get(id); return [`用例 #${c?.n || '?'}`, `${c?.actual || ''} ${c?.expected || ''}`]; }));
      const has = (value, term) => String(value).toLowerCase().includes(term);
      const ok = ts.every(t => fields.some(([, value]) => has(value, t)));
      return { ok, why: ok ? fields.filter(([, value]) => ts.some(t => has(value, t))).map(([key]) => key) : [] };
    }
    function evidenceIds(entry) {
      const ids = new Set(entry.caseIds);
      if (currentVersion()?.id === latestVersion()?.id) for (const c of D.cases.filter(c => c.split === 'train')) for (const m of caseState(c).memberships || []) if (m.entryId === entry.id) ids.add(c.id);
      return [...ids];
    }
    const replaysFor = entry => (D.replayCases || []).filter(r => evidenceIds(entry).includes(r.sourceCaseId));
    const candsUsing = entryId => (D.candidates || []).filter(c => c.kind === 'global-wiki-candidate-v1' && c.entryIds.includes(entryId));
    const suggestionsFor = entryId => pendingSuggestions().filter(s => s.kind === 'assign' && s.entryId === entryId && caseById.get(s.caseId)?.split === 'train');
    function inboxBox() {
      const proposals = entries().filter(e => e.status === 'draft' && (e.suggestionIds || []).some(id => pendingSuggestions().some(s => s.id === id && s.kind === 'new')));
      const assign = pendingSuggestions().filter(s => s.kind === 'assign' && caseById.get(s.caseId)?.split === 'train'), raw = rawPending(), unfit = D.cases.filter(c => caseState(c).status === 'unfit');
      const items = [
        ...proposals.map(e => `<li><a href="#${esc(e.id)}" data-entry="${esc(e.id)}">新模式提议：${esc(e.title)}</a><span>待审核</span></li>`),
        ...assign.map(s => { const c = caseById.get(s.caseId), e = entryById.get(s.entryId); return `<li><a href="#case-${c?.n}" data-case="${c?.n}">用例 #${c?.n} 建议归入${e ? `模式 ${e.n}` : '已有模式'}</a><span>待确认</span></li>`; }),
        ...D.cases.filter(c => caseState(c).status === 'classification-pending').map(c => `<li><a href="#case-${c.n}" data-case="${c.n}">用例 #${c.n} 归类待确认（${SPLIT[c.split]}）</a><span>只确认归类</span></li>`),
        raw.length ? `<li><a href="#cases" data-group="inbox">${preclassificationPending().length ? `${preclassificationPending().length} 条待预分类` : `${raw.length} 条新用例还没归纳`}</a><span>${preclassificationPending().length ? '待预分类' : '待归纳'}</span></li>` : '',
        unfit.length ? `<li><a href="#cases" data-group="unfit">${unfit.length} 条未能归类</a><span>可手动归入</span></li>` : '',
      ].join('');
      if (!items) return '';
      return `<div class="inbox-head"><h4>待你处理</h4></div><ul>${items}</ul><button type="button" class="btn small" data-induct ${!raw.length || pending || !writable ? 'disabled' : ''}>${preclassificationPending().length ? '预分类并定组' : '用模型归纳新用例'}</button><p class="inbox-note">先预分类、按模式配额定组并冻结。门槛/测试只确认归类，不参与归纳。归纳只提建议：归入已有模式、提议新模式，或标为未能归类。你确认后才生效，已审核的模式不会被改写。</p>`;
    }
    function renderWiki() {
      const ts = terms(state.wikiQ), counts = { all: entries().length, approved: 0, draft: 0, rejected: 0 };
      entries().forEach(e => { counts[e.status] = (counts[e.status] || 0) + 1; });
      $('#wiki-seg').innerHTML = [['all', '全部'], ['approved', '已通过'], ['draft', '草稿'], ['rejected', '已驳回']].map(([key, label]) => `<button type="button" role="radio" data-wiki-status="${key}" aria-checked="${state.wikiStatus === key}">${label} ${counts[key] || 0}</button>`).join('');
      const rows = entries().filter(e => state.wikiStatus === 'all' || e.status === state.wikiStatus).map(e => ({ e, m: wikiMatch(e, ts) })).filter(r => r.m.ok);
      if (rows.length && !rows.some(r => r.e.id === state.entryId)) state.entryId = rows[0].e.id; entryById = new Map(entries().map((e, i) => { e.n = i + 1; return [e.id, e]; }));
      $('#wiki-count').textContent = ts.length ? `找到 ${rows.length} 条模式` : `共 ${rows.length} 条模式 · 版本 ${currentVersion()?.id || '—'}`;
      $('#wiki-list').innerHTML = rows.map(({ e, m }) => { const reps = replaysFor(e).length; return `<li><button type="button" class="entry-item" data-entry="${esc(e.id)}" aria-current="${e.id === state.entryId}"><span class="entry-title">${hl(e.title, ts)}</span><span class="entry-fm">${hl(e.failureMode, ts)}</span><span class="entry-meta">${pill(ENTRY_STATUS, e.status)}<span>${evidenceIds(e).length} 条用例</span><span>${reps ? `${reps} 道回放题` : '无回放题'}</span></span>${m.why.length ? `<span class="why">匹配：${esc(m.why.slice(0, 4).join(' · '))}</span>` : ''}</button></li>`; }).join('') || '<li class="empty-line">没有匹配的模式。换个说法试试，或者到「用例」里搜原话。</li>';
      const hits = ts.length ? D.cases.filter(c => ts.every(t => `${c.actual} ${c.expected} ${c.source.conversationTitle || ''}`.toLowerCase().includes(t))) : [];
      $('#wiki-casehits').hidden = !hits.length; $('#wiki-casehits').innerHTML = hits.length ? `<h4>用例原话里的匹配 · ${hits.length}</h4>` + hits.map(c => `<a href="#case-${c.n}" data-case="${c.n}"><span class="num">#${c.n}</span><span>${hl(c.actual, ts)}</span><span class="sub">${esc(caseState(c).status === 'holdout' ? `${SPLIT[c.split]}，不参与归纳` : caseState(c).status === 'assigned' ? '已归入模式' : caseState(c).status === 'suggested' ? '待归纳，有建议' : caseState(c).status === 'unfit' ? '未能归类' : '待归纳')}</span></a>`).join('') : '';
      $('#wiki-inbox').innerHTML = inboxBox();
      const train = D.cases.filter(c => c.split === 'train'), assigned = train.filter(c => caseState(c).status === 'assigned'), unfit = train.filter(c => caseState(c).status === 'unfit'), inbox = train.filter(c => ['pending', 'suggested'].includes(caseState(c).status));
      $('#wiki-coverage').innerHTML = `<h4>用例归类</h4><ul><li><b>${train.length}</b> 条训练用例，<b>${assigned.length}</b> 条已归入模式</li><li><a href="#cases" data-group="inbox"><b>${inbox.length}</b> 条待归纳</a> · <a href="#cases" data-group="unfit"><b>${unfit.length}</b> 条未能归类</a></li><li><a href="#cases" data-group="holdout"><b>${D.cases.filter(c => c.split === 'test').length}</b> 条测试用例</a>，另有 <b>${D.cases.filter(c=>c.split === 'gate').length}</b> 条门槛用例，均不参与归纳</li></ul><label class="version-picker">查看版本 <select id="wiki-version">${D.versions.map(v => `<option value="${esc(v.id)}" ${v.id === currentVersion()?.id ? 'selected' : ''}>${esc(v.id)} · ${fmt(v.createdAt)}</option>`).join('')}</select></label><p class="ver">${esc(currentVersion()?.model || '未记录模型')} · 已通过条目内容冻结</p>`;
      const entry = entryById.get(state.entryId); $('#wiki-page').innerHTML = entry ? entryPage(entry, ts) : '<p class="muted-note">没有可显示的模式。新用例归纳出的新模式建议会出现在这里。</p>';
    }
    function evidenceRow(c, ts) {
      const replay = replayBySource.get(c.id); return `<li><a class="ev" href="#case-${c.n}" data-case="${c.n}"><span class="num">#${c.n}</span><span class="ev-actual">${hl(c.actual, ts)}</span><span class="ev-exp"><span class="lbl">期望</span>${hl(c.expected, ts)}</span><span class="chips"><span class="chip">${displaySet(c)}</span><span class="chip">来自 ${esc(c.source.conversationTitle || '未命名房间')}</span>${replay ? catChip(replay) : ''}</span></a></li>`;
    }
    function suggestRow(suggestion) {
      const c = caseById.get(suggestion.caseId); if (!c) return '';
      return `<li class="suggest-row">${evidenceRow(c, [])}<p class="suggest"><span class="lbl">理由</span>${esc(explainReason(suggestion.reason))}（把握：${esc(suggestion.confidence)}）</p><div class="row-actions"><button type="button" class="btn small primary" data-confirm-suggestion="${esc(suggestion.id)}">确认归入</button><button type="button" class="btn small" data-reject-suggestion="${esc(suggestion.id)}">不是这里</button></div></li>`;
    }
    function entryPage(entry, ts) {
      const reps = replaysFor(entry), cands = candsUsing(entry.id), suggestions = suggestionsFor(entry.id), proposal = entry.status === 'draft' && (entry.suggestionIds || []).length;
      const ids = evidenceIds(entry), editor = entry.status === 'draft';
      return `<nav class="crumb"><a href="#wiki" data-go="wiki">知识库</a><span aria-hidden="true">›</span><span>${proposal ? '新模式提议' : `模式 ${entry.n} / ${entries().length}`}</span></nav>
        <header class="page-head"><h2>${hl(entry.title, ts)}</h2><div class="page-meta">${pill(ENTRY_STATUS, entry.status)}<span>${esc(currentVersion().id)} 归纳</span>${entry.reviewedAt ? `<span>${fmt(entry.reviewedAt)} 通过审核</span>` : ''}</div>${proposal ? '<p class="muted-note">现有模式解释不了关联用例，所以模型提议新建这一条。通过审核后才能用于候选；确认前不会改变用例归属。</p>' : ''}${editor ? `<div class="page-actions"><button type="button" class="btn primary" data-review="approved">通过</button><button type="button" class="btn" data-review="save">保存草稿</button><button type="button" class="btn ghost" data-review="rejected">驳回</button></div>` : '<p class="muted-note">已审核条目已冻结；增量归纳和手动归属不会改写这条内容。</p>'}</header>
        ${editor ? editForm(entry) : `<dl class="facts"><div><dt>失败模式</dt><dd>${hl(entry.failureMode, ts)}</dd></div><div><dt>典型症状</dt><dd>${hl(entry.symptoms, ts)}</dd></div><div><dt>根因假设</dt><dd>${hl(entry.rootCauseHypothesis, ts)}</dd></div></dl><section class="guideline" aria-label="准则"><h3>准则</h3><p class="hint">${entry.status === 'approved' ? '这句话可以用于生成候选提示词' : '通过审核后，这句话才可以写进候选提示词'}</p><p class="gl-text">${hl(entry.guideline, ts)}</p></section>`}
        <section class="block"><div class="block-head"><h3>证据用例 <span class="count">${ids.length}</span></h3><a class="hint" href="#cases" data-group="${esc(entry.id)}">在用例页按此模式查看</a></div>${ids.length ? `<ul class="evidence">${ids.map(id => caseById.get(id)).filter(Boolean).map(c => evidenceRow(c, ts)).join('')}</ul>` : '<p class="muted-note">还没有确认归属的证据用例。</p>'}</section>
        ${suggestions.length ? `<section class="block"><div class="block-head"><h3>建议加入的用例 <span class="count">${suggestions.length}</span></h3><span class="hint">你确认后才算证据</span></div><ul class="evidence">${suggestions.map(suggestRow).join('')}</ul></section>` : ''}
        <section class="block"><div class="block-head"><h3>回放题 <span class="count">${reps.length}</span></h3><span class="hint">评测时用这些题检验这条准则</span></div>${reps.length ? `<ul class="replays">${reps.map(r => { const c = caseById.get(r.sourceCaseId), totals = comparisonCase(r); return `<li>${catChip(r)}<span class="task">“${esc(r.task)}”<span class="res"> · 用例 #${c?.n} · 本轮${SPLIT[replayStage(r)]}</span></span><span class="res">原版 ${score(totals, 'original')} · 候选 ${score(totals, 'candidate')}</span></li>`; }).join('')}</ul>` : '<p class="muted-note">这个模式还没有回放题，评测暂时验证不了这条准则。</p>'}</section>
        <section class="block"><div class="block-head"><h3>用在哪些候选 <span class="count">${cands.length}</span></h3></div>${cands.length ? `<ul class="uses">${cands.map(c => { const target = targetById.get(c.targetId); return `<li><a href="#targets" data-target="${esc(c.targetId)}">${esc(targetFull(target))}</a>${pill(CAND_STATUS, c.status)}<span class="res">${fmt(c.createdAt)}</span></li>`; }).join('')}</ul>` : '<p class="muted-note">还没有候选用到这条准则。</p>'}</section>`;
    }
    function editForm(entry) {
      const area = (name, label, rows) => `<label class="field">${label}<textarea name="${name}" rows="${rows}" ${pending || !writable ? 'disabled' : ''}>${esc(entry[name])}</textarea></label>`;
      return `<div class="edit-form">${area('title', '标题', 1)}${area('failureMode', '失败模式', 3)}${area('symptoms', '典型症状', 3)}${area('rootCauseHypothesis', '根因假设', 3)}${area('guideline', '准则（不超过 300 字）', 3)}</div>`;
    }
    /* Cases */
    function caseMatch(c, ts) { if (!ts.length) return true; const replay = replayBySource.get(c.id); const hay = [c.actual, c.expected, c.source.conversationTitle || '', replay?.task || '', `#${c.n}`].join(' ').toLowerCase(); return ts.every(t => hay.includes(t)); }
    function inGroup(c, group) { const s = caseState(c); if (group === 'all') return true; if (group === 'inbox') return ['pending', 'suggested', 'pending-preclassification'].includes(s.status); if (group === 'holdout') return ['gate', 'test'].includes(c.split); if (group === 'unfit') return s.status === group; return c.split === 'train' && (s.memberships || []).some(m => m.entryId === group); }
    const STATE_CHIP = { 'pending-preclassification': '<span class="chip pending">待预分类</span>', 'classification-pending': '<span class="chip pending">归类待确认 · 不参与归纳</span>', 'classification-confirmed': '<span class="chip ok">归类已确认 · 不参与归纳</span>', pending: '<span class="chip pending">待归纳</span>', suggested: '<span class="chip pending">待归纳 · 有建议</span>', unfit: '<span class="chip warn">未能归类</span>' };
    function preclassificationLine(c) {
      const p = c.preclassification; if (!p) return '';
      const kind = p.kind === 'assign' ? `归入 ${entryChip(p.entryId)}` : p.kind === 'new' ? '新模式' : '未能归类';
      return `<p class="suggest"><span class="lbl">预分类</span>${kind}。${esc(explainReason(p.reason))}<span class="res"> · 定组已冻结</span></p>`;
    }
    function suggestionLine(c) {
      const s = suggestionFor(c); if (!s) return '';
      const reason = esc(explainReason(s.reason));
      if (s.kind === 'assign') return `<p class="suggest"><span class="lbl">建议</span>归入 ${entryChip(s.entryId)}（把握：${esc(s.confidence)}）。${reason}</p>`;
      if (s.kind === 'new') return `<p class="suggest"><span class="lbl">建议</span>新建模式 ${entryChip(s.entryId)}。${reason}</p>`;
      return `<p class="suggest"><span class="lbl">归纳结果</span>${reason}（把握：${esc(s.confidence)}）</p>`;
    }
    function membershipSource(c) {
      const s = caseState(c);
      if (s.status === 'pending-preclassification') return '待模型预分类，尚无组别';
      if (s.status === 'classification-pending') return '预分类只是建议，归类待确认；不参与归纳';
      if (s.status === 'classification-confirmed' && !s.memberships?.length) return '已确认未归类；不参与归纳';
      if (s.status === 'holdout') return '保留原有固定集合，不参与归纳';
      if (!s.memberships?.length) return s.status === 'suggested' ? '模型建议，待确认' : s.status === 'unfit' ? '模型归纳后未能归类' : '尚未归入模式';
      return s.memberships.map(m => m.source === 'manual' ? `手动调整 · ${fmt(m.at)}` : m.source === 'model-confirmed' ? `模型建议经确认 · ${fmt(m.at)}` : `${latestVersion()?.id || ''} 模型归纳，随模式审核通过`).join('；');
    }
    function manualControls(c) {
      const s = caseState(c); if (['holdout', 'pending-preclassification'].includes(s.status)) return '';
      const selected = s.memberships?.[0]?.entryId || '';
      return `<div class="manual-controls"><select data-manual-entry aria-label="选择归属模式"><option value="">选择已通过模式</option>${approvedEntries().map(e => `<option value="${esc(e.id)}" ${selected === e.id ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select><button type="button" class="btn small" data-manual-assign>${selected ? '改归属' : '手动归入'}</button>${s.memberships?.length || c.split !== 'train' ? '<button type="button" class="btn small ghost" data-manual-remove>清为未归类</button>' : ''}</div>`;
    }
    function caseCard(c, ts) {
      const replay = replayBySource.get(c.id), s = caseState(c), suggestion = suggestionFor(c), owner = s.status === 'assigned' ? s.memberships.map(m => entryChip(m.entryId)).join('') : s.status === 'holdout' ? `<span class="chip holdout">${SPLIT[c.split]} · 不参与归纳</span>` : `${STATE_CHIP[s.status] || ''}${s.status === 'classification-confirmed' ? (s.memberships.length ? s.memberships.map(m => entryChip(m.entryId)).join('') : '<span class="chip">已确认未归类</span>') : ''}`;
      return `<article class="case" id="c-${c.n}"><div class="case-head"><span class="num">#${c.n}</span><h4>${hl(c.actual, ts)}</h4></div><p class="case-exp"><span class="lbl">期望</span>${hl(c.expected, ts)}</p>${preclassificationLine(c)}${suggestionLine(c)}<div class="chips">${owner}<span class="chip">${displaySet(c)}</span><span class="chip">来自 ${hl(c.source.conversationTitle || '未命名房间', ts)}</span>${replay ? catChip(replay) : ''}</div>
        <div class="row-actions">${suggestion && ['assign', 'none'].includes(suggestion.kind) ? `<button type="button" class="btn small primary" data-confirm-suggestion="${esc(suggestion.id)}">${suggestion.kind === 'none' ? '确认未归类' : '确认归入'}</button><button type="button" class="btn small" data-reject-suggestion="${esc(suggestion.id)}">不是这里</button>` : ''}${suggestion?.kind === 'new' ? entryChip(suggestion.entryId) : ''}</div>
        <details class="more"><summary>详情</summary><dl class="kv">${replay ? `<div><dt>回放任务</dt><dd>“${hl(replay.task, ts)}”</dd></div>` : ''}<div><dt>归属来源</dt><dd>${esc(membershipSource(c))}</dd></div><div><dt>标记时间</dt><dd>${fmt(c.createdAt)}</dd></div><div><dt>来源消息</dt><dd class="mono">${esc(c.source.messageId || '未记录')}</dd></div><div><dt>用例 ID</dt><dd class="mono">${esc(c.id)}</dd></div>${replay ? `<div><dt>固定提交</dt><dd class="mono">${esc(replay.fixture.commit)}</dd></div><div><dt>检查点</dt><dd class="mono">${esc(replay.request.association.checkpointId)}</dd></div>` : ''}</dl>${manualControls(c)}${c.message || c.traceExcerpt ? `<details class="more"><summary>来源回复与轨迹摘录</summary><pre class="case-original">${esc(`来源回复${c.messageTruncated ? '（截断）' : ''}：\n${c.message}\n\n轨迹${c.traceTruncated ? '（截断）' : ''}（${c.traceState}）：\n${c.traceExcerpt}`)}</pre></details>` : ''}</details></article>`;
    }
    function renderCases() {
      $('#cases-group').innerHTML = [['all', '全部'], ['inbox', '待归纳'], ...approvedEntries().map(e => [e.id, `模式 ${e.n || ''} · ${e.title}`]), ['holdout', '门槛/测试 · 不参与归纳'], ['unfit', '未能归类']].map(([value, label]) => `<option value="${esc(value)}" ${state.casesGroup === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
      $('#cases-split').value = state.casesSplit; $('#cases-replay').checked = state.casesReplay;
      $('#cases-mode').innerHTML = [['group', '按模式分组'], ['list', '列表']].map(([key, label]) => `<button type="button" role="radio" data-cases-mode="${key}" aria-checked="${state.casesMode === key}">${label}</button>`).join('');
      const ts = terms(state.casesQ), visible = D.cases.filter(c => caseMatch(c, ts) && inGroup(c, state.casesGroup) && (state.casesSplit === 'all' || c.split === state.casesSplit || state.casesSplit === 'unallocated' && c.split === null || state.casesSplit === 'gate' && c.evaluationStage === 'gate') && (!state.casesReplay || replayBySource.has(c.id)));
      const filtered = ts.length || state.casesGroup !== 'all' || state.casesSplit !== 'all' || state.casesReplay;
      const train = D.cases.filter(c => c.split === 'train'), assigned = train.filter(c => caseState(c).status === 'assigned'), unfit = train.filter(c => caseState(c).status === 'unfit'), inbox = train.filter(c => ['pending', 'suggested'].includes(caseState(c).status));
      $('#cases-summary').textContent = `${filtered ? `显示 ${visible.length} / ${D.cases.length} 条 · ` : ''}归纳集合：训练 ${train.length} 条（已归入模式 ${assigned.length}）· 门槛 ${D.cases.filter(c=>c.split === 'gate').length} 条 · 测试 ${D.cases.filter(c=>c.split === 'test').length} 条。本轮回放：门槛 ${D.replayCases.filter(r=>replayStage(r)==='gate').length} 题、测试 ${D.replayCases.filter(r=>replayStage(r)==='test').length} 题；原16条不重新划分。待预分类 ${preclassificationPending().length} 条。待归纳 ${inbox.length} 条、未能归类 ${unfit.length} 条`;
      let html;
      if (state.casesMode === 'list') html = visible.length ? `<div class="case-grid">${visible.map(c => caseCard(c, ts)).join('')}</div>` : '<p class="muted-note">没有符合条件的用例。</p>';
      else {
        const groups = /** @type {any[]} */ ([]);
        groups.push({ key: 'inbox', title: '待预分类 / 待归纳', action: true, keep: true, note: '新标记先待预分类，无组别；模型预分类后按模式配额定组并冻结。训练组建议经你确认才生效；门槛/测试只确认归类。', items: visible.filter(c => inGroup(c, 'inbox')) });
        for (const e of approvedEntries()) groups.push({ key: e.id, title: `模式 ${e.n || ''} · ${e.title}`, link: e.id, items: visible.filter(c => inGroup(c, e.id)) });
        groups.push({ key: 'holdout', title: '门槛/测试 · 不参与归纳', note: '新门槛和测试用例只确认或调整归类，不参与归纳、也不改模式内容。原16条保留既有13训练/3测试；本轮门槛中原有训练题另作标注，不假称未见数据。', items: visible.filter(c => inGroup(c, 'holdout')) });
        groups.push({ key: 'unfit', title: '未能归类', keep: true, note: '归纳过、但不属于任何现有模式的用例。你可以随时手动归入。', items: visible.filter(c => inGroup(c, 'unfit')) });
        const visibleGroups = groups.filter(group => (state.casesGroup === 'all' || state.casesGroup === group.key) && (group.items.length || (group.keep && !filtered)));
        html = visibleGroups.length ? visibleGroups.map(group => `<section class="group"><div class="group-head"><h3>${esc(group.title)}</h3><span class="gcount">${group.items.length} 条</span>${group.link ? `<a href="#${esc(group.link)}" data-entry="${esc(group.link)}">打开模式页</a>` : ''}${group.action ? `<button type="button" class="btn small" data-induct ${!rawPending().length || pending || !writable ? 'disabled' : ''}>${preclassificationPending().length ? '预分类并定组' : '用模型归纳新用例'}</button>` : ''}</div>${group.note ? `<p class="group-note">${esc(group.note)}</p>` : ''}${group.items.length ? `<div class="case-grid">${group.items.map(c => caseCard(c, ts)).join('')}</div>` : ''}</section>`).join('') : '<p class="muted-note">没有符合条件的用例。</p>';
      }
      $('#cases-body').innerHTML = html;
      if (state.focusCase) { const el = $('#c-' + state.focusCase); state.focusCase = null; if (el) { el.scrollIntoView({ block: 'center', behavior: 'auto' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1900); } }
    }
    /* Optimization targets */
    function candidateCard(candidate, target) {
      const deprecated = candidate.status === 'deprecated', confirmed = candidate.status === 'confirmed', isGlobal = target.kind === 'global-system-prompt';
      const sources = candidate.entryIds.map(id => findEntry(id, candidate.versionId)).filter(x => x.entry);
      const foot = deprecated ? `<button type="button" class="btn" data-confirm-candidate="${esc(candidate.id)}" disabled>已废弃，不能确认</button>` : `<button type="button" class="btn primary" data-confirm-candidate="${esc(candidate.id)}" ${confirmed || pending || !writable ? 'disabled' : ''}>${confirmed ? '已确认' : '确认此候选'}</button><p>${isGlobal ? `确认后由操作方启动对照，每题原版本和候选各跑 10 次真实模型、交替执行。先跑门槛 #1/#2/#6/#16，接受才跑测试 #4/#10/#14；拒绝则不跑测试。结果记入评测记录，不修改生产提示词。` : '工具描述的候选本期只展示，确认后不会自动评测，也不会修改生产配置。'}</p>`;
      return `<section class="cand${deprecated ? ' is-dep' : ''}"><header class="cand-head"><h3>候选</h3>${pill(CAND_STATUS, candidate.status)}<time>${fmt(candidate.createdAt)} 生成</time></header>${deprecated ? `<p class="dep-note">${candidate.deprecationReason === 'multiple_patterns' ? '旧稿合并了多个模式的准则；本轮一次只改一个模式，旧稿已废弃。' : '目标选错了：list_rooms 是列出房间的工具，和“汇报先给结论”这类准则无关。'}原文、diff 和记录保留，不能确认。</p>` : ''}<p class="basis">依据 ${sources.length} 条模式 ${sources.map(({ entry, version }) => entryChip(entry.id, version.id)).join('')}</p><div class="compare"><details class="orig"><summary>原文 ${[...(candidate.target?.baseText || target.baseText || '')].length} 字 · 不改动（展开查看）</summary><pre class="text">${esc(candidate.target?.baseText || target.baseText || '')}</pre></details><div class="added"><h4>在原文末尾新增 ${sources.length} 条准则</h4><ol>${sources.map(({ entry, version }) => `<li><p>${esc(entry.guideline)}</p><a class="src-link" href="#${esc(entry.id)}" data-entry="${esc(entry.id)}" data-version="${esc(version.id)}">来自模式 ${(version.entries.findIndex(e => e.id === entry.id) + 1)} · ${esc(entry.title)}</a></li>`).join('')}</ol></div></div><footer class="cand-foot">${foot}</footer><details class="more"><summary>技术详情</summary><dl class="kv"><div><dt>候选 ID</dt><dd class="mono">${esc(candidate.id)}</dd></div><div><dt>来源版本</dt><dd class="mono">${esc(candidate.versionId)}</dd></div><div><dt>内容 hash</dt><dd class="mono">${esc(candidate.candidateHash)}</dd></div></dl></details></section>`;
    }
    function renderTargets() {
      const rank = target => { const cs = candsFor(target.id); return cs.some(c => c.status !== 'deprecated') ? 0 : cs.length ? 1 : 2; };
      const item = target => { const cs = candsFor(target.id), live = cs.filter(c => c.status !== 'deprecated').length; return `<button type="button" class="titem" data-target="${esc(target.id)}" aria-current="${target.id === state.targetId}"><span class="tname">${esc(targetLabel(target))}</span><span class="tlen">原文 ${[...(target.baseText || '')].length} 字${cs.length ? ` · ${cs.length} 个候选` : ''}</span>${live ? '<span class="pill warn">待确认</span>' : cs.length ? '<span class="pill">已废弃</span>' : ''}</button>`; };
      $('#targets-list').innerHTML = [['global-system-prompt', '全局系统提示词'], ['tool-description', '工具描述']].map(([kind, label]) => `<div class="tgroup"><h4>${label}</h4>${D.targets.filter(t => t.kind === kind).sort((a, b) => rank(a) - rank(b)).map(item).join('')}</div>`).join('') + '<p class="side-note">每个候选只改一个对象，其余提示词、角色和工具保持不变。</p>';
      const target = targetById.get(state.targetId) || D.targets[0]; if (!target) { $('#target-page').innerHTML = '<p class="muted-note">尚未声明优化对象。</p>'; return; }
      const candidates = candsFor(target.id).sort((a, b) => Number(a.status === 'deprecated') - Number(b.status === 'deprecated'));
      const about = target.kind === 'global-system-prompt' ? '所有 agent 每一轮都会读到这段话，改动会影响所有角色。' : 'agent 决定要不要、怎么调用这个工具时，会读这段说明。';
      $('#target-page').innerHTML = `<nav class="crumb"><a href="#targets" data-go="targets">优化对象</a><span aria-hidden="true">›</span><span>${target.kind === 'global-system-prompt' ? '全局系统提示词' : '工具描述'}</span></nav><header class="page-head"><h2>${esc(targetFull(target))}</h2><p class="lede">${about}</p></header>${candidates.length ? candidates.map(c => candidateCard(c, target)).join('') : '<p class="muted-note">还没有候选。从知识库里选已通过的模式，就能为它生成一份候选。</p>'}
        <details class="generator"><summary data-show-generator>从已通过的模式生成候选</summary><p class="hint">一次只选一个已通过模式，准则原样追加到当前对象。生成草稿不会调用模型、启动评测或修改生产配置。</p><div class="entry-picker">${approvedEntriesForSelection().map(e => `<label><input type="radio" name="candidate-pattern" data-candidate-entry="${esc(e.id)}"><span><b>${esc(e.title)}</b><br><span class="hint">${esc(e.guideline)}</span></span></label>`).join('') || '<p class="muted-note">当前版本没有已通过模式。</p>'}</div><div><button type="button" class="btn" data-generate-candidate disabled>生成候选草稿</button></div></details>`;
    }
    function approvedEntriesForSelection() { return entries().filter(e => e.status === 'approved'); }
    /* Evaluation and evolution */
    function renderExecutionProgress() {
      const records = D?.executions || [];
      $('#execution-progress').innerHTML = `<h2>命令执行进度</h2><p class="hint">由受信命令启动，页面只读；每5秒更新此区域，不会启动模型或覆盖知识库编辑。${progressError ? '进度更新失败，以下保留最后一次记录，请核对命令输出。' : ''}</p>${records.length ? records.map(r => {
        const s = r.summary, config = r.plan.modelConfig, original = r.plan.variants.length === 1;
        const source = D.cases.find(c => c.sealedCheckpointId && c.sealedCheckpointId === r.plan.checkpointId);
        const caseLabel = source ? `用例 #${source.n} · ${source.actual}` : `封存 ${r.plan.caseId || '未关联'}`;
        const stale = r.status === 'running' && Date.now() - new Date(r.updatedAt).getTime() > 20000;
        const label = { running: '执行中', completed: '执行完成', stopped: '执行未完成', failed: '执行失败' }[r.status] || '状态未知';
        return `<section class="command-execution"><h3>${esc(label)} · 已记录 ${s.completedRuns}/${s.plannedRuns} 次</h3><p>${esc(caseLabel)}</p><p>${esc(r.plan.model)}${config ? ` · thinking ${esc(config.thinking)} · ${esc(config.transport)} · Fast关闭` : ''}</p><p>${original ? '原版回放，不产生采纳结论。' : '字面对照观察，不是正式门槛采纳结论。'}${r.current ? ` 当前：${r.current.variant === 'original' ? '原版' : '候选'}第 ${esc(r.current.iteration)} 次。` : ''}</p>${stale ? '<p class="hint">进度心跳已过期，可能中断；不据此判模型失败，不自动重跑。</p>' : ''}<p class="hint">最后更新 ${esc(fmt(r.updatedAt))}；账号剩余额度未知。已知token ${s.knownTokens == null ? '未知' : esc(s.knownTokens)}${s.usageComplete ? '' : '（可能不完整）'}，含缓存及重复上下文。</p><ul>${r.plan.variants.map(v => { const t = s.totals[v]; return `<li>${v === 'original' ? '原版' : '候选'}：字面规则通过 ${t.passed}/${t.planned}，不通过 ${t.failed}，环境错误 ${t.errors}，未完成 ${t.notRun}</li>`; }).join('')}</ul><details><summary>执行标识</summary><p class="mono">${esc(r.id)}</p>${r.reason ? `<p>${esc(r.reason)}</p>` : ''}</details></section>`;
      }).join('') : '<p class="hint">尚无命令执行记录；页面加载不会启动评测。</p>'}`;
    }
    function scheduleProgress() {
      clearTimeout(progressTimer);
      if (state.view === 'impact' && D) progressTimer = setTimeout(async () => { await refreshExecutions(); scheduleProgress(); }, 5000);
    }
    async function refreshExecutions() {
      if (!D || progressPending) return;
      const seq = generation; progressPending = true;
      try {
        const response = await fetchJson('/api/wikiskill/executions');
        if (!Array.isArray(response?.executions)) throw Error('invalid_execution_response');
        if (seq === generation && D) { D.executions = response.executions; progressError = false; renderExecutionProgress(); }
      } catch { if (seq === generation && D) { progressError = true; renderExecutionProgress(); } }
      finally { progressPending = false; }
    }
    function comparisonOrder() { return (D?.comparisons || []).slice().sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id))); }
    function latestComparison() { return comparisonOrder().at(-1) || null; }
    function selectedComparison() { return (D?.comparisons || []).find(r=>r.id===state.comparisonId) || latestComparison(); }
    function interruptedComparison(result) { return result?.completed===false && (result.cases || []).some(c=>c.reason==='operator_interrupted' || (c.runs || []).some(r=>r.reason==='operator_interrupted')); }
    function executionLabel(result) { return `执行 ${comparisonOrder().findIndex(r=>r.id===result.id)+1}`; }
    function comparisonHistory(selected) {
      return `<div class="comparison-history" aria-label="独立执行记录">${comparisonOrder().reverse().map(result=>`<button type="button" class="btn small" data-comparison="${esc(result.id)}" aria-pressed="${result.id===selected?.id}" title="${esc(result.executionId || result.id)}">${executionLabel(result)} · ${interruptedComparison(result)?'中断，不计入判定':result.completed?'完整执行':'执行不完整'} · ${fmt(result.createdAt)}</button>`).join('')}</div>`;
    }
    function comparisonCase(replay) { const result = latestComparison(); return result?.cases.find(c => c.sourceCaseId === replay.sourceCaseId) || null; }
    function score(record, variant) { const t = record?.totals?.[variant]; return t ? `${t.passed}/${t.planned}` : '—/10'; }
    function scoreCell(record, variant) { const t = record?.totals?.[variant]; if (!t) return '<span class="pending">—/10</span>'; return `${t.passed}/${t.planned}${t.failed ? `<span class="run-issues">不通过 ${t.failed}</span>` : ''}${t.errors ? `<span class="run-issues">错误 ${t.errors}</span>` : ''}${t.notRun ? `<span class="run-issues">未运行 ${t.notRun}</span>` : ''}`; }
    const outcomeText = value => ({accepted:'接受',rejected:'拒绝',indeterminate:'无法判定'}[value] || '待运行');
    function decisionText(d, interrupted = false) {
      if (!d) return '<p class="hint">门槛尚未运行：修好与无误伤同时满足才接受；探针和其他模式只报告。</p>';
      const pair = t => `原版 ${t.original.passed}/${t.original.total}，候选 ${t.candidate.passed}/${t.candidate.total}`;
      return `<section class="gate-decision"><h3>${interrupted?'中断观察（不计入正式判定）':'门槛判定：'+outcomeText(d.outcome)}</h3><p>修好：${pair(d.repair)}；单侧 Fisher p=${d.repair.pValue == null ? 'N/A' : esc(Number(d.repair.pValue).toPrecision(4))}，要求 p&lt;0.05，${d.repair.passed?'满足':'不满足'}。</p><p>无误伤：${pair(d.noHarm)}；少通过 ${d.noHarm.loss} 次，允许少通过 ${d.noHarm.allowedLoss} 次，${d.noHarm.passed?'满足':'不满足'}。</p><p class="hint">只有目标模式的门槛复现题计入修好，门槛中全部防误伤题计入无误伤。门槛有题未补齐则无法判定，不运行测试。</p></section>`;
    }
    function stageSummary(totals) {
      if (!totals) return '<p class="hint">尚无本阶段的正式统计。</p>';
      return `<div class="stage-rates">${['original','candidate'].map(v=>{const t=totals[v];return `<p><b>${v==='original'?'原版':'候选'}</b> ${t.passed}/${t.planned} 通过 · 不通过 ${t.failed} · 错误 ${t.errors} · 未运行 ${t.notRun}；有效 ${t.scored}，通过率 ${t.passRate==null?'N/A':(100*t.passRate).toFixed(1)+'%'}</p>`;}).join('')}</div>`;
    }
    function renderImpact() {
      renderExecutionProgress();
      const order = { reproduction: 0, probe: 1, control: 2 }, result = selectedComparison();
      const reps = D.replayCases.slice().sort((a, b) => order[a.category] - order[b.category] || caseById.get(a.sourceCaseId).n - caseById.get(b.sourceCaseId).n);
      const global = globalTarget(), ready = (D.candidates || []).find(c => c.targetId === global?.id && c.status === 'draft');
      const stages = ['gate','test'].map(stage=>{
        const selected = reps.filter(r=>replayStage(r)===stage), d=result?.gateDecision;
        const rows=selected.map(replay=>{const c=caseById.get(replay.sourceCaseId),s=caseState(c),record=result?.cases.find(r=>r.sourceCaseId===replay.sourceCaseId);const owner=s.memberships?.length?s.memberships.map(m=>entryChip(m.entryId, undefined, true)).join(' '):'<span class="chip">不参与归纳</span>';return `<tr><td>“${esc(replay.task)}” <a href="#case-${c.n}" data-case="${c.n}" class="res">用例 #${c.n}</a></td><td>${catChip(replay)}</td><td>${owner}</td><td class="n">${scoreCell(record,'original')}</td><td class="n">${scoreCell(record,'candidate')}</td></tr>`;}).join('');
        const note=stage==='gate'?'先执行；每题原/候选各10次有效，交替执行。':d?.outcome==='rejected'?'门槛拒绝，测试未运行。':d?.outcome==='indeterminate'?'门槛无法判定，测试未运行。':'只有门槛接受后才执行一次；每题原/候选各10次有效。';
        return `<section class="evaluation-stage" data-evaluation-stage="${stage}"><h3>${SPLIT[stage]} · ${selected.length} 题</h3><p class="hint">${note}</p><div class="table-wrap"><table class="runs"><thead><tr><th>回放题</th><th>类型</th><th>对应模式</th><th class="n">原版通过/计划</th><th class="n">候选通过/计划</th></tr></thead><tbody>${rows}</tbody></table></div>${stageSummary(result?.byStage?.[stage])}</section>`;
      }).join('');
      $('#impact-runs').innerHTML = `${comparisonHistory(result)}${!result ? `<div class="empty-state"><p><b>还没有评测结果。</b>${ready ? '请确认全局提示词候选；每题每版10次，先跑门槛，接受才跑测试。' : '确认候选后由操作方执行；页面加载不会启动评测。'}</p>${ready ? `<button type="button" class="btn small" data-go="targets" data-target="${esc(global.id)}">去确认候选</button>` : ''}</div>` : `<p class="hint">${esc(result.createdAt)} · ${esc(result.model)} · 已记录 ${result.modelCallsKnown} 次模型请求。${result.completed ? '完整执行；仅使用本次执行的结果，不拼接其他执行；不表示获准采纳。' : interruptedComparison(result) ? '中断，不计入判定；以下仅为中断时的观察，保留记录，不与重跑结果拼接。' : '执行不完整；错误和未运行不算通过。'}${!result.evaluation?' 此为历史结果，不是本轮两阶段评测。':''}</p>`}${decisionText(result?.gateDecision, interruptedComparison(result))}${stages}<ul class="legend"><li><b>复现题</b>目标模式的门槛复现题检验能否修好</li><li><b>探针题</b>只报告，不影响判定</li><li><b>防误伤题</b>原版本来做得对，看候选会不会改坏</li><li><b>错误与未运行</b>环境错误每题两版共最多补5次；模型循环、超时或超调用上限计不通过，补不齐则无法判定</li><li><b>解读边界</b>代理模型 DeepSeek、小样本、原基线筛题有挑题偏差；只复现了汇报难懂一类，不作为采纳依据，不保证提分。</li></ul>`;
      renderTimeline();
    }
    function renderTimeline() {
      const events = [], byCat = key => D.replayCases.filter(r => r.category === key).length;
      if (D.cases.length) events.push({ at: latest(D.cases.map(c => c.createdAt)), kind: '用例', text: `保存 ${D.cases.length} 条真实用例` });
      // Read-only policy history: keep the original adoption date, explicitly
      // supersede the hash policy, and date the current D15 to its acceptance.
      events.push({ at: '2026-11-01T13:22:28.080Z', kind: '规则', text: '旧规则（2026-11-02已被取代）：新标记用例按固定 hash 分训练50%/门槛25%/测试25%；现有16条保持原集合，不追溯重分。' });
      events.push({ at: '2026-11-02T07:03:20.095Z', kind: '规则', text: '现行规则：新标记先待预分类，再按模式配额定组（训练50%/门槛25%/测试25%）；同缺按训练→门槛→测试，组别冻结，现有16条不重分。' });
      if (D.replaySplit) events.push({ at: D.replaySplit.createdAt, kind: '划分', text: `原16条的固定测试集 ${D.cases.filter(c => c.split === 'test').map(c => '#' + c.n).join(' ')} 不参与归纳；其余保留原训练集合` });
      for (const version of D.versions) events.push({ at: version.createdAt, kind: '知识库', text: `${version.id}：从 ${version.caseIds.length} 条训练用例归纳出 ${version.entries.length} 条模式，未归类 ${version.unclassified.length} 条` });
      if (D.replayCases.length) events.push({ at: latest(D.replayCases.map(r => r.createdAt)), kind: '回放题', text: `封存 ${D.replayCases.length} 道回放题（复现 ${byCat('reproduction')} · 探针 ${byCat('probe')} · 防误伤 ${byCat('control')}）` });
      for (const version of D.versions) for (const entry of version.entries.filter(e => e.reviewedAt)) events.push({ at: entry.reviewedAt, kind: '审核', text: `模式「${entry.title}」${entry.status === 'approved' ? '通过审核' : '已驳回'}` });
      for (const candidate of D.candidates.filter(c => c.kind === 'global-wiki-candidate-v1')) { const target = targetById.get(candidate.targetId); events.push({ at: candidate.createdAt, kind: '候选', text: `生成候选：${targetFull(target)}（${candidate.entryIds.length} 条准则）` }); if (candidate.confirmedAt) events.push({ at: candidate.confirmedAt, kind: '确认', text: `确认候选：${targetFull(target)}` }); if (candidate.deprecatedAt) events.push({ at: candidate.deprecatedAt, kind: '废弃', text: `废弃${candidate.deprecationReason==='multiple_patterns'?'合并多模式':'用途不符'}的候选：${targetFull(target)}` }); }
      for (const result of D.comparisons || []) {
        const label=executionLabel(result), interrupted=interruptedComparison(result);
        if (interrupted) events.push({at:result.createdAt,kind:'中断',text:`${label}：中断，不计入判定；记录保留，不与完整重跑拼接。`});
        else if (result.gateDecision) events.push({ at:result.createdAt,kind:'门槛判定',text:`${label}：门槛判定：${outcomeText(result.gateDecision.outcome)}；修好${result.gateDecision.repair.passed?'满足':'不满足'}、无误伤${result.gateDecision.noHarm.passed?'满足':'不满足'}。候选和 diff 保留，不自动采纳。` });
        for (const stage of ['gate','test']) {const t=result.byStage?.[stage];if(t)events.push({at:result.createdAt,kind:interrupted?'中断观察':'评测',text:`${label} · ${SPLIT[stage]}${interrupted?'观察（不计入判定）':'结果'}：原版 ${t.original.passed}/${t.original.planned}，候选 ${t.candidate.passed}/${t.candidate.planned}；错误 ${t.original.errors}/${t.candidate.errors}，未运行 ${t.original.notRun}/${t.candidate.notRun}`});}
        if (!result.byStage) events.push({at:result.createdAt,kind:'历史评测',text:`${label}：历史单阶段结果已保存，不作为本轮两阶段判定。`});
      }
      const explicit = new Set();
      for (const event of D.events || []) {
        if (event.runId) explicit.add(event.runId);
        const caseNumbers = (event.caseIds || []).map(id => caseById.has(id) ? '#' + caseById.get(id).n : '已作废用例').join(' ');
        if (event.type === 'case-mark-voided') events.push({ at: event.createdAt, kind: '误标作废', text: `误标作废 ${caseNumbers}：${event.reason || ''}；保留旧版本，组别不重分。` });
        const labels = { 'case-marked': ['标记', `新用例已入库 ${caseNumbers}（${event.split == null ? '待预分类' : '保留原定组'}）`], 'case-preclassified': ['定组', `预分类并冻结 ${caseNumbers} · ${SPLIT[event.split] || ''}`], 'preclassification-run': ['预分类', `模型完成预分类 ${caseNumbers}；归类待确认`], 'classification-confirmed': ['归类', `已确认归类 ${caseNumbers}（不参与归纳）`], 'classification-rejected': ['归类', `否决预分类归属 ${caseNumbers}（可改归类）`], 'induction-run': ['归纳', `模型完成一次增量归纳 ${caseNumbers}；只保存建议`], 'suggestion-confirmed': ['归属', `确认模型建议 ${caseNumbers}`], 'suggestion-rejected': ['归属', `否决模型建议 ${caseNumbers}`], 'manual-assigned': ['归属', `手动归入模式 ${caseNumbers}`], 'manual-removed': ['归属', `手动移出模式 ${caseNumbers}`] };
        const label = labels[event.type]; if (label) events.push({ at: event.createdAt, kind: label[0], text: label[1] });
      }
      for (const run of D.inductionRuns || []) if (!explicit.has(run.id)) events.push({ at: run.createdAt, kind: '归纳', text: `模型完成一次增量归纳（${run.caseIds.length} 条用例）；只保存建议` });
      events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      $('#impact-log').innerHTML = `<li class="now"><time>现在</time><span><span class="kind">等待</span>${esc(nextStep().text)}</span></li>` + events.map(event => `<li><time>${fmt(event.at)}</time><span><span class="kind">${esc(event.kind)}</span>${esc(event.text)}</span></li>`).join('');
    }
    /* API and controls */
    function accept(data) {
      if (!data || data.scope !== 'global' || data.projectId !== undefined || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || !Array.isArray(data.cases) || !Array.isArray(data.versions)) throw Error('invalid_wiki_response');
      D = data; writable = true;
      if (!D.versions.some(v => v.id === versionId)) versionId = D.versions.at(-1)?.id || '';
      derive(); render();
    }
    function controls() {
      root.setAttribute('aria-busy', String(pending));
      $$('[data-induct]').forEach(button => { button.disabled = pending || !writable || !rawPending().length; });
      $$('[data-confirm-suggestion],[data-reject-suggestion],[data-manual-assign],[data-manual-remove],[data-review],[data-generate-candidate]').forEach(button => { button.disabled = pending || !writable || (button.hasAttribute('data-generate-candidate') && $$('[data-candidate-entry]:checked').length !== 1); });
      $$('[data-confirm-candidate]').forEach(button => { const candidate = D?.candidates.find(c => c.id === button.dataset.confirmCandidate); button.disabled = pending || !writable || candidate?.status !== 'draft'; });
      $$('.edit-form textarea').forEach(input => { input.disabled = pending || !writable; });
      $('#wsk-refresh').disabled = pending;
    }
    async function load() {
      const seq = ++generation; D = null; writable = false; pending = true; derive(); render(); controls();
      try { const data = await fetchJson('/api/wikiskill'); if (seq !== generation) return; accept(data); toast('已读取真实数据；页面刷新不会调用模型。'); }
      catch { if (seq === generation) toast('读取失败；未修改 Wiki。'); }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function mutate(url, body, success) {
      if (pending || !writable) return;
      const seq = generation, expectedRevision = D.revision; pending = true; controls();
      try { const data = await fetchJson(url, { method: 'POST', body: { confirmed: true, expectedRevision, ...body } }); if (seq !== generation) return; accept(data); toast(success); }
      catch { if (seq === generation) { writable = false; toast('操作被拒绝、失败或结果未知；未自动重试，请刷新核对。'); } }
      finally { if (seq === generation) { pending = false; controls(); } }
    }
    async function review(entry, decision) {
      if (entry.status !== 'draft' || pending || !writable) return;
      const patch = {};
      for (const field of ['title', 'failureMode', 'symptoms', 'rootCauseHypothesis', 'guideline']) patch[field] = root.querySelector(`[name="${field}"]`)?.value ?? entry[field];
      if (!patch.guideline.trim() || [...patch.guideline].length > 300) { toast('准则须为 1–300 字。'); return; }
      if (decision !== 'save' && !confirmAction(`确认${decision === 'approved' ? '通过' : '驳回'}「${patch.title}」？审核后内容冻结。`)) return;
      await mutate('/api/wikiskill/review', { versionId: currentVersion().id, entryId: entry.id, patch, ...(decision === 'save' ? {} : { decision }) }, decision === 'save' ? '草稿已保存。' : '审核结果已保存；未修改生产提示词或启动评测。');
    }
    root.addEventListener('click', event => {
      const el = event.target.closest('[data-tab],[data-go],[data-entry],[data-case],[data-group],[data-target],[data-q],[data-wiki-status],[data-cases-mode],[data-comparison],[data-induct],[data-confirm-suggestion],[data-reject-suggestion],[data-manual-assign],[data-manual-remove],[data-review],[data-confirm-candidate],[data-generate-candidate]');
      if (!el || el.disabled || !D) return;
      if (el.dataset.tab) { go(el.dataset.tab); return; }
      if (el.dataset.comparison) { if ((D.comparisons || []).some(r=>r.id===el.dataset.comparison)) { state.comparisonId=el.dataset.comparison; renderImpact(); } return; }
      if (el.dataset.q !== undefined) { state.wikiQ = el.dataset.q; $('#wiki-q').value = state.wikiQ; renderWiki(); $('#wiki-q').focus(); return; }
      if (el.dataset.wikiStatus) { state.wikiStatus = el.dataset.wikiStatus; renderWiki(); return; }
      if (el.dataset.casesMode) { state.casesMode = el.dataset.casesMode; renderCases(); return; }
      if (el.dataset.group) { event.preventDefault(); Object.assign(state, { casesGroup: el.dataset.group, casesQ: '', casesSplit: 'all', casesReplay: false }); $('#cases-q').value = ''; go('cases'); return; }
      if (el.dataset.case) { event.preventDefault(); go('case-' + el.dataset.case); return; }
      if (el.dataset.entry) { event.preventDefault(); if (el.dataset.version) versionId = el.dataset.version; state.entryId = el.dataset.entry; derive(); go(el.dataset.entry); if (window.matchMedia?.('(max-width: 860px)').matches) $('#wiki-page').scrollIntoView({ block: 'start' }); return; }
      if (el.dataset.target) { event.preventDefault(); state.targetId = el.dataset.target; if (state.view === 'targets' && !el.dataset.go) { renderTargets(); controls(); return; } go('targets'); return; }
      if (el.dataset.go) { event.preventDefault(); go(el.dataset.go); return; }
      if (el.hasAttribute('data-induct')) { void mutate('/api/wikiskill/induct', {}, '预分类或归纳完成，建议已保存；请确认或调整归属。'); return; }
      if (el.dataset.confirmSuggestion) { void mutate('/api/wikiskill/suggestion', { suggestionId: el.dataset.confirmSuggestion, decision: 'accepted' }, '归属建议已确认；归属来源和时间已保存。'); return; }
      if (el.dataset.rejectSuggestion) { void mutate('/api/wikiskill/suggestion', { suggestionId: el.dataset.rejectSuggestion, decision: 'rejected' }, '建议已否决；可手动归入或重新归纳。'); return; }
      if (el.hasAttribute('data-manual-assign')) { const card = el.closest('.case'), select = card?.querySelector('[data-manual-entry]'); if (!select?.value) { toast('请先选择一个已通过模式。'); return; } const c = caseByN.get(Number(card.id.slice(2))); void mutate('/api/wikiskill/membership', { caseId: c.id, entryId: select.value }, '已手动调整归属并保存来源。'); return; }
      if (el.hasAttribute('data-manual-remove')) { const card = el.closest('.case'), c = caseByN.get(Number(card.id.slice(2))); void mutate('/api/wikiskill/membership', { caseId: c.id, entryId: null }, c.split === 'train' ? '已移出模式；用例回到待归纳。' : '已确认未归类；组别不变。'); return; }
      if (el.dataset.review) { void review(entryById.get(state.entryId), el.dataset.review); return; }
      if (el.dataset.confirmCandidate) { const candidate = D.candidates.find(c => c.id === el.dataset.confirmCandidate), target = targetById.get(candidate.targetId); if (!confirmAction(`确认${targetFull(target)}的这份候选？此操作不会直接启动评测或修改生产配置。`)) return; void mutate('/api/wikiskill/confirm-global-candidate', { candidateId: candidate.id, candidateHash: candidate.candidateHash }, '候选已确认；未启动评测或修改生产配置。'); return; }
      if (el.hasAttribute('data-generate-candidate')) { const entryIds = $$('[data-candidate-entry]:checked').map(input => input.dataset.candidateEntry); if (entryIds.length !== 1 || !confirmAction('用所选已通过模式生成候选草稿？不会修改生产提示词或启动评测。')) return; void mutate('/api/wikiskill/candidate', { versionId: currentVersion().id, entryIds, targetId: state.targetId }, '候选草稿已生成；请查看新增内容后确认。'); }
    });
    root.addEventListener('change', event => {
      const el = event.target;
      if (el.id === 'wiki-version') { versionId = el.value; state.entryId = ''; derive(); renderWiki(); controls(); }
      if (el.id === 'cases-group') { state.casesGroup = el.value; renderCases(); }
      if (el.id === 'cases-split') { state.casesSplit = el.value; renderCases(); }
      if (el.id === 'cases-replay') { state.casesReplay = el.checked; renderCases(); }
      if (el.hasAttribute('data-candidate-entry')) controls();
    });
    $('#wiki-q').addEventListener('input', event => { state.wikiQ = event.target.value; renderWiki(); });
    $('#cases-q').addEventListener('input', event => { state.casesQ = event.target.value; renderCases(); });
    $('#wsk-refresh').addEventListener('click', () => { void load(); });
    document.addEventListener('keydown', event => { if (event.key !== '/' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return; const input = state.view === 'wiki' ? $('#wiki-q') : state.view === 'cases' ? $('#cases-q') : null; if (input) { event.preventDefault(); input.focus(); } });
    window.addEventListener('hashchange', applyHash);
    render(); controls();
    return { load() { return load().then(() => { if (D) applyHash(); }); }, refreshExecutions };
  };
})();
