import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { resolvePlannerCredentialPath } from '../server/domain/security/planner-credential';

const PAYLOAD_BYTES = 16 * 1024;
const RESPONSE_BYTES = 8 * 1024 * 1024; // Complete Goal, never a truncated success.
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class PlannerCliError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly serverCode?: string, readonly escape?: string) { super(code); }
}
function invalid(code = 'caff_input_invalid'): never { throw new PlannerCliError(code); }
function text(v: unknown, max = 1000, codePoints = false): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || (codePoints ? [...v].length : v.length) > max || Buffer.from(v, 'utf8').toString('utf8') !== v || /[\p{Cc}\u2028\u2029]/u.test(v)) invalid();
}
function id(v: unknown, max = 200): asserts v is string { if (typeof v !== 'string' || !ID.test(v) || v.length > max) invalid(); }
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid();
}
function object(v: any, keys: string[]): asserts v is Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) invalid();
}
function list(v: any, validate: (v: any) => void, max = 100) {
  if (!Array.isArray(v) || v.length > max) invalid();
  const seen = new Set();
  for (const item of v) { validate(item); if (item?.id) { if (seen.has(item.id)) invalid(); seen.add(item.id); } }
}
function stringList(v: any) { list(v, item => id(item, 80), 40); }

function stringEscape(n: number): string | undefined {
  return n < 32 || n > 126 || /["\\'$`;&|<>()]/.test(String.fromCharCode(n))
    ? '\\u' + n.toString(16).padStart(4, '0') : undefined;
}
// Scan only already-valid JSON strings for a minimal correction hint. Never
// return keys, surrounding text, offsets, the payload, or a parser exception.
function firstRequiredEscape(raw: string): string | undefined {
  let quoted = false;
  const short: Record<string, number> = { '"': 34, '\\': 92, '/': 47, b: 8, f: 12, n: 10, r: 13, t: 9 };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!quoted) { if (c === '"') quoted = true; continue; }
    if (c === '"') { quoted = false; continue; }
    if (c === '\\') {
      const unicode = raw[i + 1] === 'u', length = unicode ? 6 : 2;
      const n = unicode ? parseInt(raw.slice(i + 2, i + 6), 16) : short[raw[i + 1]];
      const expected = stringEscape(n);
      if (expected && raw.slice(i, i + length) !== expected) return expected;
      i += length - 1;
    } else {
      const expected = stringEscape(raw.charCodeAt(i));
      if (expected) return expected;
    }
  }
  return undefined;
}

// Parse JSON exactly once, then compare a canonical serialization. Duplicate
// keys, alternate escapes/whitespace and raw shell delimiters cannot survive
// this comparison. Data is never evaluated or decoded a second time as code.
export function encodePlannerJson(value: any, depth = 0): string {
  if (depth > 24) invalid('caff_payload_invalid');
  if (typeof value === 'string') {
    if (Buffer.from(value, 'utf8').toString('utf8') !== value || value.includes('\0')) invalid('caff_payload_invalid');
    let result = '"';
    for (let i = 0; i < value.length; i++) {
      const c = value[i], n = value.charCodeAt(i);
      // Unicode escapes also avoid MSYS-to-native argv losing a slash from
      // JSON's \" / \\ spellings. Structural JSON quotes remain literal.
      result += stringEscape(n) ?? c;
    }
    return result + '"';
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => encodePlannerJson(v, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).map(k => encodePlannerJson(k, depth + 1) + ':' + encodePlannerJson(value[k], depth + 1)).join(',') + '}';
  return invalid('caff_payload_invalid');
}
function payload(raw: string) {
  if (Buffer.byteLength(raw) > PAYLOAD_BYTES) invalid('caff_payload_too_large');
  try {
    const value = JSON.parse(raw);
    if (encodePlannerJson(value) !== raw) throw new PlannerCliError('caff_payload_noncanonical', undefined, undefined, firstRequiredEscape(raw));
    return value;
  } catch (error) { if (error instanceof PlannerCliError) throw error; invalid('caff_payload_invalid'); }
}
function flags(args: string[], allowed: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key) || typeof args[i + 1] !== 'string') invalid();
    result[key] = args[i + 1];
  }
  return result;
}
function preconditions(v: any) {
  if (v.goalId === null) { if (v.goalRevision !== 0) invalid(); }
  else { id(v.goalId); integer(v.goalRevision, 1); }
}
function workItem(v: any, structural: boolean) {
  object(v, structural ? ['id', 'text', 'status'] : ['id', 'status']); id(v.id, 80);
  if (v.text !== undefined) text(v.text, 300);
  if (v.status !== undefined && !['todo','in_progress','done'].includes(v.status)) invalid();
}
function criterion(v: any, structural: boolean) {
  object(v, structural ? ['id','status','evidenceRefs','waiver'] : ['id','status','evidenceRefs']); id(v.id, 80);
  if (v.status !== undefined && !['pending','passed','failed', ...(structural ? ['waived'] : [])].includes(v.status)) invalid();
  if (v.evidenceRefs !== undefined) stringList(v.evidenceRefs);
  if (v.waiver !== undefined) { object(v.waiver, ['reason']); text(v.waiver.reason); }
}
function evidence(v: any) {
  object(v, ['id','criterionIds','kind','summary','reference']); id(v.id, 80);
  if (v.criterionIds !== undefined) stringList(v.criterionIds);
  if (v.kind !== undefined && !['test','command','artifact','review','manual'].includes(v.kind)) invalid();
  if (v.summary !== undefined) text(v.summary, 1000);
  if (v.reference !== undefined) text(v.reference, 1000);
}
function goalAction(v: any) {
  const common = ['action','goalId','goalRevision','reason','proposalId','supersedeProposal'];
  const actions = ['pause','resume','complete','set-owner','accept-proposal','dismiss-proposal','update-delivery','revise'];
  if (!v || !actions.includes(v.action)) invalid();
  const patch = ['workItems','acceptanceCriteria','evidence'];
  object(v, [...common, ...(v.action === 'set-owner' ? ['ownerAgentId'] : []), ...(['revise','update-delivery'].includes(v.action) ? patch : []), ...(v.action === 'revise' ? ['decisions','impact'] : [])]);
  preconditions(v); text(v.reason);
  if (v.proposalId !== undefined) id(v.proposalId);
  if (v.supersedeProposal !== undefined && v.supersedeProposal !== true) invalid();
  if (['accept-proposal','dismiss-proposal'].includes(v.action) || v.supersedeProposal === true) id(v.proposalId);
  if (v.action === 'set-owner') id(v.ownerAgentId);
  if (v.impact !== undefined) text(v.impact);
  if (v.workItems !== undefined) list(v.workItems, x => workItem(x, v.action === 'revise'), 60);
  if (v.acceptanceCriteria !== undefined) list(v.acceptanceCriteria, x => criterion(x, v.action === 'revise'), 40);
  if (v.evidence !== undefined) list(v.evidence, evidence);
  if (v.decisions !== undefined) {
    object(v.decisions, ['provisional','openQuestions']);
    for (const key of ['provisional','openQuestions']) if (v.decisions[key] !== undefined) list(v.decisions[key], x => {
      object(x, key === 'provisional' ? ['id','statement','changeConditions'] : ['id','question']); id(x.id, 80);
      if (x.statement !== undefined) text(x.statement, 500);
      if (x.question !== undefined) text(x.question, 500);
      if (x.changeConditions !== undefined) text(x.changeConditions, 1000);
    }, 40);
  }
}
function receipt(v: any) {
  if (!Array.isArray(v) || !v.length || v.length > 100) invalid();
  const seen = new Set();
  for (const item of v) {
    object(item, ['sequence','disposition','reason']); integer(item.sequence, 1); text(item.reason, 500, true);
    if (!['handled','needs_user','no_action'].includes(item.disposition) || seen.has(item.sequence)) invalid();
    seen.add(item.sequence);
  }
}

type Command = { kind: string; method: string; route: string; body?: any };
export function parsePlannerCommand(argv: string[], room: string): Command {
  const [a, b] = argv;
  if (a === 'state' && argv.length === 1) return { kind: 'state', method: 'GET', route: `/api/planner/conversations/${room}/state` };
  if (a === 'goal' && b === 'read' && argv.length === 2) return { kind: 'goal', method: 'GET', route: `/api/conversations/${room}/goal` };
  if (a === 'attention' && b === 'read') {
    const f = flags(argv.slice(2), ['--after','--limit']);
    for (const key of Object.keys(f)) if (!/^(0|[1-9][0-9]*)$/.test(f[key])) invalid();
    const after = Number(f['--after'] ?? 0), limit = Number(f['--limit'] ?? 100); integer(after, 0); integer(limit, 1, 500);
    return { kind: 'attention', method: 'GET', route: `/api/planner/attention?conversationId=${room}&after=${after}&limit=${limit}&status=unresolved` };
  }
  if ((a === 'goal' && b === 'action') || (a === 'owner' && b === 'message')) {
    const f = flags(argv.slice(2), ['--json']); if (!f['--json']) invalid();
    const body = payload(f['--json']);
    if (a === 'goal') goalAction(body);
    else {
      object(body, ['goalId','goalRevision','ownerAgentId','content','clientRequestId']); preconditions(body); id(body.ownerAgentId); id(body.clientRequestId);
      text(body.content, 4000); if (body.content.includes('@') || body.goalId === null) invalid();
    }
    return { kind: a === 'goal' ? 'action' : 'message', method: 'POST', route: `/api/conversations/${room}/${a === 'goal' ? 'goal' : 'messages'}`, body };
  }
  if (a === 'wakeup' && b === 'finish') {
    const f = flags(argv.slice(2), ['--attempt','--json']);
    if (!UUID.test(f['--attempt'] || '') || !f['--json']) invalid();
    const items = payload(f['--json']); receipt(items);
    return { kind: 'finish', method: 'POST', route: `/api/conversations/${room}/planner/wakeups/${f['--attempt']}/finish`, body: { items } };
  }
  return invalid();
}
function binding(env: NodeJS.ProcessEnv) {
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(env.CAFF_BASE_URL || '');
  if (!match || Number(match[2]) > 65535 || !ID.test(env.CAFF_ROOM_ID || '')) invalid('caff_binding_invalid');
  return { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]), room: env.CAFF_ROOM_ID! };
}
function readCredential(env: NodeJS.ProcessEnv, host: string, port: number) {
  try {
    const target = resolvePlannerCredentialPath({ env, host, port });
    const before = fs.lstatSync(target);
    if (!path.isAbsolute(target) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error();
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd); if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile()) throw new Error();
      const buffer = Buffer.alloc(4097), size = fs.readSync(fd, buffer, 0, buffer.length, 0); if (size > 4096) throw new Error();
      const v = JSON.parse(buffer.toString('utf8', 0, size));
      object(v, ['version','plannerId','plannerName','token','issuedAt']);
      if (v.version !== 1 || v.plannerId !== 'local-planner' || typeof v.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.token)) throw new Error();
      text(v.plannerName, 160); if (typeof v.issuedAt !== 'string' || !Number.isFinite(Date.parse(v.issuedAt))) throw new Error();
      return v.token as string;
    } finally { fs.closeSync(fd); }
  } catch { throw new PlannerCliError('caff_credential_unavailable'); }
}
function boundedBody(body: any) {
  const result = body === undefined ? undefined : JSON.stringify(body);
  if (result !== undefined && Buffer.byteLength(result) > PAYLOAD_BYTES) invalid('caff_payload_too_large');
  return result;
}
async function request(target: ReturnType<typeof binding>, token: string, command: Command): Promise<any> {
  const body = boundedBody(command.body);
  return new Promise((resolve, reject) => {
    // node:http, agent:false: no fetch/global proxy agent, redirects or retries.
    // Pin localhost's network address; never resolve arbitrary DNS aliases.
    const req = http.request({ hostname: target.host === 'localhost' ? '127.0.0.1' : target.host, port: target.port, path: command.route, method: command.method, agent: false,
      headers: { Host: `${target.host === '::1' ? '[::1]' : target.host}:${target.port}`, Authorization: 'Bearer ' + token, 'X-CAFF-Principal': 'planner', 'Content-Type': 'application/json', ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > RESPONSE_BYTES) { res.destroy(); reject(new PlannerCliError('caff_response_invalid')); } else chunks.push(chunk); });
      res.on('error', () => reject(new PlannerCliError('caff_transport_failed')));
      res.on('end', () => {
        let result: any;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new PlannerCliError('caff_response_invalid')); return; }
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          const code = typeof result?.code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.code) && !result.code.includes(token) ? result.code : undefined;
          reject(new PlannerCliError('caff_http_error', status, code)); return;
        }
        // Never expose a credential even if a misbehaving endpoint echoes it.
        resolve(JSON.parse(JSON.stringify(result).split(token).join('[redacted]')));
      });
    });
    const timer = setTimeout(() => req.destroy(), 10000); timer.unref();
    req.once('close', () => clearTimeout(timer)); req.once('error', () => reject(new PlannerCliError('caff_transport_failed')));
    req.end(body);
  });
}
export async function runPlannerCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<any> {
  const target = binding(env);
  // Conservative reconstruction including quoting and the fixed node/script
  // prefix. The shell-policy gate, not this parser, owns command-text matching.
  if ([process.execPath, process.argv[1] || '', ...argv].map(v => v.replace(/["\\]/g, '\\$&').length + 3).reduce((a,b) => a+b, 0) > 24576) invalid('caff_payload_too_large');
  const command = parsePlannerCommand(argv, target.room);
  boundedBody(command.body); // Includes finish wrapper before file access/HTTP.
  const token = readCredential(env, target.host, target.port);
  if (command.kind === 'message') {
    const current = await request(target, token, { kind: 'goal', method: 'GET', route: `/api/conversations/${target.room}/goal` });
    const expected = command.body;
    if (current.conversationId !== target.room || current.goal?.goalId !== expected.goalId || current.goal?.revision !== expected.goalRevision || current.goal?.owner?.agentId !== expected.ownerAgentId) throw new PlannerCliError('caff_owner_conflict');
    command.body = { content: expected.content + '\n\n@' + expected.ownerAgentId, clientRequestId: expected.clientRequestId };
  }
  return request(target, token, command);
}
