#!/usr/bin/env node
'use strict';
// CAFF operations CLI (read-only by default; write commands need --confirm).
// Usage: node caff.js <command> [args] [--flags]   — run without args for help.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The skill ships at <checkout>/.claude/skills/caff-ops/scripts. Production runs
// from the main checkout (caff-workflow), so a linked worktree resolves to it.
function defaultCaffHome() {
  const checkout = path.resolve(__dirname, '..', '..', '..', '..');
  try {
    if (JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).name !== 'caff') return null;
  } catch {
    return null;
  }
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(checkout, '.git'), 'utf8'));
    if (pointer) {
      const gitDir = path.resolve(checkout, pointer[1].trim());
      return path.dirname(path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()));
    }
  } catch {
    // A main checkout has a .git directory, which readFileSync rejects.
  }
  return checkout;
}

const BASE = (process.env.CAFF_BASE_URL || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const CAFF_HOME = process.env.CAFF_HOME || defaultCaffHome();
const CAFF_PROJECT_ID = process.env.CAFF_PROJECT_ID || '';
const STATE_DIR = process.env.CAFF_OPS_STATE_DIR || path.join(os.homedir(), '.caff-ops');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_PATH_RE = /agent-sandboxes|PI_AGENT_PRIVATE_DIR|[\\/]private[\\/]/i;
// Matches real update-goal invocations, not prose that merely mentions the tool.
const GOAL_UPDATE_CALL_RE = /['"]update-goal['"]|update-goal\s+--|update-goal[\w-]*\.py/;

const HELP = `CAFF ops CLI  (base ${BASE}, home ${CAFF_HOME || '(not found; set CAFF_HOME)'})

Read-only:
  health                                  server health
  portfolio [--stale-min N] [--idle-hours H] [--all] [--json] [--no-save]
                                          every room with a Goal, attention flags first
  rooms [keyword] [--limit N]             search rooms (conversations), newest first
  status <room>                           light room status: goal / proposal / runner / last message
  goal <room> [--json]                    goal details (objective, criteria, work items, evidence)
  messages <room> [--limit N] [--full] [--before CURSOR]
  search <room> <regex> [--sender NAME] [--max N]
                                          grep the whole room history, oldest hit first
  trace <room> <messageId>                one assistant turn: session reuse, model calls, failures
  rounds <room> [--agent ID] [--since today|all|ISO] [--sessions-dir DIR]
                                          per-turn time breakdown from session JSONL logs
  preview <room> (--file F | --text T)    routing preview (who would be triggered), sends nothing

Planner API (CAFF with ADR 0002 P1; needs the planner credential file):
  state <room>                            bounded Goal state (goal/proposal/ruling/runner/busy/lastTurn)
  attention [--status unresolved|resolved|all] [--after N] [--room R] [--limit N]
                                          durable attention items (cursor = creation sequence)
  wait-attention [--after N] [--status S] [--room R] [--timeout SEC] [--max-minutes M]
                                          long-poll until an item arrives; exit 0 = items, 2 = timed out

Write (within an approved decision or the ADR 0002 delegated scope; reserved items need the user first; add --confirm):
  send <room> (--file F | --text T) --confirm
  goal-action <room> pause|resume|accept-proposal|dismiss-proposal [--reason R] --confirm
                                          [--allow-clear-proposal] supersedes a pending proposal (audited)
  stop <room> [--reason R] [--stop-goal] --confirm
  create-room --title T --participants gpt,kimi,... [--project ID] [--mode M] [--key K] --confirm
                                          default project: the one whose path is CAFF_HOME
  bind-workspace <room> --confirm         bind the room to its room/* branch and worktree (preview first)
  set-goal <room> --file goal.json [--owner gpt] [--paused] [--allow-clear-proposal] --confirm
                                          planner set with owner/initial status (reserved: user approves the Goal)
  revise <room> --file patch.json [--reason R --impact I] [--affected w1,w2] [--allow-clear-proposal] --confirm
                                          merge-revise the Goal; a supplied collection lists every ID to keep
                                          (delegated only for work items, provisional decisions, open questions)
  ack <sequence> --reason R --confirm     acknowledge a goal_completed / turn_failed attention item

<room> = conversation UUID, its first 8 characters, or a title keyword (exact title wins; ambiguous keywords list candidates).
Env: CAFF_BASE_URL (default http://127.0.0.1:3100),
     CAFF_HOME (default: the CAFF checkout holding this script; a linked worktree uses its main checkout),
     CAFF_PROJECT_ID (create-room default project), CAFF_OPS_STATE_DIR (portfolio snapshot, default ~/.caff-ops),
     CAFF_PLANNER_CREDENTIAL_FILE (override), CAFF_PLANNER_BIND_HOST (server bind host if it differs from the base URL host).
Writes carry the planner credential when its file exists (default %LOCALAPPDATA%\\CAFF\\planner\\planner-<sha256(host)>-<port>.json);
without it they are sent the old way, which a P1 server rejects.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

// Planner credential (ADR 0002 P1). The server writes it on start to
// <LOCALAPPDATA>/CAFF/planner/planner-<sha256(bind host)>-<port>.json (POSIX:
// $XDG_STATE_HOME/caff/planner/...). The file never leaves this process.
function plannerCredentialFile() {
  if (process.env.CAFF_PLANNER_CREDENTIAL_FILE) return process.env.CAFF_PLANNER_CREDENTIAL_FILE;
  let url;
  try { url = new URL(BASE); } catch { return null; }
  const host = String(process.env.CAFF_PLANNER_BIND_HOST || url.hostname).trim().toLowerCase().replace(/^\[([^\]]+)\]$/, '$1');
  const port = Number(url.port || 80);
  const hash = crypto.createHash('sha256').update(host, 'utf8').digest('hex');
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA
    : (process.env.XDG_STATE_HOME || (process.env.HOME ? path.join(process.env.HOME, '.local', 'state') : ''));
  if (!base) return null;
  return path.join(base, process.platform === 'win32' ? 'CAFF' : 'caff', 'planner', `planner-${hash}-${port}.json`);
}

let cachedPlannerCredential;
function plannerCredential() {
  if (cachedPlannerCredential !== undefined) return cachedPlannerCredential;
  cachedPlannerCredential = null;
  const file = plannerCredentialFile();
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.token)) {
      cachedPlannerCredential = { token: data.token, plannerName: data.plannerName || 'External Planner', file };
    }
  } catch {
    // Missing or unreadable: fall back to the pre-P1 request shape.
  }
  return cachedPlannerCredential;
}

async function api(method, pathname, body, extraHeaders = {}) {
  const write = !['GET', 'HEAD'].includes(method);
  const planner = write || pathname.startsWith('/api/planner/') ? plannerCredential() : null;
  const headers = { ...extraHeaders };
  if (write) headers['content-type'] = 'application/json';
  if (planner) {
    headers.authorization = `Bearer ${planner.token}`;
    headers['x-caff-principal'] = 'planner';
  }
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: write ? JSON.stringify(body || {}) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail = json ? (json.error || json.message || JSON.stringify(json)) : text;
    const code = json && json.code ? ` [${json.code}]` : '';
    const hint = !planner && write && [401, 403, 415].includes(response.status)
      ? `\nhint: no planner credential found at ${plannerCredentialFile() || '(unknown path)'}; a P1 server only accepts planner-authenticated writes from this CLI.`
      : '';
    const error = new Error(`HTTP ${response.status} ${method} ${pathname}${code}: ${String(detail).slice(0, 400)}${hint}`);
    error.status = response.status;
    throw error;
  }
  return json;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmt(value) {
  if (value === undefined || value === null || value === '') return '-';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function oneLine(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return max && flat.length > max ? `${flat.slice(0, max)}…(${flat.length})` : flat;
}

function minutes(ms) {
  return `${(ms / 60000).toFixed(1)}m`;
}

async function resolveRoom(arg) {
  if (!arg) throw new Error('missing <room> (conversation UUID, 8-char ID prefix, or title keyword)');
  if (UUID_RE.test(arg)) return arg;
  if (/^[0-9a-f]{8}$/i.test(arg)) {
    // portfolio prints 8-char prefixes; resolve them against the full room list.
    const matches = (await listAllRooms()).filter((room) => room.id.startsWith(arg.toLowerCase()));
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error(`ID prefix ${arg} is ambiguous: ${matches.map((room) => room.id).join(', ')}`);
  }
  const page = await api('GET', `/api/conversations?limit=100&q=${encodeURIComponent(arg)}`);
  const items = page.conversations || [];
  const exact = items.filter((item) => item.title === arg);
  if (exact.length === 1) return exact[0].id;
  if (items.length === 1) return items[0].id;
  const list = items.slice(0, 15).map((item) => `  ${item.id}  ${oneLine(item.title, 60)}  (last ${fmt(item.lastMessageAt)})`).join('\n');
  throw new Error(items.length === 0
    ? `no room matches "${arg}"`
    : `"${arg}" matches ${items.length} rooms; pass the UUID:\n${list}`);
}

async function getConversation(roomId) {
  const payload = await api('GET', `/api/conversations/${encodeURIComponent(roomId)}`);
  return payload.conversation;
}

function readContent(flags) {
  let content = null;
  if (typeof flags.file === 'string') content = fs.readFileSync(flags.file, 'utf8');
  else if (typeof flags.text === 'string') content = flags.text;
  if (content === null) throw new Error('provide the message with --file <utf8 file> or --text "..."');
  content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
  if (!content) throw new Error('message content is empty');
  return content;
}

function requireConfirm(flags, what) {
  if (flags.confirm === true) return;
  console.log(`\nNOT EXECUTED: ${what} changes CAFF state. Get the user's explicit approval for this exact action, then rerun with --confirm.`);
  process.exitCode = 3;
  throw new Error('__stop__');
}

function summarizeGoal(goal) {
  if (!goal) return 'none';
  const criteria = goal.acceptanceCriteria || [];
  const work = goal.workItems || [];
  const count = (items, status) => items.filter((item) => item.status === status).length;
  return [
    `${goal.goalId || '(legacy)'} rev ${goal.revision} ${goal.status}`,
    `owner ${goal.owner ? goal.owner.agentName : '-'}`,
    `criteria ${count(criteria, 'passed')}/${criteria.length} passed`,
    `work ${count(work, 'done')} done / ${count(work, 'in_progress')} in_progress / ${count(work, 'todo')} todo`,
    `evidence ${(goal.evidence || []).length}`,
    `updated ${fmt(goal.updatedAt)}`,
  ].join(' | ');
}

function ago(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

function when(ms) {
  if (!ms) return '-';
  const date = new Date(ms);
  const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hm}`;
}

async function listAllRooms(maxPages = 20) {
  const rooms = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const result = await api('GET', `/api/conversations?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    rooms.push(...(result.conversations || []));
    if (!result.hasMore || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return rooms;
}

// Work-item and criterion statuses only; revision bumps from evidence edits do not count as progress.
function goalStatusKey(goal) {
  return [...(goal.workItems || []), ...(goal.acceptanceCriteria || [])]
    .map((item) => `${item.id}:${item.status}`)
    .join('|');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function portfolioRow(room, previousRooms, now, staleMs, idleMs) {
  const meta = room.metadata || {};
  const goal = meta.sessionGoal;
  const runner = meta.sessionGoalRunner;
  const proposal = meta.sessionGoalProposal;
  const statusKey = goalStatusKey(goal);
  const before = previousRooms[room.id];
  const unchanged = Boolean(before && before.goalId === goal.goalId && before.statusKey === statusKey);
  const snapshot = {
    goalId: goal.goalId,
    statusKey,
    lastStatusChangeAt: unchanged ? before.lastStatusChangeAt : now,
    baselineRevision: unchanged ? before.baselineRevision : goal.revision,
  };
  const lastAt = Date.parse(room.lastMessageAt || room.updatedAt || '') || 0;
  const idleFor = now - lastAt;
  const active = goal.status === 'active';
  const stale = active && idleFor > staleMs;
  const criteria = goal.acceptanceCriteria || [];
  const flags = [];
  if (proposal) {
    // The runner never auto-continues while a proposal is pending (claimSessionGoalAutoContinue).
    const waited = now - (Date.parse(proposal.createdAt || '') || now);
    const allPassed = criteria.length > 0 && criteria.every((c) => c.status === 'passed' || c.status === 'waived');
    flags.push({
      level: stale ? 2 : 1,
      text: `${proposal.action} 提案等裁决 ${ago(waited)}${stale ? `，期间 ${ago(idleFor)}没有新消息（裁决前不会自动续跑）` : ''}${proposal.action === 'complete' && allPassed ? '；验收标准已全部通过，可以结项' : ''}`,
    });
  } else if (stale) {
    let reason = '没有待裁决提案、runner 也没跑满，自动续跑可能出了问题';
    if (runner && (runner.status === 'budget_limited' || runner.iteration >= runner.maxIterations)) {
      reason = `runner 已跑满 ${runner.iteration}/${runner.maxIterations}，需要人工续`;
    } else if (/^Thinking/i.test(String(room.lastMessagePreview || ''))) {
      reason = '最后一轮停在进行中，可能已中断';
    }
    flags.push({ level: 2, text: `Goal 是 active，但 ${ago(idleFor)}没有新消息：${reason}` });
  }
  if (runner && ((runner.consecutiveFailureCount || 0) > 0 || (runner.consecutiveModelFailureCount || 0) > 0)) {
    flags.push({ level: 2, text: `连续失败 ${runner.consecutiveFailureCount || 0} 次（其中模型失败 ${runner.consecutiveModelFailureCount || 0} 次）` });
  }
  if (active && idleFor <= staleMs && runner && runner.maxIterations
    && runner.iteration >= runner.maxIterations - 2 && runner.iteration < runner.maxIterations) {
    flags.push({ level: 1, text: `runner 即将跑满 ${runner.iteration}/${runner.maxIterations}` });
  }
  const revisionDelta = goal.revision - snapshot.baselineRevision;
  if (active && unchanged && now - snapshot.lastStatusChangeAt > idleMs && revisionDelta >= 3) {
    flags.push({ level: 1, text: `${ago(now - snapshot.lastStatusChangeAt)}里 revision +${revisionDelta}，但工作项和验收标准的状态都没变` });
  }
  const section = flags.length ? 'attention' : active ? 'active' : goal.status === 'paused' ? 'paused' : 'done';
  return {
    room,
    goal,
    runner,
    flags,
    section,
    lastAt,
    isChild: Boolean(room.parentConversationId) || Number(room.treeDepth) > 0,
    snapshot,
  };
}

function portfolioLine(row) {
  const { room, goal, runner } = row;
  const work = goal.workItems || [];
  const criteria = goal.acceptanceCriteria || [];
  const count = (items, status) => items.filter((item) => item.status === status).length;
  const doing = count(work, 'in_progress');
  return [
    `[${room.id.slice(0, 8)}] ${row.isChild ? '↳ ' : ''}${oneLine(room.title, 26)}`,
    `Goal ${goal.revision !== undefined ? `rev${goal.revision}` : '(旧版)'} ${goal.status}`,
    goal.owner ? `owner ${goal.owner.agentName}` : null,
    work.length ? `工作项 ${count(work, 'done')}/${work.length}${doing ? `（进行中 ${doing}）` : ''}` : null,
    criteria.length ? `标准 ${count(criteria, 'passed')}/${criteria.length}` : null,
    runner && goal.status === 'active' ? `runner ${runner.iteration}/${runner.maxIterations}` : null,
    `最后活动 ${when(row.lastAt)}`,
  ].filter(Boolean).join(' · ');
}

const commands = {
  async health() {
    console.log(JSON.stringify(await api('GET', '/api/health'), null, 2));
  },

  async portfolio({ flags }) {
    const now = Date.now();
    const staleMs = (Number(flags['stale-min']) || 90) * 60000;
    const idleMs = (Number(flags['idle-hours']) || 6) * 3600000;
    const snapshotFile = path.join(STATE_DIR, 'portfolio-snapshot.json');
    const previous = readJsonFile(snapshotFile);
    const previousRooms = (previous && previous.rooms) || {};
    const rows = (await listAllRooms())
      .filter((room) => room.metadata && room.metadata.sessionGoal)
      .map((room) => portfolioRow(room, previousRooms, now, staleMs, idleMs));

    if (!flags['no-save']) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const rooms = Object.fromEntries(rows.map((row) => [row.room.id, row.snapshot]));
      fs.writeFileSync(snapshotFile, JSON.stringify({ savedAt: new Date(now).toISOString(), rooms }, null, 1));
    }
    if (flags.json) {
      console.log(JSON.stringify(rows.map((row) => ({
        id: row.room.id,
        title: row.room.title,
        section: row.section,
        child: row.isChild,
        goal: { revision: row.goal.revision, status: row.goal.status, owner: row.goal.owner ? row.goal.owner.agentName : null },
        runner: row.runner ? { iteration: row.runner.iteration, maxIterations: row.runner.maxIterations } : null,
        lastActivity: row.lastAt ? new Date(row.lastAt).toISOString() : null,
        flags: row.flags.map((flag) => flag.text),
      })), null, 2));
      return;
    }

    const bySection = (name) => rows.filter((row) => row.section === name);
    const attention = bySection('attention').sort((a, b) =>
      Math.max(...b.flags.map((f) => f.level)) - Math.max(...a.flags.map((f) => f.level)) || b.lastAt - a.lastAt);
    const recent = (list) => list.sort((a, b) => b.lastAt - a.lastAt);
    console.log(`CAFF 项目总览 · ${when(now)} · ${rows.length} 个 room 挂着 Goal${previous ? ` · 对比上次快照 ${when(Date.parse(previous.savedAt))}` : ' · 首次快照，"停滞"要从下次开始判断'}`);
    console.log(`\n需要关注（${attention.length}）`);
    for (const row of attention) {
      console.log(`  ⚠ ${portfolioLine(row)}`);
      for (const flag of row.flags) console.log(`      → ${flag.text}`);
    }
    for (const [name, label] of [['active', '正常推进'], ['paused', '已暂停']]) {
      const list = recent(bySection(name));
      console.log(`\n${label}（${list.length}）`);
      for (const row of list) console.log(`    ${portfolioLine(row)}`);
    }
    const done = recent(bySection('done'));
    console.log(`\n已完成（${done.length}）${flags.all ? '' : '，加 --all 显示'}`);
    if (flags.all) for (const row of done) console.log(`    ${portfolioLine(row)}`);
    console.log(`\n深入查看：node caff.js status <8 位 ID>；快照保存在 ${snapshotFile}${flags['no-save'] ? '（本次未更新）' : ''}`);
  },

  async rooms({ positional, flags }) {
    const limit = Math.min(100, Math.max(1, Number(flags.limit) || 20));
    const query = positional[0] ? `&q=${encodeURIComponent(positional[0])}` : '';
    const page = await api('GET', `/api/conversations?limit=${limit}${query}`);
    for (const room of page.conversations || []) {
      const meta = room.metadata || {};
      const goal = meta.sessionGoal;
      const runner = meta.sessionGoalRunner;
      console.log([
        room.id,
        oneLine(room.title, 50),
        `last ${fmt(room.lastMessageAt)}`,
        `${room.messageCount} msgs`,
        goal ? `goal rev ${goal.revision} ${goal.status}` : 'no goal',
        runner ? `runner ${runner.status} ${runner.iteration}/${runner.maxIterations}` : '',
      ].filter(Boolean).join(' | '));
    }
    if (page.hasMore) console.log('(more rooms exist; refine the keyword or raise --limit up to 100)');
  },

  async status({ positional }) {
    const roomId = await resolveRoom(positional[0]);
    const room = await getConversation(roomId);
    const meta = room.metadata || {};
    const proposal = meta.sessionGoalProposal;
    const ruling = meta.sessionGoalRuling;
    const runner = meta.sessionGoalRunner;
    console.log(`${room.title}  (${room.id})`);
    console.log(`agents: ${(room.agents || []).map((agent) => `${agent.name}=${agent.id}`).join(', ')}`);
    console.log(`workspace: ${room.branch || '-'}  ${room.worktreePath || ''}`);
    console.log(`last message ${fmt(room.lastMessageAt)} | ${room.messageCount} msgs | ${oneLine(room.lastMessagePreview, 120)}`);
    console.log(`goal: ${summarizeGoal(meta.sessionGoal)}`);
    console.log(`proposal: ${proposal
      ? `${proposal.action} by ${proposal.proposedBy ? proposal.proposedBy.agentName || proposal.proposedBy.kind : '?'} at ${fmt(proposal.createdAt)} baseRevision ${proposal.baseRevision} | ${oneLine(proposal.reason, 160)}`
      : 'none pending'}`);
    if (ruling) {
      console.log(`last ruling: ${ruling.action} ${ruling.outcome} by ${ruling.ruledBy ? ruling.ruledBy.agentName || ruling.ruledBy.kind : '?'} at ${fmt(ruling.ruledAt || ruling.createdAt)}`);
    }
    if (runner) {
      const failures = runner.failureThreshold !== undefined
        ? ` | failures consecutive ${runner.consecutiveFailureCount || 0}/${runner.failureThreshold}, model ${runner.consecutiveModelFailureCount || 0}`
        : '';
      console.log(`runner: ${runner.status} iteration ${runner.iteration}/${runner.maxIterations} | last continued ${fmt(runner.lastContinuedAt)}${failures}`);
      if (meta.sessionGoal && meta.sessionGoal.status !== 'active') {
        console.log('note: runner fields keep their last value; the goal is not active, so no auto-continuation will start.');
      }
    }
  },

  async goal({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const room = await getConversation(roomId);
    let goal = room.metadata && room.metadata.sessionGoal;
    if (goal && !goal.goalId) {
      // Legacy goal: ask the server for the normalized projection (large response).
      goal = (await api('GET', `/api/conversations/${encodeURIComponent(roomId)}/goal`)).goal;
    }
    if (!goal) {
      console.log('no goal set');
      return;
    }
    if (flags.json) {
      console.log(JSON.stringify(goal, null, 2));
      return;
    }
    console.log(summarizeGoal(goal));
    console.log(`\nobjective (${goal.objective.length} chars): ${goal.objective}`);
    const decisions = goal.decisions || {};
    console.log(`\ndecisions: ${Object.entries(decisions).map(([key, items]) => `${key} ${Array.isArray(items) ? items.length : 0}`).join(', ')}`);
    for (const item of decisions.committed || []) console.log(`  [committed] ${item.id}: ${oneLine(item.statement, 160)}`);
    console.log('\nacceptance criteria:');
    for (const criterion of goal.acceptanceCriteria || []) {
      console.log(`  ${criterion.id} | ${criterion.status} | evidenceRefs ${(criterion.evidenceRefs || []).length} | ${oneLine(criterion.statement, 140)}`);
    }
    console.log('\nwork items:');
    for (const item of goal.workItems || []) console.log(`  ${item.id} | ${item.status} | ${oneLine(item.text, 140)}`);
    console.log('\nevidence:');
    for (const item of goal.evidence || []) {
      console.log(`  ${item.id} [${item.kind}] -> ${(item.criterionIds || []).join(',') || '-'} | ${item.summary.length} chars | ${oneLine(item.summary, 120)}`);
    }
    const size = JSON.stringify(goal).length;
    console.log(`\nsize: ${size} chars (evidence ${JSON.stringify(goal.evidence || []).length})`);
  },

  async messages({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const limit = Math.min(100, Math.max(1, Number(flags.limit) || 10));
    const before = typeof flags.before === 'string' ? `&before=${encodeURIComponent(flags.before)}` : '';
    const page = await api('GET', `/api/conversations/${encodeURIComponent(roomId)}/messages?limit=${limit}${before}`);
    for (const message of page.items || []) {
      const content = flags.full ? String(message.content || '') : oneLine(message.content, 300);
      console.log(`\n[${fmt(message.createdAt)}] ${message.senderName} (${message.role}, ${message.status}) id=${message.id}`);
      console.log(content);
      if (message.errorMessage) console.log(`ERROR: ${oneLine(message.errorMessage, 300)}`);
    }
    if (page.hasMore) console.log(`\n(older messages: --before ${page.nextCursor})`);
  },

  async search({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    if (!positional[1]) throw new Error('usage: search <room> <regex> [--sender NAME] [--max N]');
    const pattern = new RegExp(positional[1], 'i');
    const max = Math.max(1, Number(flags.max) || 50);
    const hits = [];
    let before = '';
    for (let pageNo = 0; pageNo < 200; pageNo += 1) {
      const page = await api('GET', `/api/conversations/${encodeURIComponent(roomId)}/messages?limit=100${before}`);
      for (const message of page.items || []) {
        if (typeof flags.sender === 'string' && message.senderName !== flags.sender) continue;
        const content = String(message.content || '');
        const match = pattern.exec(content);
        if (match) hits.push({ message, at: match.index });
      }
      if (!page.hasMore) break;
      before = `&before=${encodeURIComponent(page.nextCursor)}`;
    }
    hits.sort((a, b) => String(a.message.createdAt).localeCompare(String(b.message.createdAt)));
    for (const { message, at } of hits.slice(0, max)) {
      const content = String(message.content || '');
      console.log(`\n[${fmt(message.createdAt)}] ${message.senderName} (${message.role}) id=${message.id}`);
      console.log(oneLine(content.slice(Math.max(0, at - 80)), 300));
    }
    console.log(`\n${hits.length} hit(s)${hits.length > max ? `, showing the oldest ${max} (raise --max or narrow the regex)` : ''}`);
  },

  async trace({ positional }) {
    const roomId = await resolveRoom(positional[0]);
    const messageId = positional[1];
    if (!messageId) throw new Error('usage: trace <room> <assistant messageId>');
    const { trace } = await api('GET', `/api/conversations/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/tool-trace`);
    const message = trace.message || {};
    const usage = trace.modelUsageSummary || {};
    const summary = trace.summary || {};
    console.log(`message ${message.id} ${message.status} created ${fmt(message.createdAt)} run ${message.runId}`);
    console.log(`session reused: ${message.sessionReused} (${message.sessionReuseReason || '-'})`);
    console.log(`session log: ${trace.task ? trace.task.sessionPath : '-'}`);
    console.log(`model calls ${usage.modelCallCount} (cold ${usage.coldStartModelCallCount}) | tool executions ${summary.toolExecutionCount} | failed steps ${summary.failedSteps} | retries ${summary.retryCount}`);
    if (trace.failureContext && trace.failureContext.hasFailure) {
      console.log(`failure: ${trace.failureContext.toolName} ${oneLine(trace.failureContext.summary, 300)}`);
    }
    const tools = {};
    for (const step of trace.steps || []) tools[step.toolName] = (tools[step.toolName] || 0) + 1;
    console.log(`retained steps by tool (window may be truncated): ${JSON.stringify(tools)}`);
  },

  async rounds({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const dir = typeof flags['sessions-dir'] === 'string' ? flags['sessions-dir'] : CAFF_HOME && path.join(CAFF_HOME, '.pi-sandbox', 'named-sessions');
    if (!dir || !fs.existsSync(dir)) {
      throw new Error(`session log directory ${dir || '(unknown)'} not found; pass --sessions-dir <agent dir>/named-sessions or set CAFF_HOME`);
    }
    let since = new Date();
    since.setHours(0, 0, 0, 0);
    if (flags.since === 'all') since = new Date(0);
    else if (typeof flags.since === 'string' && flags.since !== 'today') since = new Date(flags.since);
    const agent = typeof flags.agent === 'string' ? flags.agent : '';
    const files = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`chat-${roomId}-`) && name.endsWith('.jsonl') && (!agent || name.includes(agent)))
      .map((name) => ({ name, full: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .filter((file) => file.mtime >= since.getTime())
      .sort((a, b) => a.mtime - b.mtime);
    if (files.length === 0) {
      console.log(`no session logs for ${roomId} since ${fmt(since.getTime())} in ${dir}`);
      return;
    }
    const totals = { n: 0, wall: 0, model: 0, firstEdit: 0, firstEditN: 0, longRun: 0 };
    for (const file of files) {
      const round = analyzeSession(file.full);
      if (!round) continue;
      totals.n += 1;
      totals.wall += round.wall;
      totals.model += round.model;
      totals.longRun += round.longRuns.reduce((sum, run) => sum + run.ms, 0);
      if (round.firstEdit !== null) {
        totals.firstEdit += round.firstEdit;
        totals.firstEditN += 1;
      }
      const goalUpdates = Object.entries(round.goalUpdates).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
      console.log(`${fmt(round.start)} ${round.agent} | wall ${minutes(round.wall)} | model ${minutes(round.model)} (${round.calls} calls) | tools ${minutes(round.tool)} | first repo edit ${round.firstEdit === null ? '-' : `@${minutes(round.firstEdit)}`} | edits ${round.edits} reads ${round.reads} | update-goal: ${goalUpdates} | ctx max ${Math.round(round.maxCtx / 1000)}k`);
      for (const run of round.longRuns) console.log(`    long run ${minutes(run.ms)}: ${run.command}`);
    }
    if (totals.n > 0) {
      console.log(`\n${totals.n} turns | avg wall ${minutes(totals.wall / totals.n)} | model share ${Math.round((100 * totals.model) / totals.wall)}% | avg time to first repo edit ${totals.firstEditN ? minutes(totals.firstEdit / totals.firstEditN) : '-'} | avg long-run time ${minutes(totals.longRun / totals.n)}`);
    }
  },

  async preview({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const content = readContent(flags);
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/routing-preview`, { content });
    console.log(`would trigger: ${(result.agents || []).map((agent) => agent.name).join(', ') || '(nobody)'} | strategy ${result.strategy} | mode ${result.executionMode}${result.explicitIntent ? ` | intent ${result.explicitIntent}` : ''}`);
    return result;
  },

  async send({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const content = readContent(flags);
    await commands.preview({ positional: [roomId], flags });
    console.log(`content: ${content.length} chars, starts "${oneLine(content, 80)}"`);
    requireConfirm(flags, 'Sending a message');
    // Reuse --request-id on a retry: the server deduplicates by clientRequestId
    // and a P1 server acknowledges the duplicate without dispatching it again.
    // Print it before posting: when the server accepts the message but the
    // response is lost, this line is the only record of the ID to retry with.
    const clientRequestId = typeof flags['request-id'] === 'string' ? flags['request-id'] : `claude-code-${Date.now()}`;
    console.log(`request ${clientRequestId}: if this send fails, retry with --request-id ${clientRequestId}`);
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/messages`, { content, clientRequestId });
    const accepted = result.acceptedMessage || {};
    console.log(`sent: message ${accepted.id}${accepted.turnId ? ` turn ${accepted.turnId}` : ''} as "${accepted.senderName}"`
      + `${accepted.createdAt ? ` at ${fmt(accepted.createdAt)}` : ''} | request ${clientRequestId}`
      + `${result.duplicate || result.dispatch === 'duplicate' ? ' | duplicate: already accepted, not dispatched again' : result.dispatch ? ` | dispatch ${result.dispatch}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await commands.messages({ positional: [roomId], flags: { limit: 3 } });
  },

  async 'goal-action'({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const action = positional[1];
    const allowed = ['pause', 'resume', 'accept-proposal', 'dismiss-proposal'];
    if (!allowed.includes(action)) throw new Error(`action must be one of ${allowed.join(', ')}`);
    const room = await getConversation(roomId);
    const meta = room.metadata || {};
    const goal = meta.sessionGoal;
    const proposal = meta.sessionGoalProposal;
    console.log(`goal: ${summarizeGoal(goal)}`);
    console.log(`proposal: ${proposal ? `${proposal.action} baseRevision ${proposal.baseRevision}` : 'none'}`);
    if ((action === 'pause' || action === 'resume') && proposal && !flags['allow-clear-proposal']) {
      throw new Error(`a ${proposal.action} proposal is pending; rule on it first, or pass --allow-clear-proposal to supersede it (a P1 server records a superseded ruling; an older server clears it silently).`);
    }
    if (action === 'accept-proposal' && proposal && proposal.baseRevision !== undefined && goal && proposal.baseRevision !== goal.revision) {
      console.log(`warning: proposal baseRevision ${proposal.baseRevision} != goal revision ${goal.revision}; the server will reject it (409). Ask the proposer to resubmit.`);
    }
    requireConfirm(flags, `Goal action "${action}"`);
    // P1 planner writes must name the Goal they read (null/0 when none exists)
    // and the exact pending proposal for rulings and supersession.
    const body = { action, goalId: goal ? goal.goalId : null, goalRevision: goal ? goal.revision : 0 };
    if (typeof flags.reason === 'string') body.reason = flags.reason;
    if (proposal && (action === 'accept-proposal' || action === 'dismiss-proposal')) body.proposalId = proposal.id;
    if (proposal && (action === 'pause' || action === 'resume') && flags['allow-clear-proposal']) {
      body.supersedeProposal = true;
      body.proposalId = proposal.id;
    }
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/goal`, body);
    console.log(`done: goal ${summarizeGoal(result.goal)} | proposal ${result.proposal ? result.proposal.action : 'none'}`
      + `${result.ruling ? ` | ruling ${result.ruling.outcome} by ${(result.ruling.ruledBy || {}).kind}` : ''}`
      + `${result.autoContinuation ? ` | continuation ${result.autoContinuation.scheduled ? 'scheduled' : `not scheduled (${result.autoContinuation.reason})`}` : ''}`);
  },

  async stop({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    requireConfirm(flags, 'Stopping room execution');
    const body = { reason: typeof flags.reason === 'string' ? flags.reason : 'stopped by Claude Code on user request', stopGoal: flags['stop-goal'] === true };
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/stop`, body);
    console.log(`stop requested: turn ${result.turn ? JSON.stringify(result.turn).slice(0, 200) : 'none'} | goal ${result.goal ? `${result.goal.status} rev ${result.goal.revision}` : 'unchanged'}`);
  },

  async 'set-goal'({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    if (typeof flags.file !== 'string') throw new Error('--file goal.json is required (objective, decisions, acceptanceCriteria, workItems)');
    const draft = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
    const room = await getConversation(roomId);
    const meta = room.metadata || {};
    const goal = meta.sessionGoal;
    const proposal = meta.sessionGoalProposal;
    if (goal) console.log(`warning: replaces the existing Goal ${summarizeGoal(goal)}; back it up first (see SKILL.md).`);
    if (proposal && !flags['allow-clear-proposal']) {
      throw new Error(`a ${proposal.action} proposal is pending; rule on it first, or pass --allow-clear-proposal to supersede it.`);
    }
    const owner = typeof flags.owner === 'string' ? flags.owner : '';
    const body = {
      ...draft,
      action: 'set',
      goalId: goal ? goal.goalId : null,
      goalRevision: goal ? goal.revision : 0,
      ...(owner ? { owner: { agentId: owner.startsWith('role-') ? owner : `role-family-${owner}` } } : {}),
      status: flags.paused ? 'paused' : 'active',
      ...(typeof flags.reason === 'string' ? { reason: flags.reason } : {}),
      ...(proposal && flags['allow-clear-proposal'] ? { supersedeProposal: true, proposalId: proposal.id } : {}),
    };
    console.log(`set Goal in ${roomId} | owner ${body.owner ? body.owner.agentId : '(default routing)'} | initial ${body.status}`
      + ` | criteria ${(draft.acceptanceCriteria || []).length} | work items ${(draft.workItems || []).length}`);
    requireConfirm(flags, 'Setting a Goal (reserved: needs the user\'s approval of this Goal)');
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/goal`, body);
    console.log(`done: goal ${summarizeGoal(result.goal)} | continuation ${result.autoContinuation ? JSON.stringify(result.autoContinuation).slice(0, 120) : 'none'}`);
  },

  async revise({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    if (typeof flags.file !== 'string') throw new Error('--file patch.json is required (partial delivery: decisions, acceptanceCriteria, workItems and/or evidence)');
    const patch = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
    const room = await getConversation(roomId);
    const meta = room.metadata || {};
    const goal = meta.sessionGoal;
    const proposal = meta.sessionGoalProposal;
    if (!goal) throw new Error('no Goal to revise');
    if (proposal && !flags['allow-clear-proposal']) {
      throw new Error(`a ${proposal.action} proposal is pending; rule on it first, or pass --allow-clear-proposal to supersede it.`);
    }
    // P1 merge semantics: omitted collections keep their values; a supplied
    // collection replaces the old one, so it must list every ID to retain.
    const body = {
      ...patch,
      action: 'revise',
      goalId: goal.goalId,
      goalRevision: goal.revision,
      ...(typeof flags.reason === 'string' ? { reason: flags.reason } : {}),
      ...(typeof flags.impact === 'string' ? { impact: flags.impact } : {}),
      ...(typeof flags.affected === 'string' ? { affectedWorkItems: flags.affected.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      ...(proposal && flags['allow-clear-proposal'] ? { supersedeProposal: true, proposalId: proposal.id } : {}),
    };
    const count = (value) => (Array.isArray(value) ? value.length : 'unchanged');
    const groups = patch.decisions ? Object.entries(patch.decisions).map(([k, v]) => `${k} ${count(v)}`).join(', ') : 'unchanged';
    console.log(`revise Goal ${summarizeGoal(goal)}`);
    console.log(`  patch: decisions [${groups}] | criteria ${count(patch.acceptanceCriteria)} | work items ${count(patch.workItems)} | evidence ${count(patch.evidence)}`);
    console.log('  note: an active Goal schedules an owner continuation after a revise (busy while the owner is running).');
    requireConfirm(flags, 'Revising the Goal (delegated only for work items, provisional decisions and open questions)');
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/goal`, body);
    console.log(`done: goal ${summarizeGoal(result.goal)}${result.changeNotice ? ` | notice ${result.changeNotice.type}` : ''}`
      + `${result.autoContinuation ? ` | continuation ${result.autoContinuation.scheduled ? 'scheduled' : `not scheduled (${result.autoContinuation.reason})`}` : ''}`);
  },

  async 'bind-workspace'({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const preview = (await api('GET', `/api/conversations/${encodeURIComponent(roomId)}/workspace/preview`)).preview || {};
    console.log(`workspace preview: ${preview.kind} | branch ${preview.branch} | base ${preview.baseBranch}@${String(preview.baseSha || '').slice(0, 7)}`
      + ` | worktree ${preview.worktreePath}${preview.alreadyBound ? ' | already bound' : ''}`);
    if (preview.alreadyBound) return;
    requireConfirm(flags, 'Binding the room workspace (creates a room branch and worktree)');
    const result = await api('POST', `/api/conversations/${encodeURIComponent(roomId)}/workspace`, { confirm: true });
    const conversation = result.conversation || result;
    console.log(`bound: ${conversation.branch || preview.branch} at ${conversation.worktreePath || preview.worktreePath}`);
  },

  async 'create-room'({ flags }) {
    const title = typeof flags.title === 'string' ? flags.title.trim() : '';
    if (!title) throw new Error('--title is required');
    const names = String(flags.participants || '').split(',').map((name) => name.trim()).filter(Boolean);
    if (!names.length) throw new Error('--participants is required, e.g. gpt,kimi');
    const project = await resolveProject(flags);
    const body = {
      title,
      projectScopeId: project.id,
      modeId: typeof flags.mode === 'string' ? flags.mode : 'standard',
      participants: names.map((name) => ({ agentId: name.startsWith('role-') ? name : `role-family-${name}` })),
    };
    // Reuse --key on a retry: a P1 server replays the original creation instead of a second room.
    const key = typeof flags.key === 'string' ? flags.key : `claude-code-room-${crypto.randomUUID()}`;
    const projectLabel = project.name ? ` (${project.name}${project.path ? `, ${project.path}` : ''})` : '';
    console.log(`create room "${title}" | agents ${body.participants.map((p) => p.agentId).join(', ')} | project ${body.projectScopeId}${projectLabel} | mode ${body.modeId} | key ${key}`);
    requireConfirm(flags, 'Creating a room');
    const result = await api('POST', '/api/conversations', body, { 'idempotency-key': key });
    const conversation = result.conversation || {};
    const id = result.conversationId || conversation.id;
    let titleSource = result.titleSource || (conversation.metadata || {}).titleSource;
    if (id && titleSource !== 'manual') {
      // Pre-P1 servers do not lock a creation title; lock it before the first message.
      await api('PUT', `/api/conversations/${encodeURIComponent(id)}`, { title });
      titleSource = 'manual (locked by PUT)';
    }
    console.log(`created: ${id} | title "${result.title || conversation.title || title}" | titleSource ${titleSource}`);
  },

  async state({ positional, flags }) {
    const roomId = await resolveRoom(positional[0]);
    const result = await api('GET', `/api/planner/conversations/${encodeURIComponent(roomId)}/state`);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const goal = result.goal;
    console.log(`room ${result.conversationId} | busy ${result.busy}`);
    console.log(goal
      ? `goal ${goal.goalId} rev ${goal.revision} ${goal.status} | owner ${goal.owner ? goal.owner.agentName : '-'} | planner-bound ${goal.plannerBinding ? 'yes' : 'no'}`
        + ` | criteria ${JSON.stringify(goal.acceptanceCounts)} | work ${JSON.stringify(goal.workItemCounts)} | evidence ${goal.evidenceCount}`
      : 'goal: none');
    const proposal = result.proposal;
    console.log(proposal
      ? `proposal ${proposal.id} ${proposal.action} by ${(proposal.proposedBy || {}).agentName || '?'} at ${fmt(proposal.createdAt)} | ${oneLine(proposal.reason || '', 200)}`
      : 'proposal: none');
    const ruling = result.ruling;
    if (ruling) console.log(`last ruling ${ruling.action} ${ruling.outcome} by ${(ruling.ruledBy || {}).plannerName || (ruling.ruledBy || {}).agentName || (ruling.ruledBy || {}).kind} at ${fmt(ruling.ruledAt)}`);
    if (result.runner) console.log(`runner ${result.runner.status} ${result.runner.iteration}/${result.runner.maxIterations}`);
    if (result.lastTurn) console.log(`last turn ${result.lastTurn.status} ${fmt(result.lastTurn.finishedAt)}`);
    return result;
  },

  async attention({ flags }) {
    const page = await api('GET', `/api/planner/attention?${await attentionQuery(flags)}`);
    if (flags.json) console.log(JSON.stringify(page, null, 2));
    else printAttention(page);
    return page;
  },

  async 'wait-attention'({ flags }) {
    const timeout = Math.min(300, Math.max(1, Number(flags.timeout || 300)));
    const deadline = Date.now() + Number(flags['max-minutes'] || 240) * 60000;
    let after = Number(flags.after || 0);
    // Resolve a room keyword once: a keyword that matches no room cannot succeed later.
    const query = typeof flags.room === 'string' ? { ...flags, room: await resolveRoom(flags.room) } : flags;
    while (Date.now() < deadline) {
      let page;
      try {
        page = await api('GET', `/api/planner/attention/wait?${await attentionQuery({ ...query, after }, { timeoutSeconds: timeout })}`);
      } catch (error) {
        // A restart drops the connection or rotates the credential: re-read it and retry.
        // Any other rejection (an invalid --status or --after) is reported instead.
        if (!isTransientError(error)) throw error;
        cachedPlannerCredential = undefined;
        console.error(`wait error: ${String(error.message).split('\n')[0]}; retrying in 15s`);
        await new Promise((resolve) => setTimeout(resolve, 15000));
        continue;
      }
      if (page.items.length) {
        printAttention(page);
        return page;
      }
      after = page.nextCursor;
    }
    console.log(`timeout: no attention item after cursor ${after}`);
    process.exitCode = 2;
    return null;
  },

  async ack({ positional, flags }) {
    const sequence = Number(positional[0]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('ack needs an attention sequence number');
    if (typeof flags.reason !== 'string' || !flags.reason.trim()) throw new Error('--reason is required');
    requireConfirm(flags, `Acknowledging attention #${sequence}`);
    const result = await api('POST', `/api/planner/attention/${sequence}/resolve`, { reason: flags.reason });
    printAttention({ items: [result.item], nextCursor: '-', highWatermark: '-', hasMore: false });
  },
};

// No HTTP status means the request got no answer (connection refused or dropped).
// 401 follows a restart that rotated the credential; 408, 429 and 5xx can pass.
// Any other status is an answer that a retry will not change.
function isTransientError(error) {
  const status = error && error.status;
  return !Number.isInteger(status) || status >= 500 || [401, 408, 429].includes(status);
}

// The UI's active project can be any project, so the default is the instance's
// project for this checkout; anything else must be named.
async function resolveProject(flags) {
  const explicit = typeof flags.project === 'string' ? flags.project : CAFF_PROJECT_ID;
  const { projects = [] } = await api('GET', '/api/projects');
  const list = projects.map((project) => `  ${project.id}  ${project.name}  ${project.path || ''}`).join('\n');
  if (explicit) {
    const named = projects.find((project) => project.id === explicit);
    if (named) return named;
    throw new Error(`project ${explicit} does not exist on ${BASE}; pass --project <id>:\n${list}`);
  }
  const key = (value) => {
    const resolved = path.resolve(String(value));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const own = CAFF_HOME && projects.find((project) => project.path && key(project.path) === key(CAFF_HOME));
  if (own) return own;
  throw new Error(`no project has the path ${CAFF_HOME || '(unknown checkout)'}; pass --project <id>:\n${list}`);
}

async function attentionQuery(flags, extra = {}) {
  const params = new URLSearchParams();
  if (flags.after !== undefined) params.set('after', String(flags.after));
  if (flags.limit !== undefined) params.set('limit', String(flags.limit));
  if (typeof flags.status === 'string') params.set('status', flags.status);
  if (typeof flags.room === 'string') params.set('conversationId', await resolveRoom(flags.room));
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
  return params;
}

function printAttention(page) {
  for (const item of page.items) {
    const agents = item.failedAgentIds ? ` | agents ${item.failedAgentIds.join(',')} lane ${item.lane || '-'}` : '';
    const state = item.resolvedAt ? `resolved ${item.resolution} ${fmt(item.resolvedAt)}` : 'UNRESOLVED';
    console.log(`#${item.sequence} ${fmt(item.createdAt)} ${item.kind} room ${String(item.conversationId).slice(0, 8)} goal rev ${item.goalRevision}${agents} | ${item.summary} | ${state}`);
  }
  console.log(`items ${page.items.length} | nextCursor ${page.nextCursor} | highWatermark ${page.highWatermark} | hasMore ${page.hasMore}${page.timedOut ? ' | timed out' : ''}`);
}

function analyzeSession(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // The newest file may still be streaming; skip a partial trailing line.
    }
  }
  if (entries.length < 2) return null;
  const ts = (entry) => new Date(entry.timestamp).getTime();
  const start = ts(entries[0]);
  const agentMatch = path.basename(file).match(/-(role-[a-z0-9-]+?)-(?:default|[a-z0-9]+)-[0-9a-f]+\.jsonl$/i);
  const round = {
    start,
    agent: agentMatch ? agentMatch[1] : '?',
    wall: ts(entries[entries.length - 1]) - start,
    model: 0,
    tool: 0,
    calls: 0,
    reads: 0,
    edits: 0,
    maxCtx: 0,
    firstEdit: null,
    longRuns: [],
    goalUpdates: {},
  };
  const pending = {};
  let previous = start;
  for (const entry of entries) {
    const now = ts(entry);
    const message = entry.type === 'message' ? entry.message : null;
    if (message && message.role === 'assistant') {
      round.calls += 1;
      const requestStart = typeof message.timestamp === 'number' ? message.timestamp : previous;
      round.model += Math.max(0, now - requestStart);
      const usage = message.usage || {};
      round.maxCtx = Math.max(round.maxCtx, (usage.input || 0) + (usage.cacheRead || 0));
      for (const block of message.content || []) {
        if (block.type !== 'toolCall') continue;
        pending[block.id] = block;
        const args = block.arguments || {};
        if (block.name === 'read') round.reads += 1;
        if ((block.name === 'edit' || block.name === 'write') && !PRIVATE_PATH_RE.test(String(args.path || ''))) {
          round.edits += 1;
          if (round.firstEdit === null) round.firstEdit = now - start;
        }
      }
    }
    if (message && message.role === 'toolResult') {
      const elapsed = Math.max(0, now - previous);
      round.tool += elapsed;
      const call = pending[message.toolCallId];
      const command = call && call.name === 'bash' ? String((call.arguments || {}).command || '') : '';
      if (command && elapsed >= 120000) round.longRuns.push({ ms: elapsed, command: oneLine(command, 90) });
      if (GOAL_UPDATE_CALL_RE.test(command)) {
        const output = (message.content || []).map((part) => part.text || '').join('');
        const succeeded = /"ok":\s*true|ok True|'ok': True|receipt True/.test(output);
        const outcome = /cannot change the objective|goal_structural_review_required|\b409\b/.test(output) ? 'rejected-409'
          : /Traceback|SyntaxError|Error:/.test(output) && !succeeded ? 'script-error'
            : succeeded || /"revision"/.test(output) ? 'ok' : 'unknown';
        round.goalUpdates[outcome] = (round.goalUpdates[outcome] || 0) + 1;
      }
    }
    previous = now;
  }
  return round;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || !commands[command]) {
    console.log(HELP);
    if (command && !commands[command] && command !== 'help' && command !== '--help') process.exitCode = 2;
    return;
  }
  await commands[command](parseArgs(rest));
}

main().catch((error) => {
  if (error && error.message === '__stop__') return;
  console.error(`error: ${error && error.message ? error.message : error}`);
  if (!process.exitCode) process.exitCode = 1;
});
