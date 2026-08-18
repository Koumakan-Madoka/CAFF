// @ts-check
// DAG 规划图 panel（PRD .trellis/tasks/dag-planning/prd.md §6, D8）。
//
// 说明：PRD 原定 dagre 布局，但仓库内的 dagre-d3-es 是纯 ESM + d3 依赖，
// 无法被无打包的 vanilla 前端直接加载。POC 期内置一个 dagre 风格的轻量
// 分层布局（longest-path 分层 + barycenter 排序），手写 SVG 渲染，零新增
// 依赖；后续若引入打包器可无缝换成 dagre。

(function registerPlanPanelModule() {
  const chat = window.CaffChat || (window.CaffChat = {});

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NODE_WIDTH = 188;
  const NODE_HEIGHT = 64;
  const GAP_X = 48;
  const GAP_Y = 56;
  const NODE_STATUSES = ['pending', 'doing', 'done', 'blocked'];
  const STATUS_LABELS = { pending: '待办', doing: '进行', done: '完成', blocked: '阻塞' };
  const STATUS_NEXT = { pending: 'doing', doing: 'done', done: 'pending', blocked: 'pending' };
  const PLAN_STATUS_LABELS = { draft: '草稿（可编辑）', active: '执行中（结构锁定）', done: '已完成', archived: '已归档' };

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeParticipants(participants) {
    return (Array.isArray(participants) ? participants : [])
      .map((agent) => ({
        id: String(agent && agent.id || '').trim(),
        name: String(agent && agent.name || agent && agent.id || '').trim(),
      }))
      .filter((agent) => agent.id);
  }

  function normalizeDoc(doc) {
    const nodes = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
    return {
      nodes: nodes
        .filter((node) => node && typeof node === 'object')
        .map((node) => {
          const normalized = {
            id: String(node.id || '').trim(),
            title: String(node.title || node.id || ''),
            goal: String(node.goal || ''),
            status: NODE_STATUSES.includes(node.status) ? node.status : 'pending',
            depends_on: Array.isArray(node.depends_on) ? node.depends_on.map((dep) => String(dep || '').trim()).filter(Boolean) : [],
            branch: node.branch ? String(node.branch) : '',
            spawned_conversation_id: node.spawned_conversation_id ? String(node.spawned_conversation_id) : null,
            kind: node.kind === 'merge' ? 'merge' : 'work',
          };
          // dag-execution schema 增量（D11/D19/D23）必须保真透传，否则前端
          // 编辑草稿会把这些字段静默剥掉。空值不写出，保持载荷干净。
          if (typeof node.verify === 'string' && node.verify.trim()) {
            normalized.verify = node.verify;
          }
          if (typeof node.base_branch === 'string' && node.base_branch.trim()) {
            normalized.base_branch = node.base_branch;
          }
          if (typeof node.worker === 'string' && node.worker.trim()) {
            normalized.worker = node.worker;
          }
          if (typeof node.verifier === 'string' && node.verifier.trim()) {
            normalized.verifier = node.verifier;
          }
          if (typeof node.result === 'string' && node.result.trim()) {
            normalized.result = node.result;
          }
          return normalized;
        })
        .filter((node) => node.id),
    };
  }

  /**
   * 执行态派生徽标（纯展示，不改状态机）：
   * - ready：pending 且全部传递上游均 done（D24：就绪但可能在等并发槽位）
   * - upstreamBlocked：pending 且任一传递上游 blocked（D16 fail-closed 可见化）
   * 返回 Map<nodeId, { ready, upstreamBlocked }>，仅含需要徽标的 pending 节点。
   */
  function deriveNodeBadges(doc) {
    const normalized = normalizeDoc(doc);
    const byId = new Map(normalized.nodes.map((node) => [node.id, node]));
    const badges = new Map();
    const memo = new Map();
    const aggregate = (id, stack = new Set()) => {
      if (memo.has(id)) {
        return memo.get(id);
      }
      if (stack.has(id)) {
        return { allDone: false, anyBlocked: false }; // 环兜底（服务端已拦截）
      }
      stack.add(id);
      const node = byId.get(id);
      const deps = (node ? node.depends_on : []).filter((dep) => byId.has(dep) && dep !== id);
      let allDone = true;
      let anyBlocked = false;
      for (const dep of deps) {
        const depNode = byId.get(dep);
        if (depNode.status !== 'done') {
          allDone = false;
        }
        if (depNode.status === 'blocked') {
          anyBlocked = true;
        }
        const sub = aggregate(dep, stack);
        if (!sub.allDone) {
          allDone = false;
        }
        if (sub.anyBlocked) {
          anyBlocked = true;
        }
      }
      stack.delete(id);
      const result = { allDone, anyBlocked };
      memo.set(id, result);
      return result;
    };
    for (const node of normalized.nodes) {
      if (node.status !== 'pending') {
        continue;
      }
      const agg = aggregate(node.id);
      if (agg.anyBlocked) {
        badges.set(node.id, { ready: false, upstreamBlocked: true });
      } else if (agg.allDone) {
        badges.set(node.id, { ready: true, upstreamBlocked: false });
      }
    }
    return badges;
  }

  function formatHistoryTime(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** dagre 风格分层布局：longest-path 分层 + barycenter 排序扫描。 */
  function layoutPlan(doc) {
    const normalized = normalizeDoc(doc);
    const nodes = normalized.nodes;
    const ids = new Set(nodes.map((node) => node.id));
    const depsOf = new Map();
    const childrenOf = new Map();
    for (const node of nodes) {
      const deps = node.depends_on.filter((dep) => ids.has(dep) && dep !== node.id);
      depsOf.set(node.id, deps);
      childrenOf.set(node.id, []);
    }
    for (const node of nodes) {
      for (const dep of depsOf.get(node.id) || []) {
        (childrenOf.get(dep) || []).push(node.id);
      }
    }

    const layerMemo = new Map();
    const layerOf = (id, stack = new Set()) => {
      if (layerMemo.has(id)) {
        return layerMemo.get(id);
      }
      if (stack.has(id)) {
        return 0; // 环兜底（服务端已拦截，前端防御）
      }
      stack.add(id);
      const deps = depsOf.get(id) || [];
      const layer = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => layerOf(dep, stack))) + 1;
      stack.delete(id);
      layerMemo.set(id, layer);
      return layer;
    };

    /** @type {Map<number, string[]>} */
    const layers = new Map();
    for (const node of nodes) {
      const layer = layerOf(node.id);
      if (!layers.has(layer)) {
        layers.set(layer, []);
      }
      (layers.get(layer) || []).push(node.id);
    }

    const positionOf = new Map();
    const syncPositions = () => {
      for (const idsInLayer of layers.values()) {
        idsInLayer.forEach((id, index) => positionOf.set(id, index));
      }
    };
    syncPositions();

    const barycenter = (idList, neighborOf) => {
      const withCenter = idList.map((id) => {
        const neighbors = (neighborOf.get(id) || []).filter((other) => positionOf.has(other));
        const center = neighbors.length === 0
          ? -1
          : neighbors.reduce((sum, other) => sum + (positionOf.get(other) || 0), 0) / neighbors.length;
        return { id, center };
      });
      withCenter.sort((a, b) => (a.center === -1 ? 1 : a.center) - (b.center === -1 ? 1 : b.center));
      return withCenter.map((entry) => entry.id);
    };

    const sortedLayers = Array.from(layers.keys()).sort((a, b) => a - b);
    for (let sweep = 0; sweep < 4; sweep += 1) {
      for (const layer of sortedLayers) {
        layers.set(layer, barycenter(layers.get(layer) || [], depsOf));
        syncPositions();
      }
      for (const layer of sortedLayers.slice().reverse()) {
        layers.set(layer, barycenter(layers.get(layer) || [], childrenOf));
        syncPositions();
      }
    }

    const maxPerLayer = Math.max(1, ...Array.from(layers.values()).map((list) => list.length));
    const totalWidth = maxPerLayer * NODE_WIDTH + (maxPerLayer - 1) * GAP_X;

    /** @type {Map<string, { id: string, x: number, y: number, node: any }>} */
    const placed = new Map();
    for (const [layer, idsInLayer] of layers) {
      const layerWidth = idsInLayer.length * NODE_WIDTH + (idsInLayer.length - 1) * GAP_X;
      const offsetX = (totalWidth - layerWidth) / 2;
      idsInLayer.forEach((id, index) => {
        const node = nodes.find((entry) => entry.id === id);
        placed.set(id, {
          id,
          x: offsetX + index * (NODE_WIDTH + GAP_X),
          y: layer * (NODE_HEIGHT + GAP_Y),
          node,
        });
      });
    }

    const edges = [];
    for (const node of nodes) {
      for (const dep of depsOf.get(node.id) || []) {
        const from = placed.get(dep);
        const to = placed.get(node.id);
        if (from && to) {
          edges.push({
            from: dep,
            to: node.id,
            x1: from.x + NODE_WIDTH / 2,
            y1: from.y + NODE_HEIGHT,
            x2: to.x + NODE_WIDTH / 2,
            y2: to.y,
          });
        }
      }
    }

    return {
      placed,
      edges,
      width: totalWidth,
      height: sortedLayers.length * (NODE_HEIGHT + GAP_Y) - GAP_Y,
    };
  }

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, String(value));
    }
    return el;
  }

  /**
   * 手写 SVG 渲染。onSelect(nodeId) 处理节点点选；onCycleStatus(nodeId)
   * 处理 active 态点击状态 chip 快速流转；onEditNode(nodeId) 处理双击
   * 节点快速进入编辑（draft 态）。onLinkNodes(sourceId, targetId) 处理
   * 手柄拖拽连边（target 依赖 source）；onRemoveEdge(fromId, toId) 处理
   * 点击边移除依赖。locked 为 true（active/done/archived）时不渲染手柄，
   * 边也不可点删。
   */
  function renderGraph(container, doc, options = {}) {
    const {
      selectedNodeId = '',
      onSelect = null,
      onCycleStatus = null,
      onEditNode = null,
      onLinkNodes = null,
      onRemoveEdge = null,
      zoom = 1,
      locked = false,
      badges = null,
    } = options;
    const linkable = !locked && typeof onLinkNodes === 'function';
    container.innerHTML = '';

    const layout = layoutPlan(doc);
    if (layout.placed.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state compact-empty-state';
      empty.textContent = '图里还没有节点。让模型用 propose-plan 出图，或在草稿态手动新增。';
      container.appendChild(empty);
      return;
    }

    const pad = 24;
    const svg = svgEl('svg', {
      class: 'plan-svg',
      width: (layout.width + pad * 2) * zoom,
      height: (layout.height + pad * 2) * zoom,
      viewBox: `${-pad} ${-pad} ${layout.width + pad * 2} ${layout.height + pad * 2}`,
      role: 'img',
      'aria-label': '规划 DAG 图',
    });

    const defs = svgEl('defs');
    const marker = svgEl('marker', {
      id: `plan-arrow-${container.id || 'main'}`,
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    marker.appendChild(svgEl('path', { d: 'M 0 1 L 9 5 L 0 9 z', class: 'plan-edge-arrow' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    for (const edge of layout.edges) {
      const midY = (edge.y1 + edge.y2) / 2;
      const edgeD = `M ${edge.x1} ${edge.y1} C ${edge.x1} ${midY}, ${edge.x2} ${midY}, ${edge.x2} ${edge.y2 - 4}`;
      const path = svgEl('path', {
        class: 'plan-edge',
        d: edgeD,
        'marker-end': `url(#plan-arrow-${container.id || 'main'})`,
      });
      svg.appendChild(path);
      // draft 态：边可点击移除依赖；宽透明 hit path 提升可点区域
      if (linkable && typeof onRemoveEdge === 'function') {
        const hit = svgEl('path', {
          class: 'plan-edge-hit',
          d: edgeD,
          'data-from': edge.from,
          'data-to': edge.to,
        });
        const tip = svgEl('title');
        tip.textContent = `依赖 ${edge.from} → ${edge.to}：点击移除`;
        hit.appendChild(tip);
        hit.addEventListener('click', (event) => {
          event.stopPropagation();
          onRemoveEdge(edge.from, edge.to);
        });
        hit.addEventListener('pointerenter', () => path.classList.add('removable-hover'));
        hit.addEventListener('pointerleave', () => path.classList.remove('removable-hover'));
        svg.appendChild(hit);
        // 边中点的 × 删除按钮：显性可发现的删边入口（点边本身也可删）
        const del = svgEl('g', {
          class: 'plan-edge-del',
          transform: `translate(${(edge.x1 + edge.x2) / 2}, ${midY})`,
          'data-from': edge.from,
          'data-to': edge.to,
        });
        const delTip = svgEl('title');
        delTip.textContent = `删除依赖 ${edge.from} → ${edge.to}`;
        del.appendChild(delTip);
        del.appendChild(svgEl('circle', { r: 8, class: 'plan-edge-del-bg' }));
        const delX = svgEl('text', { class: 'plan-edge-del-x', 'text-anchor': 'middle', dy: '0.35em' });
        delX.textContent = '×';
        del.appendChild(delX);
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          onRemoveEdge(edge.from, edge.to);
        });
        del.addEventListener('pointerenter', () => path.classList.add('removable-hover'));
        del.addEventListener('pointerleave', () => path.classList.remove('removable-hover'));
        svg.appendChild(del);
      }
    }

    for (const entry of layout.placed.values()) {
      const node = entry.node;
      const group = svgEl('g', {
        class: `plan-node status-${node.status} kind-${node.kind}${entry.id === selectedNodeId ? ' selected' : ''}`,
        transform: `translate(${entry.x}, ${entry.y})`,
        tabindex: '0',
        role: 'button',
        'aria-label': `节点 ${node.title}`,
        'data-node-id': entry.id,
      });

      group.appendChild(svgEl('rect', {
        class: 'plan-node-rect',
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        rx: 10,
      }));

      const title = svgEl('text', { class: 'plan-node-title', x: 12, y: 22 });
      title.textContent = truncate(node.title || entry.id, 16);
      group.appendChild(title);

      const subtitle = svgEl('text', { class: 'plan-node-subtitle', x: 12, y: 40 });
      const kindLabel = node.kind === 'merge' ? '⇄ merge ' : '';
      subtitle.textContent = truncate(`${kindLabel}${node.branch || ''}`, 24) || ' ';
      group.appendChild(subtitle);

      const chipWidth = 46;
      const chip = svgEl('g', {
        class: `plan-status-chip status-${node.status}${locked ? '' : ' clickable'}`,
        transform: `translate(${NODE_WIDTH - chipWidth - 8}, ${NODE_HEIGHT - 24})`,
        'data-node-id': entry.id,
      });
      chip.appendChild(svgEl('rect', { width: chipWidth, height: 17, rx: 8, class: 'plan-status-chip-rect' }));
      const chipText = svgEl('text', { x: chipWidth / 2, y: 12.5, class: 'plan-status-chip-text', 'text-anchor': 'middle' });
      chipText.textContent = STATUS_LABELS[node.status] || node.status;
      chip.appendChild(chipText);
      group.appendChild(chip);

      if (node.spawned_conversation_id) {
        const badge = svgEl('text', { class: 'plan-node-spawned', x: 12, y: NODE_HEIGHT - 8 });
        badge.textContent = '⤴ 已绑定子会话';
        group.appendChild(badge);
      }

      // 执行态派生徽标（D16 上游阻塞 / D24 就绪待派发），右下角避免与
      // 左侧 spawned 徽标和右上状态 chip 重叠
      const derived = badges && typeof badges.get === 'function' ? badges.get(entry.id) : null;
      if (derived) {
        const badge = svgEl('text', {
          class: `plan-node-derived-badge ${derived.upstreamBlocked ? 'badge-blocked' : 'badge-ready'}`,
          x: NODE_WIDTH - 8,
          y: NODE_HEIGHT - 8,
          'text-anchor': 'end',
        });
        badge.textContent = derived.upstreamBlocked ? '⛔ 上游阻塞' : '⏳ 就绪待派发';
        group.appendChild(badge);
      }

      group.addEventListener('click', (event) => {
        const chipTarget = event.target && /** @type {Element} */ (event.target).closest
          ? /** @type {Element} */ (event.target).closest('.plan-status-chip')
          : null;
        if (chipTarget && typeof onCycleStatus === 'function') {
          event.stopPropagation();
          onCycleStatus(entry.id);
          return;
        }
        if (typeof onSelect === 'function') {
          onSelect(entry.id);
        }
      });
      group.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (typeof onSelect === 'function') {
            onSelect(entry.id);
          }
        }
      });
      group.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (typeof onEditNode === 'function') {
          onEditNode(entry.id);
        }
      });

      // draft 态：顶部手柄（依赖入口）+ 底部手柄（拖出连边）
      if (linkable) {
        const inHandle = svgEl('circle', {
          class: 'plan-handle plan-handle-in',
          cx: NODE_WIDTH / 2,
          cy: 0,
          r: 6,
          'data-node-id': entry.id,
        });
        const inTip = svgEl('title');
        inTip.textContent = '依赖入口：把其它节点的底部手柄拖到这里';
        inHandle.appendChild(inTip);
        const outHandle = svgEl('circle', {
          class: 'plan-handle plan-handle-out',
          cx: NODE_WIDTH / 2,
          cy: NODE_HEIGHT,
          r: 6,
          'data-node-id': entry.id,
        });
        const outTip = svgEl('title');
        outTip.textContent = '拖到子节点的顶部手柄，建立依赖连线';
        outHandle.appendChild(outTip);
        for (const handle of [inHandle, outHandle]) {
          handle.addEventListener('click', (event) => event.stopPropagation());
          handle.addEventListener('dblclick', (event) => event.stopPropagation());
          group.appendChild(handle);
        }
      }

      svg.appendChild(group);
    }

    if (linkable) {
      setupEdgeLinking(svg, layout, onLinkNodes);
    }

    const stage = document.createElement('div');
    stage.className = 'plan-graph-stage';
    stage.appendChild(svg);
    container.appendChild(stage);
  }

  /** 视口坐标 → SVG viewBox 坐标（jsdom 等无 CTM 环境下退化为近似值，仅供拖线预览）。 */
  function toSvgPoint(svg, clientX, clientY) {
    if (typeof svg.createSVGPoint === 'function' && typeof svg.getScreenCTM === 'function') {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        return pt.matrixTransform(ctm.inverse());
      }
    }
    const rect = typeof svg.getBoundingClientRect === 'function'
      ? svg.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };
    const viewBox = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
    if (viewBox && rect.width && rect.height) {
      return {
        x: viewBox.x + ((clientX - rect.left) * viewBox.width) / rect.width,
        y: viewBox.y + ((clientY - rect.top) * viewBox.height) / rect.height,
      };
    }
    return { x: clientX, y: clientY };
  }

  /**
   * 手柄拖拽连边：从底部手柄 pointerdown 开始，拖动时画虚线预览，
   * 落在另一节点（或其顶部手柄）上松手即回调 onLinkNodes(sourceId, targetId)。
   * 不做 pointer capture，保证目标节点能收到 pointerenter/pointerup。
   */
  function setupEdgeLinking(svg, layout, onLinkNodes) {
    svg.addEventListener('pointerdown', (event) => {
      const handle = event.target && /** @type {Element} */ (event.target).closest
        ? /** @type {Element} */ (event.target).closest('.plan-handle-out')
        : null;
      if (!handle) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const sourceId = String(handle.getAttribute('data-node-id') || '');
      const from = layout.placed.get(sourceId);
      if (!sourceId || !from) {
        return;
      }

      const start = { x: from.x + NODE_WIDTH / 2, y: from.y + NODE_HEIGHT };
      const temp = svgEl('path', { class: 'plan-link-temp', d: `M ${start.x} ${start.y}` });
      svg.appendChild(temp);
      const drag = { sourceId, start, temp, hoverId: '' };

      const groups = Array.from(svg.querySelectorAll('.plan-node'));
      const onEnter = (enterEvent) => {
        const group = /** @type {Element} */ (enterEvent.currentTarget);
        drag.hoverId = String(group.getAttribute('data-node-id') || '');
        if (drag.hoverId && drag.hoverId !== drag.sourceId) {
          group.classList.add('link-target');
        }
      };
      const onLeave = (leaveEvent) => {
        const group = /** @type {Element} */ (leaveEvent.currentTarget);
        group.classList.remove('link-target');
        if (drag.hoverId === String(group.getAttribute('data-node-id') || '')) {
          drag.hoverId = '';
        }
      };
      for (const group of groups) {
        group.addEventListener('pointerenter', onEnter);
        group.addEventListener('pointerleave', onLeave);
      }

      const onMove = (moveEvent) => {
        const pt = toSvgPoint(svg, moveEvent.clientX, moveEvent.clientY);
        const midY = (drag.start.y + pt.y) / 2;
        drag.temp.setAttribute(
          'd',
          `M ${drag.start.x} ${drag.start.y} C ${drag.start.x} ${midY}, ${pt.x} ${midY}, ${pt.x} ${pt.y}`,
        );
      };
      const cleanup = () => {
        for (const group of groups) {
          group.removeEventListener('pointerenter', onEnter);
          group.removeEventListener('pointerleave', onLeave);
          group.classList.remove('link-target');
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        drag.temp.remove();
      };
      const onUp = (upEvent) => {
        let targetId = drag.hoverId;
        if (!targetId) {
          const upTarget = upEvent.target && /** @type {Element} */ (upEvent.target).closest
            ? /** @type {Element} */ (upEvent.target).closest('.plan-node')
            : null;
          targetId = upTarget ? String(upTarget.getAttribute('data-node-id') || '') : '';
        }
        const { sourceId: dragSourceId } = drag;
        cleanup();
        if (targetId && targetId !== dragSourceId) {
          onLinkNodes(dragSourceId, targetId);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // 暴露纯函数给测试与未来复用（tool 提示、导出等）
  chat.planDagView = { layoutPlan, normalizeDoc, renderGraph, deriveNodeBadges };

  chat.createPlanPanelController = function createPlanPanelController({ state, dom, helpers, showToast }) {
    const { fetchPlan, savePlan, activatePlan, revertPlan, openConversation } = helpers;

    let plan = null;
    let ownerConversationId = '';
    /** @type {{id: string, name: string}[]} */
    let planParticipants = [];
    let loadedConversationId = '';
    let loading = false;
    let saving = false;
    /** @type {any} */
    let editDoc = null;
    let dirty = false;
    let selectedNodeId = '';
    let expanded = false;
    let zoom = 1;
    let loadToken = 0;
    /** @type {string[]} */
    let lastIssues = [];

    function currentConversationId() {
      return state.currentConversation ? state.currentConversation.id : '';
    }

    function workingDoc() {
      if (editDoc) {
        return editDoc;
      }
      return plan ? plan.doc : null;
    }

    function isDraft() {
      return Boolean(plan && plan.status === 'draft');
    }

    function isActive() {
      return Boolean(plan && plan.status === 'active');
    }

    function resolveParticipantId(reference) {
      const value = String(reference || '').trim();
      if (!value) {
        return '';
      }
      const exact = planParticipants.find((agent) => agent.id === value);
      if (exact) {
        return exact.id;
      }
      const named = planParticipants.filter((agent) => agent.name === value);
      return named.length === 1 ? named[0].id : '';
    }

    function workerIdForNode(node) {
      return resolveParticipantId(node && node.worker) || (planParticipants[0] ? planParticipants[0].id : '');
    }

    function renderParticipantSelect(select, reference, { automaticLabel, excludedId = '' }) {
      if (!select) {
        return;
      }
      const rawReference = String(reference || '').trim();
      const resolvedId = resolveParticipantId(rawReference);
      select.innerHTML = '';
      const automatic = document.createElement('option');
      automatic.value = '';
      automatic.textContent = automaticLabel;
      select.appendChild(automatic);
      for (const agent of planParticipants) {
        if (agent.id === excludedId) {
          continue;
        }
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = agent.name === agent.id ? agent.name : `${agent.name} (${agent.id})`;
        select.appendChild(option);
      }
      if (rawReference && (!resolvedId || resolvedId === excludedId)) {
        const invalid = document.createElement('option');
        invalid.value = rawReference;
        invalid.textContent = `无效配置：${rawReference}`;
        invalid.disabled = true;
        select.appendChild(invalid);
        select.value = rawReference;
      } else {
        select.value = resolvedId;
      }
    }

    function setIssues(issues) {
      lastIssues = Array.isArray(issues) ? issues.map((issue) => String((issue && issue.message) || issue)) : [];
    }

    async function load(conversationId, { force = false } = {}) {
      const normalizedId = String(conversationId || '').trim();
      if (!normalizedId) {
        plan = null;
        ownerConversationId = '';
        planParticipants = [];
        loadedConversationId = '';
        editDoc = null;
        dirty = false;
        selectedNodeId = '';
        renderAll();
        return;
      }
      if (!force && normalizedId === loadedConversationId && (plan || loadedConversationId)) {
        return;
      }
      const token = ++loadToken;
      loading = true;
      renderAll();
      try {
        const result = await fetchPlan(normalizedId);
        if (token !== loadToken) {
          return;
        }
        plan = result.plan || null;
        ownerConversationId = String(result.ownerConversationId || '');
        planParticipants = normalizeParticipants(result.participants);
        loadedConversationId = normalizedId;
        editDoc = null;
        dirty = false;
        selectedNodeId = '';
        setIssues([]);
      } catch (error) {
        if (token !== loadToken) {
          return;
        }
        if (error && (error.status === 404 || error.code === 'plan_not_found' || error.code === 'conversation_not_found')) {
          plan = null;
          ownerConversationId = '';
          planParticipants = [];
          loadedConversationId = normalizedId;
          editDoc = null;
          dirty = false;
          selectedNodeId = '';
        } else {
          showToast(error && error.message ? error.message : '加载规划图失败');
        }
      } finally {
        if (token === loadToken) {
          loading = false;
          renderAll();
        }
      }
    }

    function applyPlanEvent(payload) {
      if (!payload || !payload.plan) {
        return;
      }
      const eventOwner = String(payload.ownerConversationId || '');
      const eventConversation = String(payload.conversationId || '');
      const relevant =
        (ownerConversationId && eventOwner === ownerConversationId) ||
        eventConversation === currentConversationId() ||
        (plan && payload.plan.ownerConversationId === plan.ownerConversationId);
      if (!relevant) {
        return;
      }
      const hadLocalEdits = dirty;
      plan = payload.plan;
      ownerConversationId = eventOwner || String(payload.plan.ownerConversationId || ownerConversationId);
      loadedConversationId = currentConversationId() || loadedConversationId;
      editDoc = null;
      dirty = false;
      setIssues([]);
      renderAll();
      if (hadLocalEdits) {
        showToast('规划图已被其他端更新，本地未保存修改已丢弃');
      }
      // A panel may have loaded before the tree had a plan: the initial GET
      // then returned 404, so no root-participant projection was available.
      // When the first plan arrives over SSE, refresh once to hydrate the
      // worker/verifier dropdowns instead of leaving them empty until a
      // manual reload.
      if (planParticipants.length === 0 && currentConversationId()) {
        void load(currentConversationId(), { force: true });
      }
    }

    function ensureEditDoc() {
      if (!editDoc && plan) {
        editDoc = deepClone(plan.doc);
      }
      return editDoc;
    }

    function mutateDraftDoc(mutator) {
      if (!isDraft()) {
        return;
      }
      const doc = ensureEditDoc();
      mutator(doc);
      doc.nodes = normalizeDoc(doc).nodes;
      dirty = true;
      renderGraphs();
      renderButtons();
    }

    /** fromId 沿 depends_on 能否走到 toId（用于连边前的环拦截，服务端仍会兜底 422）。 */
    function reaches(doc, fromId, toId) {
      const byId = new Map(((doc && doc.nodes) || []).map((node) => [node.id, node]));
      const stack = [fromId];
      const seen = new Set();
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === toId) {
          return true;
        }
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        const node = byId.get(id);
        for (const dep of (node && node.depends_on) || []) {
          stack.push(dep);
        }
      }
      return false;
    }

    /** 手柄拖拽连边：target 依赖 source。自连/重复/成环在前端即时拦截并提示。 */
    function linkNodes(sourceId, targetId) {
      if (!isDraft()) {
        return;
      }
      if (!sourceId || !targetId || sourceId === targetId) {
        showToast('不能连接节点自身');
        return;
      }
      const doc = ensureEditDoc();
      const source = ((doc && doc.nodes) || []).find((entry) => entry.id === sourceId);
      const target = ((doc && doc.nodes) || []).find((entry) => entry.id === targetId);
      if (!source || !target) {
        return;
      }
      if ((target.depends_on || []).includes(sourceId)) {
        showToast(`「${target.title || targetId}」已经依赖「${source.title || sourceId}」`);
        return;
      }
      if (reaches(doc, sourceId, targetId)) {
        showToast('这条边会形成环，已拦截');
        return;
      }
      mutateDraftDoc((draft) => {
        const targetNode = (draft.nodes || []).find((entry) => entry.id === targetId);
        if (targetNode) {
          targetNode.depends_on = [...(targetNode.depends_on || []), sourceId];
        }
      });
    }

    /** 点击边移除依赖（fromId → toId 即 toId 的 depends_on 里去掉 fromId）。 */
    function removeEdge(fromId, toId) {
      if (!isDraft()) {
        return;
      }
      mutateDraftDoc((draft) => {
        const targetNode = (draft.nodes || []).find((entry) => entry.id === toId);
        if (targetNode) {
          targetNode.depends_on = (targetNode.depends_on || []).filter((dep) => dep !== fromId);
        }
      });
    }

    function selectedNode() {
      const doc = workingDoc();
      if (!doc || !selectedNodeId) {
        return null;
      }
      return (doc.nodes || []).find((node) => node.id === selectedNodeId) || null;
    }

    async function persistDoc(doc, { successMessage = '' } = {}) {
      if (!plan || saving) {
        return;
      }
      saving = true;
      renderButtons();
      try {
        // history 由服务端全权维护（D18）：省略字段 = 继承存量。
        // 显式回传草稿期克隆的旧 history 会在服务端追加新条目后
        // 误触 append-only 前缀校验（409 plan_locked）。
        const outgoing = { ...doc };
        delete outgoing.history;
        const result = await savePlan(currentConversationId(), { doc: outgoing, version: plan.version });
        plan = result.plan || plan;
        ownerConversationId = String(result.ownerConversationId || ownerConversationId);
        if (Array.isArray(result.participants)) {
          planParticipants = normalizeParticipants(result.participants);
        }
        editDoc = null;
        dirty = false;
        setIssues([]);
        if (Array.isArray(result.warnings) && result.warnings.length > 0) {
          setIssues(result.warnings);
        }
        if (successMessage) {
          showToast(successMessage);
        }
      } catch (error) {
        if (error && (error.status === 409 || error.code === 'plan_version_conflict')) {
          showToast('规划图版本冲突，已重新加载最新版本');
          await load(currentConversationId(), { force: true });
          return;
        }
        const issues = error && Array.isArray(error.issues) ? error.issues : [];
        setIssues(issues);
        showToast(error && error.message ? error.message : '保存规划图失败');
      } finally {
        saving = false;
        renderAll();
      }
    }

    async function transition(kind) {
      if (!plan || saving) {
        return;
      }
      saving = true;
      renderButtons();
      try {
        const action = kind === 'activate' ? activatePlan : revertPlan;
        const result = await action(currentConversationId());
        plan = result.plan || plan;
        ownerConversationId = String(result.ownerConversationId || ownerConversationId);
        if (Array.isArray(result.participants)) {
          planParticipants = normalizeParticipants(result.participants);
        }
        editDoc = null;
        dirty = false;
        setIssues([]);
        showToast(kind === 'activate' ? '规划已进入执行态，结构已锁定' : '已退回草稿，可继续编辑结构');
      } catch (error) {
        showToast(error && error.message ? error.message : '状态流转失败');
      } finally {
        saving = false;
        renderAll();
      }
    }

    function cycleNodeStatus(nodeId) {
      if (!plan) {
        return;
      }
      const doc = deepClone(workingDoc());
      const node = (doc.nodes || []).find((entry) => entry.id === nodeId);
      if (!node) {
        return;
      }
      if (isActive()) {
        node.status = STATUS_NEXT[node.status] || 'pending';
        void persistDoc(doc, { successMessage: `节点 ${node.title || nodeId} → ${STATUS_LABELS[node.status]}` });
        return;
      }
      if (isDraft()) {
        editDoc = doc;
        node.status = STATUS_NEXT[node.status] || 'pending';
        dirty = true;
        renderGraphs();
        renderButtons();
      }
    }

    function addNode() {
      if (!plan || !isDraft()) {
        showToast('请先让模型用 propose-plan 出图，或确认 plan 处于草稿态');
        return;
      }
      mutateDraftDoc((doc) => {
        const existing = new Set((doc.nodes || []).map((node) => node.id));
        let index = (doc.nodes || []).length + 1;
        let id = `n${index}`;
        while (existing.has(id)) {
          index += 1;
          id = `n${index}`;
        }
        doc.nodes = doc.nodes || [];
        doc.nodes.push({
          id,
          title: `新节点 ${index}`,
          goal: '',
          status: 'pending',
          depends_on: [],
          branch: '',
          spawned_conversation_id: null,
          kind: 'work',
        });
        selectedNodeId = id;
      });
      renderEditor();
      if (dom.planNodeTitle) {
        dom.planNodeTitle.focus();
      }
    }

    function deleteSelectedNode() {
      const node = selectedNode();
      if (!node || !isDraft()) {
        return;
      }
      if (!window.confirm(`删除节点「${node.title || node.id}」？其它节点对它的依赖会一并移除。`)) {
        return;
      }
      mutateDraftDoc((doc) => {
        doc.nodes = (doc.nodes || []).filter((entry) => entry.id !== node.id);
        for (const entry of doc.nodes) {
          entry.depends_on = (entry.depends_on || []).filter((dep) => dep !== node.id);
        }
        if (Array.isArray(doc.edges)) {
          doc.edges = doc.edges.filter((edge) => edge && edge.from !== node.id && edge.to !== node.id);
        }
        selectedNodeId = '';
      });
      renderEditor();
    }

    function renderStatus() {
      if (!dom.planPanelStatus) {
        return;
      }
      let text = '当前会话树还没有规划图';
      let cls = 'session-goal-status-badge active';
      if (loading) {
        text = '规划图加载中…';
      } else if (plan) {
        const label = PLAN_STATUS_LABELS[plan.status] || plan.status;
        const dirtySuffix = dirty ? ' · 有未保存修改' : '';
        text = `v${plan.version} · ${label}${dirtySuffix}`;
        cls = `session-goal-status-badge ${plan.status === 'active' ? 'active' : plan.status === 'draft' ? 'paused' : 'complete'}`;
      }
      dom.planPanelStatus.className = cls;
      dom.planPanelStatus.textContent = text;
    }

    function renderGraphs() {
      const doc = workingDoc();
      const shared = {
        selectedNodeId,
        zoom,
        locked: !isDraft(),
        badges: doc && isActive() ? deriveNodeBadges(doc) : null,
        onLinkNodes: linkNodes,
        onRemoveEdge: removeEdge,
        onSelect(id) {
          selectedNodeId = selectedNodeId === id ? '' : id;
          renderGraphs();
          renderEditor();
        },
        onCycleStatus: cycleNodeStatus,
        onEditNode(id) {
          selectedNodeId = id;
          renderGraphs();
          renderEditor();
          if (isDraft() && dom.planNodeTitle) {
            dom.planNodeTitle.focus();
            dom.planNodeTitle.select();
          }
        },
      };
      if (dom.planGraph) {
        if (doc) {
          renderGraph(dom.planGraph, doc, shared);
        } else {
          dom.planGraph.innerHTML = '';
          const empty = document.createElement('div');
          empty.className = 'empty-state compact-empty-state';
          empty.textContent = loading ? '加载中…' : '暂无规划图。与模型讨论后让它调用 propose-plan 出图。';
          dom.planGraph.appendChild(empty);
        }
      }
      if (expanded && dom.planGraphExpanded) {
        if (doc) {
          renderGraph(dom.planGraphExpanded, doc, shared);
        } else {
          dom.planGraphExpanded.innerHTML = '';
        }
      }
    }

    const ZOOM_MIN = 0.3;
    const ZOOM_MAX = 2.5;

    function setZoom(next) {
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      renderGraphs();
    }

    /** 适应宽度：让整图恰好铺满当前可视画布宽度。 */
    function fitZoom() {
      const doc = workingDoc();
      const container = expanded && dom.planGraphExpanded ? dom.planGraphExpanded : dom.planGraph;
      if (!doc || !container) {
        return;
      }
      const layout = layoutPlan(doc);
      const pad = 24;
      const available = container.clientWidth - 8;
      if (available > 0 && layout.width > 0) {
        setZoom(available / (layout.width + pad * 2));
      }
    }

    function bindWheelZoom(container) {
      if (!container) {
        return;
      }
      container.addEventListener('wheel', (event) => {
        if (!event.ctrlKey && !event.metaKey) {
          return;
        }
        event.preventDefault();
        setZoom(zoom + (event.deltaY < 0 ? 0.15 : -0.15));
      }, { passive: false });
    }

    /** 节点执行信息：blocked 原因（取自 D18 history 最近条目）+ result 摘要（D23）。 */
    function renderNodeExecution(node) {
      const container = dom.planNodeExecution;
      if (!container) {
        return;
      }
      container.innerHTML = '';
      const doc = workingDoc();
      const history = doc && Array.isArray(doc.history) ? doc.history : [];
      const lastBlocked = history
        .slice()
        .reverse()
        .find((entry) => entry && entry.node_id === node.id && entry.to === 'blocked' && entry.reason);
      if (node.status === 'blocked' && lastBlocked) {
        const reason = document.createElement('p');
        reason.className = 'plan-node-blocked-reason';
        reason.textContent = `⛔ 阻塞原因：${lastBlocked.reason}`;
        container.appendChild(reason);
      }
      if (node.result) {
        const result = document.createElement('p');
        result.className = 'plan-node-result';
        result.textContent = `📦 结果摘要：${node.result}`;
        container.appendChild(result);
      }
      container.classList.toggle('hidden', container.childNodes.length === 0);
    }

    /** D18 执行历史时间线：只读展示服务端已落库的 history（最近 20 条，新的在前）。 */
    function renderHistory() {
      if (!dom.planHistory || !dom.planHistoryList) {
        return;
      }
      const doc = plan ? plan.doc : null;
      const history = doc && Array.isArray(doc.history) ? doc.history : [];
      dom.planHistory.classList.toggle('hidden', history.length === 0);
      dom.planHistoryList.innerHTML = '';
      if (history.length === 0) {
        return;
      }
      const summary = dom.planHistory.querySelector('summary');
      if (summary) {
        summary.textContent = `执行历史（${history.length}）`;
      }
      const titleOf = new Map(((doc && doc.nodes) || []).map((node) => [node.id, node.title || node.id]));
      for (const entry of history.slice(-20).reverse()) {
        const row = document.createElement('p');
        row.className = 'plan-history-entry';
        const time = formatHistoryTime(entry.at);
        const label = titleOf.get(entry.node_id) || entry.node_id;
        const reason = entry.reason ? ` · ${truncate(entry.reason, 60)}` : '';
        row.textContent = `${time ? `${time} ` : ''}${label}：${STATUS_LABELS[entry.from] || entry.from} → ${STATUS_LABELS[entry.to] || entry.to} · ${entry.actor}${reason}`;
        dom.planHistoryList.appendChild(row);
      }
    }

    function renderIssues() {
      if (!dom.planIssues) {
        return;
      }
      dom.planIssues.classList.toggle('hidden', lastIssues.length === 0);
      dom.planIssues.innerHTML = '';
      for (const issue of lastIssues) {
        const row = document.createElement('p');
        row.className = 'plan-issue';
        row.textContent = issue;
        dom.planIssues.appendChild(row);
      }
    }

    function renderEditor() {
      if (!dom.planEditor) {
        return;
      }
      const node = selectedNode();
      dom.planEditor.classList.toggle('hidden', !node);
      if (!node) {
        return;
      }

      const locked = !isDraft();
      if (dom.planNodeId) {
        dom.planNodeId.textContent = node.id + (node.kind === 'merge' ? '（merge 节点）' : '');
      }
      if (dom.planNodeTitle) {
        dom.planNodeTitle.value = node.title || '';
        dom.planNodeTitle.disabled = locked;
      }
      if (dom.planNodeGoal) {
        dom.planNodeGoal.value = node.goal || '';
        dom.planNodeGoal.disabled = locked;
      }
      if (dom.planNodeStatus) {
        dom.planNodeStatus.value = node.status || 'pending';
        dom.planNodeStatus.disabled = Boolean(saving);
      }
      if (dom.planNodeBranch) {
        dom.planNodeBranch.value = node.branch || '';
        dom.planNodeBranch.disabled = locked;
      }
      if (dom.planNodeKind) {
        dom.planNodeKind.value = node.kind || 'work';
        dom.planNodeKind.disabled = locked;
      }
      if (dom.planNodeVerify) {
        dom.planNodeVerify.value = node.verify || '';
        dom.planNodeVerify.disabled = locked;
      }
      if (dom.planNodeBaseBranch) {
        dom.planNodeBaseBranch.value = node.base_branch || '';
        dom.planNodeBaseBranch.disabled = locked;
      }
      const workerId = workerIdForNode(node);
      if (dom.planNodeWorker) {
        const defaultWorker = planParticipants[0];
        renderParticipantSelect(dom.planNodeWorker, node.worker, {
          automaticLabel: defaultWorker
            ? `默认主理人：${defaultWorker.name}`
            : '无可用参与者',
        });
        dom.planNodeWorker.disabled = locked || planParticipants.length === 0;
      }
      if (dom.planNodeVerifier) {
        const fallbackVerifier = planParticipants.find((agent) => agent.id !== workerId);
        renderParticipantSelect(dom.planNodeVerifier, node.verifier, {
          automaticLabel: fallbackVerifier
            ? `自动验收：${fallbackVerifier.name}`
            : '免验收（无其他参与者）',
          excludedId: workerId,
        });
        dom.planNodeVerifier.disabled = locked || planParticipants.length === 0;
      }
      renderNodeExecution(node);
      if (dom.planNodeDeleteButton) {
        dom.planNodeDeleteButton.disabled = locked || saving;
      }
      if (dom.planNodeSpawned) {
        dom.planNodeSpawned.innerHTML = '';
        if (node.spawned_conversation_id) {
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'ghost-button plan-spawned-link';
          link.textContent = `⤴ 打开子会话 ${truncate(node.spawned_conversation_id, 12)}`;
          link.addEventListener('click', () => {
            if (typeof openConversation === 'function') {
              void openConversation(node.spawned_conversation_id);
            }
          });
          dom.planNodeSpawned.appendChild(link);
        }
      }
      if (dom.planNodeDeps) {
        dom.planNodeDeps.innerHTML = '';
        const doc = workingDoc();
        const titleOf = (depId) => {
          const depNode = doc ? (doc.nodes || []).find((entry) => entry.id === depId) : null;
          return depNode ? depNode.title || depNode.id : depId;
        };
        const deps = node.depends_on || [];
        const summary = document.createElement('p');
        summary.className = 'muted plan-deps-summary';
        summary.textContent = deps.length > 0 ? '依赖：' : '依赖：无（顶层节点）';
        dom.planNodeDeps.appendChild(summary);
        if (!locked) {
          // 每条依赖渲染成带 × 的 chip：表单内也能直接删边
          if (deps.length > 0) {
            const chipRow = document.createElement('div');
            chipRow.className = 'plan-deps-chips';
            for (const dep of deps) {
              const chip = document.createElement('span');
              chip.className = 'plan-dep-chip';
              const label = document.createElement('span');
              label.textContent = `${titleOf(dep)} (${dep})`;
              chip.appendChild(label);
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'plan-dep-chip-remove';
              btn.textContent = '×';
              btn.title = `移除对「${titleOf(dep)}」的依赖`;
              btn.addEventListener('click', () => {
                removeEdge(dep, node.id);
                renderEditor();
              });
              chip.appendChild(btn);
              chipRow.appendChild(chip);
            }
            dom.planNodeDeps.appendChild(chipRow);
          }
          const hint = document.createElement('p');
          hint.className = 'muted plan-deps-hint';
          hint.textContent = '连边：从父节点的底部手柄拖到本节点（或其顶部手柄）；删边：点边中点的 × 或直接点边。';
          dom.planNodeDeps.appendChild(hint);
        }
      }
      renderIssues();
    }

    function renderButtons() {
      const hasConversation = Boolean(currentConversationId());
      const hasPlan = Boolean(plan);
      const busy = loading || saving;

      if (dom.planRefreshButton) {
        dom.planRefreshButton.disabled = !hasConversation || busy;
      }
      if (dom.planAddNodeButton) {
        dom.planAddNodeButton.disabled = !hasPlan || !isDraft() || busy;
      }
      if (dom.planSaveButton) {
        dom.planSaveButton.disabled = !hasPlan || !isDraft() || !dirty || busy;
        dom.planSaveButton.textContent = saving ? '保存中…' : dirty ? '保存修改' : '已保存';
      }
      if (dom.planActivateButton) {
        dom.planActivateButton.disabled = !hasPlan || !isDraft() || busy;
      }
      if (dom.planRevertButton) {
        dom.planRevertButton.disabled = !hasPlan || !isActive() || busy;
      }
      if (dom.planExpandButton) {
        dom.planExpandButton.disabled = !hasPlan;
        dom.planExpandButton.textContent = expanded ? '收起全屏' : '全屏';
      }
    }

    function renderAll() {
      renderStatus();
      renderGraphs();
      renderEditor();
      renderHistory();
      renderButtons();
    }

    function setExpanded(nextExpanded) {
      expanded = Boolean(nextExpanded);
      if (dom.planExpandOverlay) {
        dom.planExpandOverlay.classList.toggle('hidden', !expanded);
        dom.planExpandOverlay.setAttribute('aria-hidden', expanded ? 'false' : 'true');
      }
      document.body.classList.toggle('plan-expanded-open', expanded);
      renderGraphs();
      renderButtons();
      if (expanded && dom.planGraphExpanded && typeof requestAnimationFrame === 'function') {
        // 图大于视口时把滚动位置居中，避免打开全屏只看见左上角
        requestAnimationFrame(() => {
          const el = dom.planGraphExpanded;
          if (el.scrollWidth > el.clientWidth) {
            el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
          }
          if (el.scrollHeight > el.clientHeight) {
            el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
          }
        });
      }
    }

    function bindInput(input, apply) {
      if (!input) {
        return;
      }
      input.addEventListener('input', () => {
        if (!isDraft()) {
          return;
        }
        mutateDraftDoc((doc) => {
          const target = (doc.nodes || []).find((entry) => entry.id === selectedNodeId);
          if (target) {
            apply(target, input.value);
          }
        });
      });
    }

    function bindDragPan(container) {
      if (!container) {
        return;
      }
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      container.addEventListener('pointerdown', (event) => {
        // 只从空白背景起手平移：交互元素（节点/删边徽章/边热区/连线手柄）
        // 上的 pointerdown 不能抢 pointer capture，否则 click 会被重定向到容器，
        // 导致删边、连边等点击全部失效。
        const target = event.target && /** @type {Element} */ (event.target).closest
          ? /** @type {Element} */ (event.target)
          : null;
        if (target && target.closest('.plan-node, .plan-edge-del, .plan-edge-hit, .plan-handle-out, .plan-handle-in')) {
          return;
        }
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = container.scrollLeft;
        startTop = container.scrollTop;
        container.setPointerCapture(event.pointerId);
      });
      container.addEventListener('pointermove', (event) => {
        if (!dragging) {
          return;
        }
        container.scrollLeft = startLeft - (event.clientX - startX);
        container.scrollTop = startTop - (event.clientY - startY);
      });
      const stop = () => {
        dragging = false;
      };
      container.addEventListener('pointerup', stop);
      container.addEventListener('pointercancel', stop);
    }

    function bindEvents() {
      if (!dom.planDrawer) {
        return;
      }

      if (dom.planRefreshButton) {
        dom.planRefreshButton.addEventListener('click', () => load(currentConversationId(), { force: true }));
      }
      if (dom.planAddNodeButton) {
        dom.planAddNodeButton.addEventListener('click', addNode);
      }
      if (dom.planSaveButton) {
        dom.planSaveButton.addEventListener('click', () => {
          if (editDoc && dirty) {
            void persistDoc(editDoc, { successMessage: '规划图已保存' });
          }
        });
      }
      if (dom.planActivateButton) {
        dom.planActivateButton.addEventListener('click', () => {
          if (dirty) {
            showToast('有未保存修改，请先保存再开始执行');
            return;
          }
          if (window.confirm('开始执行后图结构将锁定（仅允许节点状态流转）。确认进入执行态？')) {
            void transition('activate');
          }
        });
      }
      if (dom.planRevertButton) {
        dom.planRevertButton.addEventListener('click', () => {
          if (window.confirm('退回草稿将解锁结构编辑，执行期的节点状态会保留。确认退回？')) {
            void transition('revert');
          }
        });
      }
      if (dom.planExpandButton) {
        dom.planExpandButton.addEventListener('click', () => setExpanded(!expanded));
      }
      if (dom.planExpandCloseButton) {
        dom.planExpandCloseButton.addEventListener('click', () => setExpanded(false));
      }
      if (dom.planZoomInButton) {
        dom.planZoomInButton.addEventListener('click', () => setZoom(zoom + 0.2));
      }
      if (dom.planZoomOutButton) {
        dom.planZoomOutButton.addEventListener('click', () => setZoom(zoom - 0.2));
      }
      if (dom.planZoomResetButton) {
        dom.planZoomResetButton.addEventListener('click', () => setZoom(1));
      }
      if (dom.planDrawerZoomInButton) {
        dom.planDrawerZoomInButton.addEventListener('click', () => setZoom(zoom + 0.2));
      }
      if (dom.planDrawerZoomOutButton) {
        dom.planDrawerZoomOutButton.addEventListener('click', () => setZoom(zoom - 0.2));
      }
      if (dom.planDrawerZoomFitButton) {
        dom.planDrawerZoomFitButton.addEventListener('click', fitZoom);
      }
      if (dom.planNodeDeleteButton) {
        dom.planNodeDeleteButton.addEventListener('click', deleteSelectedNode);
      }
      if (dom.planNodeStatus) {
        dom.planNodeStatus.addEventListener('change', () => {
          const node = selectedNode();
          if (!node || !dom.planNodeStatus) {
            return;
          }
          const nextStatus = dom.planNodeStatus.value;
          if (isActive()) {
            const doc = deepClone(plan.doc);
            const target = (doc.nodes || []).find((entry) => entry.id === node.id);
            if (target) {
              target.status = nextStatus;
              void persistDoc(doc, { successMessage: `节点 ${target.title || target.id} → ${STATUS_LABELS[nextStatus] || nextStatus}` });
            }
            return;
          }
          mutateDraftDoc((doc) => {
            const target = (doc.nodes || []).find((entry) => entry.id === node.id);
            if (target) {
              target.status = nextStatus;
            }
          });
        });
      }

      bindInput(dom.planNodeTitle, (target, value) => {
        target.title = value;
      });
      bindInput(dom.planNodeGoal, (target, value) => {
        target.goal = value;
      });
      bindInput(dom.planNodeBranch, (target, value) => {
        target.branch = value;
      });
      bindInput(dom.planNodeVerify, (target, value) => {
        if (value.trim()) {
          target.verify = value;
        } else {
          delete target.verify;
        }
      });
      bindInput(dom.planNodeBaseBranch, (target, value) => {
        if (value.trim()) {
          target.base_branch = value;
        } else {
          delete target.base_branch;
        }
      });
      if (dom.planNodeWorker) {
        dom.planNodeWorker.addEventListener('change', () => {
          const workerId = String(dom.planNodeWorker && dom.planNodeWorker.value || '').trim();
          mutateDraftDoc((doc) => {
            const target = (doc.nodes || []).find((entry) => entry.id === selectedNodeId);
            if (!target) {
              return;
            }
            if (workerId) {
              target.worker = workerId;
            } else {
              delete target.worker;
            }
            if (resolveParticipantId(target.verifier) === workerIdForNode(target)) {
              delete target.verifier;
            }
          });
          renderEditor();
        });
      }
      if (dom.planNodeVerifier) {
        dom.planNodeVerifier.addEventListener('change', () => {
          const verifierId = String(dom.planNodeVerifier && dom.planNodeVerifier.value || '').trim();
          mutateDraftDoc((doc) => {
            const target = (doc.nodes || []).find((entry) => entry.id === selectedNodeId);
            if (!target) {
              return;
            }
            if (verifierId) {
              target.verifier = verifierId;
            } else {
              delete target.verifier;
            }
          });
          renderEditor();
        });
      }
      if (dom.planNodeKind) {
        dom.planNodeKind.addEventListener('change', () => {
          if (!dom.planNodeKind) {
            return;
          }
          const kind = dom.planNodeKind.value;
          mutateDraftDoc((doc) => {
            const target = (doc.nodes || []).find((entry) => entry.id === selectedNodeId);
            if (target) {
              target.kind = kind === 'merge' ? 'merge' : 'work';
            }
          });
        });
      }

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && expanded) {
          setExpanded(false);
          return;
        }
        // Delete/Backspace 快捷删除选中节点（仅 draft 态，且焦点不在输入框里）
        if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeId && isDraft() && !saving) {
          const target = /** @type {HTMLElement | null} */ (event.target instanceof HTMLElement ? event.target : null);
          if (target && (target.closest('input, textarea, select, [contenteditable="true"]'))) {
            return;
          }
          event.preventDefault();
          deleteSelectedNode();
        }
      });

      bindDragPan(dom.planGraph);
      bindDragPan(dom.planGraphExpanded);
      bindWheelZoom(dom.planGraph);
      bindWheelZoom(dom.planGraphExpanded);
    }

    function render() {
      const conversationId = currentConversationId();
      if (!conversationId) {
        if (plan || loadedConversationId) {
          plan = null;
          loadedConversationId = '';
          editDoc = null;
          dirty = false;
          renderAll();
        }
        return;
      }
      if (conversationId !== loadedConversationId) {
        void load(conversationId);
        return;
      }
      renderAll();
    }

    return {
      bindEvents,
      render,
      applyPlanEvent,
      reload() {
        return load(currentConversationId(), { force: true });
      },
    };
  };
})();
