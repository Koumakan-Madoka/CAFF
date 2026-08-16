/**
 * DAG plan shared validation module.
 *
 * Reused by:
 * - server API (server/api/conversation-plan-controller.ts)
 * - agent tool thin wrapper (propose-plan)
 * - frontend bundle (plain JS, no server-only deps allowed here)
 *
 * Contract (PRD .trellis/tasks/dag-planning/prd.md, D3/D5):
 * - plan doc: { nodes: [{id, title, goal, status, depends_on[], branch,
 *   spawned_conversation_id, kind}], edges?: [{from, to}] }
 * - validation: unique node ids, depends_on references exist, acyclic,
 *   merge nodes with in-degree < 2 produce a warning
 * - active plans are structurally locked: only node `status` may change
 */

export const PLAN_STATUSES = ['draft', 'active', 'done', 'archived'] as const;
export const NODE_STATUSES = ['pending', 'doing', 'done', 'blocked'] as const;
export const NODE_KINDS = ['work', 'merge'] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type NodeKind = (typeof NODE_KINDS)[number];

export type PlanValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
};

export type PlanValidationResult = {
  ok: boolean;
  issues: PlanValidationIssue[];
  warnings: PlanValidationIssue[];
};

type AnyRecord = Record<string, any>;

function isPlainObject(value: any): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nodeKey(node: AnyRecord): string {
  return String(node && node.id || '').trim();
}

/** Derive the authoritative edge set from node.depends_on. */
export function derivePlanEdges(doc: AnyRecord): Array<{ from: string; to: string }> {
  const nodes = Array.isArray(doc && doc.nodes) ? doc.nodes : [];
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of nodes) {
    const to = nodeKey(node);
    const deps = Array.isArray(node && node.depends_on) ? node.depends_on : [];
    for (const dep of deps) {
      edges.push({ from: String(dep || '').trim(), to });
    }
  }
  return edges;
}

function findCycle(nodes: AnyRecord[]): string[] | null {
  const ids = new Set(nodes.map((node) => nodeKey(node)));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const depsOf = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = (Array.isArray(node.depends_on) ? node.depends_on : [])
      .map((dep: any) => String(dep || '').trim())
      .filter((dep: string) => ids.has(dep));
    depsOf.set(nodeKey(node), deps);
  }

  const visit = (id: string): string[] | null => {
    if (visited.has(id)) {
      return null;
    }
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return stack.slice(start).concat(id);
    }
    visiting.add(id);
    stack.push(id);
    for (const dep of depsOf.get(id) || []) {
      const cycle = visit(dep);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(nodeKey(node));
    if (cycle) {
      return cycle;
    }
  }
  return null;
}

/**
 * Validate a plan doc. Returns issues (hard errors, block writes) and
 * warnings (soft, surfaced to caller but do not block).
 */
export function validatePlanDoc(doc: any): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const warnings: PlanValidationIssue[] = [];

  if (!isPlainObject(doc)) {
    return {
      ok: false,
      issues: [{ code: 'plan_doc_invalid', message: 'Plan doc must be a JSON object' }],
      warnings,
    };
  }

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : null;
  if (!nodes) {
    return {
      ok: false,
      issues: [{ code: 'plan_nodes_missing', message: 'Plan doc must contain a nodes array' }],
      warnings,
    };
  }

  const seenIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    const label = `nodes[${index}]`;
    if (!isPlainObject(node)) {
      issues.push({ code: 'plan_node_invalid', message: `${label} must be an object` });
      continue;
    }
    const id = nodeKey(node);
    if (!id) {
      issues.push({ code: 'plan_node_id_missing', message: `${label}.id is required` });
    } else if (seenIds.has(id)) {
      issues.push({ code: 'plan_node_id_duplicate', message: `Duplicate node id: ${id}`, nodeId: id });
    } else {
      seenIds.add(id);
    }

    if (node.title !== undefined && typeof node.title !== 'string') {
      issues.push({ code: 'plan_node_title_invalid', message: `${label}.title must be a string`, nodeId: id });
    }
    if (node.goal !== undefined && typeof node.goal !== 'string') {
      issues.push({ code: 'plan_node_goal_invalid', message: `${label}.goal must be a string`, nodeId: id });
    }
    if (node.status !== undefined && !NODE_STATUSES.includes(node.status)) {
      issues.push({
        code: 'plan_node_status_invalid',
        message: `${label}.status must be one of ${NODE_STATUSES.join('/')}`,
        nodeId: id,
      });
    }
    if (node.kind !== undefined && !NODE_KINDS.includes(node.kind)) {
      issues.push({
        code: 'plan_node_kind_invalid',
        message: `${label}.kind must be one of ${NODE_KINDS.join('/')}`,
        nodeId: id,
      });
    }
    if (node.branch !== undefined && node.branch !== null && typeof node.branch !== 'string') {
      issues.push({ code: 'plan_node_branch_invalid', message: `${label}.branch must be a string`, nodeId: id });
    }
    if (
      node.spawned_conversation_id !== undefined
      && node.spawned_conversation_id !== null
      && typeof node.spawned_conversation_id !== 'string'
    ) {
      issues.push({
        code: 'plan_node_spawn_invalid',
        message: `${label}.spawned_conversation_id must be a string or null`,
        nodeId: id,
      });
    }
    if (node.depends_on !== undefined) {
      if (!Array.isArray(node.depends_on) || node.depends_on.some((dep: any) => typeof dep !== 'string')) {
        issues.push({
          code: 'plan_node_depends_invalid',
          message: `${label}.depends_on must be an array of node id strings`,
          nodeId: id,
        });
      }
    }
  }

  // depends_on reference integrity + self-dependency
  for (const node of nodes) {
    if (!isPlainObject(node) || !Array.isArray(node.depends_on)) {
      continue;
    }
    const id = nodeKey(node);
    for (const dep of node.depends_on) {
      if (typeof dep !== 'string') {
        continue;
      }
      const depId = dep.trim();
      if (depId === id) {
        issues.push({ code: 'plan_node_self_dependency', message: `Node ${id} depends on itself`, nodeId: id });
      } else if (depId && !seenIds.has(depId)) {
        issues.push({
          code: 'plan_dependency_missing',
          message: `Node ${id} depends on unknown node ${depId}`,
          nodeId: id,
        });
      }
    }
  }

  // edges (optional) must be consistent with depends_on
  if (doc.edges !== undefined) {
    if (!Array.isArray(doc.edges)) {
      issues.push({ code: 'plan_edges_invalid', message: 'edges must be an array of {from, to}' });
    } else {
      const derived = new Set(derivePlanEdges(doc).map((edge) => `${edge.from}->${edge.to}`));
      const declared = new Set<string>();
      for (const [index, edge] of doc.edges.entries()) {
        if (!isPlainObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
          issues.push({ code: 'plan_edge_invalid', message: `edges[${index}] must be {from, to} strings` });
          continue;
        }
        const key = `${edge.from.trim()}->${edge.to.trim()}`;
        declared.add(key);
        if (!seenIds.has(edge.from.trim()) || !seenIds.has(edge.to.trim())) {
          issues.push({ code: 'plan_edge_unknown_node', message: `edges[${index}] references unknown node: ${key}` });
        }
        if (!derived.has(key)) {
          issues.push({
            code: 'plan_edge_mismatch',
            message: `edges[${index}] ${key} is not backed by a depends_on entry`,
          });
        }
      }
      for (const key of derived) {
        if (!declared.has(key)) {
          issues.push({ code: 'plan_edge_mismatch', message: `depends_on edge ${key} missing from edges[]` });
        }
      }
    }
  }

  // acyclicity
  if (issues.length === 0) {
    const cycle = findCycle(nodes.filter(isPlainObject));
    if (cycle) {
      issues.push({ code: 'plan_cycle', message: `Plan contains a dependency cycle: ${cycle.join(' -> ')}` });
    }
  }

  // merge node in-degree warning
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    if (!isPlainObject(node)) {
      continue;
    }
    inDegree.set(nodeKey(node), 0);
  }
  for (const edge of derivePlanEdges(doc)) {
    if (inDegree.has(edge.to)) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }
  }
  for (const node of nodes) {
    if (isPlainObject(node) && node.kind === 'merge' && (inDegree.get(nodeKey(node)) || 0) < 2) {
      warnings.push({
        code: 'plan_merge_indegree',
        message: `Merge node ${nodeKey(node)} has in-degree < 2`,
        nodeId: nodeKey(node),
      });
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}

/** Fields whose change counts as a structural modification (locked when active). */
const STRUCTURAL_NODE_FIELDS = ['title', 'goal', 'depends_on', 'branch', 'kind', 'spawned_conversation_id'];

function normalizeForCompare(value: any): any {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }
  if (isPlainObject(value)) {
    const normalized: AnyRecord = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeForCompare(value[key]);
    }
    return normalized;
  }
  return value === undefined ? null : value;
}

/**
 * For active plans: verify that newDoc differs from oldDoc only in node
 * `status` fields. Returns issues describing any structural change attempt.
 */
export function validateStatusOnlyUpdate(oldDoc: any, newDoc: any): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const warnings: PlanValidationIssue[] = [];

  const oldNodes = new Map<string, AnyRecord>();
  for (const node of (oldDoc && Array.isArray(oldDoc.nodes) ? oldDoc.nodes : [])) {
    if (isPlainObject(node)) {
      oldNodes.set(nodeKey(node), node);
    }
  }
  const newNodes = new Map<string, AnyRecord>();
  for (const node of (newDoc && Array.isArray(newDoc.nodes) ? newDoc.nodes : [])) {
    if (isPlainObject(node)) {
      newNodes.set(nodeKey(node), node);
    }
  }

  for (const id of newNodes.keys()) {
    if (!oldNodes.has(id)) {
      issues.push({ code: 'plan_locked_node_added', message: `Active plan is locked: cannot add node ${id}`, nodeId: id });
    }
  }
  for (const id of oldNodes.keys()) {
    if (!newNodes.has(id)) {
      issues.push({ code: 'plan_locked_node_removed', message: `Active plan is locked: cannot remove node ${id}`, nodeId: id });
    }
  }
  for (const [id, newNode] of newNodes) {
    const oldNode = oldNodes.get(id);
    if (!oldNode) {
      continue;
    }
    for (const field of STRUCTURAL_NODE_FIELDS) {
      const before = JSON.stringify(normalizeForCompare(oldNode[field]));
      const after = JSON.stringify(normalizeForCompare(newNode[field]));
      if (before !== after) {
        issues.push({
          code: 'plan_locked_field_changed',
          message: `Active plan is locked: node ${id} field ${field} cannot change`,
          nodeId: id,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}
