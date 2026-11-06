import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildWikiTraceBundle, traceSourceIdentity } from './wiki-trace';
const fail = (code: string) => Object.assign(Error(code), { code });
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
export function createTraceModelTimingRecorder(now = () => performance.now()) {
  const calls: any[] = [];
  let started: number | null = null;
  return {
    observe(event: any) {
      if (event?.message?.role !== 'assistant') return;
      if (event.type === 'message_start') started = now();
      if (event.type === 'message_end') {
        calls.push({ sequence: calls.length + 1, responseId: event.message.responseId || '',
          durationMs: started === null ? null : Math.max(0, now() - started) });
        started = null;
      }
    },
    snapshot: () => calls.map(c => ({ ...c })),
  };
}
// Instance-owned sources only. Never searches other sandboxes, executes !key
// commands, refreshes OAuth, or serializes the inventory. Tests use empty dirs.
export function readTraceKnownKeyValues(options: any) {
  try {
    if (!path.isAbsolute(options.agentDir || '')) throw Error();
    const root = path.resolve(options.agentDir), values = new Set<string>(), env = options.env || process.env;
    const add = (v: any) => { if (typeof v === 'string' && v) values.add(v); };
    const load = (name: string): any => {
      const file = path.join(root, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch (e: any) { if (e.code === 'ENOENT') return {}; throw e; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || fs.realpathSync(file) !== file) throw Error();
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const models = load('models.json'), auth = load('auth.json');
    const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!object(models) || !object(auth) || (models.providers !== undefined && !object(models.providers))) throw Error();
    for (const provider of Object.values(models.providers || {}) as any[]) {
      if (!object(provider)) throw Error();
      if (provider?.apiKey === undefined || provider.apiKey === '') continue;
      if (typeof provider.apiKey !== 'string' || provider.apiKey.startsWith('!')) throw Error();
      if (provider.apiKey.startsWith('$')) {
        if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKey) || !env[provider.apiKey.slice(1)]) throw Error();
        add(env[provider.apiKey.slice(1)]);
      } else add(provider.apiKey);
    }
    const walk = (entry: any) => {
      if (!entry || typeof entry !== 'object') return;
      for (const [key, value] of Object.entries(entry)) {
        if (/^(?:key|token|api_?key|access|refresh|access_?token|refresh_?token)$/i.test(key)) add(value);
        if (value && typeof value === 'object') walk(value);
      }
    };
    walk(auth);
    for (const [name, value] of Object.entries(env)) if (/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) add(value);
    add(options.chatStore?.getSystemServiceCredential?.('turn-time-breakdown-jev')?.apiKey);
    return Object.defineProperty({}, 'values', { value: Object.freeze([...values]) });
  } catch { throw fail('wiki_trace_known_keys_unavailable'); }
}
// Does not follow a path from another instance or open a tool-result filename.
// Only the selected session is opened, through one read-only descriptor.
export function readTraceSession(agentDir: string, sessionPath: string) {
  const root = path.resolve(agentDir, 'named-sessions'), target = path.resolve(sessionPath || '.');
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)
    || !target.endsWith('.jsonl')) throw fail('session_outside_instance');
  try {
    if (fs.realpathSync(target) !== target || fs.realpathSync(root) !== root) throw fail('session_outside_instance');
    const fd = fs.openSync(target, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) throw fail('session_too_large');
      const bytes = fs.readFileSync(fd);
      if (bytes.length > MAX_SESSION_BYTES) throw fail('session_too_large');
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw fail('session_invalid');
      return text;
    } finally { fs.closeSync(fd); }
  } catch (e: any) {
    if (e.code === 'ENOENT') throw fail('session_missing');
    throw fail(['session_outside_instance', 'session_too_large', 'session_invalid'].includes(e.code) ? e.code : 'session_unreadable');
  }
}
// v2 stores ordinary tracked changes in a CAS patch, not cp.files. Ask Git to
// LIST that frozen patch's paths only: no apply, source checkout, index or refs.
// Git handles quoted/Unicode/binary names; no hand-written diff header parser.
export function readTraceSceneChanges(captureStore: any, checkpoint: any): string[] | null {
  if (checkpoint?.schemaVersion !== 2 || checkpoint.gitSnapshot?.kind !== 'git-snapshot-v1') return null;
  try {
    const digest = checkpoint.gitSnapshot.patchBlobHash;
    if (!/^[a-f0-9]{64}$/.test(digest || '')) return null;
    const bytes = captureStore.readBlob(checkpoint.projectId, digest);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SESSION_BYTES
      || crypto.createHash('sha256').update(bytes).digest('hex') !== digest) return null;
    if (!bytes.length) return [];
    const names = execFileSync('git', ['-c', 'core.fsmonitor=false', 'apply', '--numstat', '-z', '--'], {
      input: bytes, encoding: 'buffer', windowsHide: true, timeout: 10000, maxBuffer: MAX_SESSION_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = names.toString('utf8');
    if (!Buffer.from(text).equals(names) || !text.endsWith('\0')) return null;
    return text.slice(0, -1).split('\0').map(line => {
      const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(line);
      if (!match) throw Error();
      return match[1];
    });
  } catch { return null; } // Missing/corrupt patch is a disclosed gap, never live Git fallback.
}
function excerpt(value: string) {
  if (typeof value !== 'string') throw fail('wiki_source_invalid');
  const bytes = Buffer.from(value);
  if (bytes.length <= 32768) return { message: value, messageTruncated: false };
  let end = 32768;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return { message: bytes.subarray(0, end).toString('utf8'), messageTruncated: true };
}
export function freezeMarkedCaseTrace(options: any, input: any, flag: any, firstMark = false) {
  const chat = options.chatStore, message = chat.getMessage(input.messageId);
  if (!message || message.conversationId !== input.conversationId || message.role !== 'assistant') throw fail('wiki_source_invalid');
  const conversation = chat.getConversationWithoutMessages(input.conversationId);
  if (!conversation || (conversation.projectScopeId || conversation.projectId) !== input.projectId) throw fail('wiki_source_invalid');
  const source = traceSourceIdentity({ ...input, agentId: message.agentId });
  const item = options.wikiStore.addMarkedCase({ source: { ...source, conversationTitle: conversation.title || '未命名房间' },
    role: message.agentId, actual: input.actual, expected: input.expected, createdAt: flag.createdAt,
    sealedCheckpointId: null, ...excerpt(message.content), traceExcerpt: '', traceState: 'missing', traceTruncated: false }).case;
  // Retry must not even open mutable source files or current credentials.
  if (item.traceBundle) {
    options.wikiStore.readCaseTrace(item.id);
    return { created: false, caseId: item.id, traceBundle: item.traceBundle };
  }
  if (!firstMark) return { ...options.wikiStore.recoverCaseTrace(item.id), caseId: item.id };
  const missing: string[] = [], metadata = { ...message.metadata };
  if (message.taskId && chat.db && (metadata.sessionAssistantStartIndex == null || !metadata.sessionPath)) {
    const task = chat.db.prepare('SELECT session_path, metadata_json FROM a2a_tasks WHERE id = ?').get(message.taskId);
    if (task) {
      let taskMeta: any = {};
      try { taskMeta = JSON.parse(task.metadata_json || '{}'); } catch { missing.push('task_metadata_invalid'); }
      if (metadata.sessionAssistantStartIndex == null) metadata.sessionAssistantStartIndex = taskMeta.sessionAssistantStartIndex;
      if (!metadata.sessionPath) metadata.sessionPath = task.session_path;
    }
  }
  const modelUsage = chat.getMessageModelUsage?.(message.id);
  if (metadata.sessionAssistantEndIndex == null && Number.isSafeInteger(metadata.sessionAssistantStartIndex)
    && Number.isSafeInteger(modelUsage?.modelCallCount) && modelUsage.modelCallCount > 0) {
    metadata.sessionAssistantEndIndex = metadata.sessionAssistantStartIndex + modelUsage.modelCallCount;
    missing.push('turn_end_inferred_from_usage');
  }
  let sessionText: string | null = null, checkpoint: any = null;
  try { sessionText = readTraceSession(options.agentDir, metadata.sessionPath); }
  catch (e: any) { missing.push(e.code); }
  if (message.metadata?.badcaseCheckpointId) {
    try { checkpoint = options.captureStore.loadCheckpoint(input.projectId, message.metadata.badcaseCheckpointId); }
    catch { missing.push('checkpoint_unreadable'); }
    if (!checkpoint) missing.push('checkpoint_missing');
    else if (['projectId', 'conversationId', 'turnId', 'agentId'].some(k => checkpoint[k] !== (k === 'projectId' ? input.projectId : message[k]))) throw fail('wiki_trace_association_mismatch');
  }
  const knownKeyValues = options.knownKeyValues().values;
  const bundle = buildWikiTraceBundle({ source, frozenAt: flag.createdAt, origin: 'mark', message: { ...message, metadata },
    actual: input.actual, expected: input.expected, sessionText, checkpoint, sceneChanges: readTraceSceneChanges(options.captureStore, checkpoint), modelUsage,
    snapshot: chat.getMessageContextSnapshot?.(message.id), timeline: chat.getMessageObservabilityTimeline?.(message.id), knownKeyValues, missingReasons: missing });
  return { ...options.wikiStore.freezeCaseTrace(item.id, bundle), caseId: item.id };
}
