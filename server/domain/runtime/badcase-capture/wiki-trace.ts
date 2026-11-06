// Frozen evidence owned by Wiki, not a live Inspector projection or a claim
// that the original filesystem can be replayed. No model/tool execution here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const fail = (code: string) => Object.assign(Error(code), { code });
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 128 * 1024 * 1024;
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const identityKeys = ['projectId', 'conversationId', 'messageId', 'agentId'];
export function traceSourceIdentity(source: any) {
  if (!object(source) || identityKeys.some(k => k === 'projectId' && source[k] === null ? false
    : typeof source[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source[k]))) throw fail('wiki_trace_invalid');
  return Object.fromEntries(identityKeys.map(k => [k, source[k]]));
}
export function sameTraceSource(a: any, b: any) {
  return JSON.stringify(traceSourceIdentity(a)) === JSON.stringify(traceSourceIdentity(b));
}
// Literal known-value replacement ONLY. In particular, no sentinel/entropy or
// Inspector regex is applied. Walk decoded strings so quotes/newlines in a key
// cannot survive JSON escaping. Inputs and key inventory are never mutated.
export function redactTraceKnownValues(value: any, knownValues: readonly string[] = []) {
  const needles = [...new Set(knownValues)].filter(v => typeof v === 'string' && v.length > 0).sort((a, b) => b.length - a.length);
  let count = 0;
  const replace = (s: string) => {
    // Match against original text, not earlier placeholders (overlapping keys).
    if (!needles.length) return s;
    let result = '', offset = 0;
    while (offset < s.length) {
      let next = s.length, chosen = '';
      for (const needle of needles) {
        const at = s.indexOf(needle, offset);
        if (at >= 0 && at < next) { next = at; chosen = needle; }
      }
      result += s.slice(offset, next);
      if (!chosen) break;
      result += '[*]'; count++; offset = next + chosen.length;
    }
    return result;
  };
  const walk = (v: any, depth: number): any => {
    if (depth > 128) throw fail('wiki_trace_invalid');
    if (typeof v === 'string') return replace(v);
    if (Array.isArray(v)) return v.map(entry => walk(entry, depth + 1));
    if (object(v)) {
      const result: Record<string, any> = {};
      for (const [key, entry] of Object.entries(v)) {
        const safeKey = replace(key);
        if (Object.hasOwn(result, safeKey)) throw fail('wiki_trace_redaction_collision');
        Object.defineProperty(result, safeKey, { value: walk(entry, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    return v;
  };
  return { value: walk(value, 0), count };
}
function parseTurn(text: any, metadata: any) {
  if (typeof text !== 'string' || !text.trim()) throw fail('session_missing');
  if (Buffer.byteLength(text) > MAX_BYTES) throw fail('session_too_large');
  const start = metadata?.sessionAssistantStartIndex, end = metadata?.sessionAssistantEndIndex;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end <= start) throw fail('turn_bounds_missing');
  let entries: any[];
  try { entries = text.split(/\r?\n/).filter(s => s.trim()).map(s => JSON.parse(s)); }
  catch { throw fail('session_invalid'); }
  if (entries[0]?.type !== 'session' || entries[0]?.version !== 3) throw fail('session_invalid');
  const byId = new Map<string, any>(), assistants: any[] = [];
  for (const entry of entries.slice(1)) {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || byId.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !byId.has(entry.parentId)))) throw fail('session_invalid');
    byId.set(entry.id, entry);
    if (entry.type === 'message' && entry.message?.role === 'assistant') assistants.push(entry);
  }
  if (end > assistants.length) throw fail('turn_bounds_invalid');
  const first = assistants[start], last = assistants[end - 1];
  // Include tool results after the last model output, but only on its branch;
  // a later user or assistant is never part of this frozen turn.
  let leaf = last;
  for (const entry of entries.slice(entries.indexOf(last) + 1)) {
    if (entry.parentId !== leaf.id) continue;
    if (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role)) break;
    leaf = entry;
  }
  const chain: any[] = [];
  for (let entry = leaf; entry; entry = entry.parentId === null ? null : byId.get(entry.parentId)) chain.push(entry);
  chain.reverse();
  const firstIndex = chain.findIndex(e => e.id === first.id);
  if (firstIndex < 0 || chain.filter(e => e.type === 'message' && e.message?.role === 'assistant' && assistants.indexOf(e) >= start).length !== end - start) throw fail('turn_bounds_invalid');
  let triggerIndex = firstIndex - 1;
  while (triggerIndex >= 0 && !(chain[triggerIndex].type === 'message' && chain[triggerIndex].message?.role === 'user')) triggerIndex--;
  if (triggerIndex < 0 || chain.slice(triggerIndex + 1).some(e => e.type === 'message' && e.message?.role === 'user')) throw fail('turn_trigger_missing');
  return { prior: chain.slice(0, triggerIndex), trigger: chain[triggerIndex], turn: chain.slice(triggerIndex + 1) };
}
function sceneInventory(checkpoint: any, patchPaths: any) {
  if (!checkpoint) return null;
  // Allowlist metadata; never copy patch/file/skill bodies or read live state.
  const pick = (v: any, keys: string[]) => Object.fromEntries(keys.filter(k => v?.[k] !== undefined).map(k => [k, v[k]]));
  const files = Array.isArray(checkpoint.files) ? checkpoint.files
    : Object.entries(checkpoint.files || {}).map(([p, f]: [string, any]) => ({ ...f, path: p }));
  const snapshot = checkpoint.schemaVersion === 2 && checkpoint.gitSnapshot?.kind === 'git-snapshot-v1' ? checkpoint.gitSnapshot : null;
  const head = snapshot?.head ?? null, branch = typeof snapshot?.branch === 'string' ? snapshot.branch : null;
  const skipped = (checkpoint.skipped || []).map((s: any) => pick(s, ['path', 'reason', 'scope']));
  const uncaptured = (checkpoint.uncaptured || []).map((s: any) => pick(s, ['path', 'reason', 'scope']));
  const changes = snapshot && Array.isArray(patchPaths) ? [...new Set<string>([...patchPaths,
    ...files.filter((f: any) => ['redacted-tracked', 'mixed-eol-tracked'].includes(f.origin)).map((f: any) => f.path), ...(checkpoint.deletions || [])])].sort() : null;
  return { checkpointId: checkpoint.checkpointId ?? null, checkpointSchemaVersion: checkpoint.schemaVersion ?? null,
    metadataSource: snapshot ? 'checkpoint_git_snapshot_v2' : 'legacy_checkpoint',
    metadataStatus: !snapshot ? 'missing' : !head || branch === null || changes === null || skipped.length || uncaptured.length ? 'partial' : 'recorded',
    head, branch, detached: branch === null ? null : branch === '', changes,
    untracked: snapshot ? files.filter((f: any) => f.origin === 'untracked').map((f: any) => f.path).sort() : null,
    excludedPatterns: snapshot?.excludedPatterns ?? null,
    files: files.map((f: any) => pick(f, ['path', 'status', 'category', 'type', 'size', 'mode', 'origin', 'deleted', 'tracked', 'untracked', 'reason'])),
    deletions: checkpoint.deletions || [], skipped, uncaptured,
    // v2 deliberately does not preserve staged-vs-unstaged status.
    gitStatus: null };
}
export function buildWikiTraceBundle(input: any) {
  const source = traceSourceIdentity(input.source), missing: string[] = [...(input.missingReasons || [])];
  const original = input.snapshot?.archiveContext;
  const archived = Array.isArray(original?.sections);
  const sections = archived ? original.sections : (input.snapshot?.sections || []).map((s: any) => ({
    sectionKey: s.sectionKey, content: s.displayContent || '', originalUnavailable: true,
    displayRedacted: s.redacted === true, truncated: s.truncated === true,
  }));
  // This is about the sections archive, NOT the trigger/reused messages which
  // are recovered independently from the session below. Never migrate old packets.
  if (!archived) missing.push('context_archive_missing');
  // An explicitly failed archive contains Inspector placeholders, not a
  // historical display prompt. Never promote those strings into replay input.
  const archiveUnavailableReason = original?.unavailableReason || null;
  const system = archiveUnavailableReason ? null : sections.find((s: any) => s.sectionKey === 'harness_prompt' && s.content);
  if (archiveUnavailableReason) missing.push('system_prompt_unavailable');
  else if (!system) missing.push('system_prompt_missing');
  else if (!archived && system.displayRedacted) missing.push('system_prompt_display_redacted');
  // We record semantic inputs, never claim to have captured provider wire bytes.
  // These bytes are not required by B2 and their absence alone is informational.
  missing.push('provider_request_bytes_missing');
  if (sections.some((s: any) => s.truncated)) missing.push('context_truncated');
  let parsed: any = null;
  try { parsed = parseTurn(input.sessionText, input.message?.metadata); }
  catch (e: any) { missing.push(e.code || 'session_invalid'); }
  const steps: any[] = [];
  for (const entry of parsed?.turn || []) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'assistant') {
      const metrics = input.modelUsage?.calls?.[steps.length];
      const timings = input.message?.metadata?.badcaseModelTimings || [];
      const timed = entry.message.responseId ? timings.find((t: any) => t.responseId === entry.message.responseId) : null;
      const indexedTiming = timings.length === parsed.turn.filter((e: any) => e.type === 'message' && e.message?.role === 'assistant').length
        ? timings[steps.length] : null;
      steps.push({ step: steps.length + 1, entryId: entry.id, output: entry.message, toolResults: [],
        durationMs: timed?.durationMs ?? indexedTiming?.durationMs ?? metrics?.durationMs ?? null, usage: entry.message.usage ?? null });
    } else if (entry.message.role === 'toolResult') {
      const step = steps.find(s => Array.isArray(s.output.content) && s.output.content.some((c: any) => c.type === 'toolCall' && c.id === entry.message.toolCallId));
      if (step) step.toolResults.push(entry); else missing.push('orphan_tool_result');
    }
  }
  if (!steps.length) missing.push('model_outputs_missing');
  if (steps.some(s => !s.usage)) missing.push('model_usage_missing');
  if (steps.some(s => s.durationMs === null)) missing.push('model_duration_missing');
  for (const step of steps) for (const call of Array.isArray(step.output.content) ? step.output.content : []) {
    if (call.type === 'toolCall' && !step.toolResults.some((r: any) => r.message.toolCallId === call.id)) missing.push('tool_result_missing');
  }
  const reply = String(input.message?.content || '');
  const sent = steps.filter(s => (Array.isArray(s.output.content) ? s.output.content : []).some((b: any) =>
    b.type === 'toolCall' && /send[-_]public/.test(JSON.stringify(b)) && reply && JSON.stringify(b.arguments).includes(JSON.stringify(reply).slice(1, -1))));
  const plain = steps.filter(s => (Array.isArray(s.output.content) ? s.output.content : []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') === reply && reply);
  const markedStep = sent.at(-1)?.step ?? plain.at(-1)?.step ?? null;
  if (!markedStep) missing.push('marked_step_unresolved');
  const skillPaths = new Set<string>();
  for (const entry of [...(parsed?.prior || []), ...(parsed?.turn || [])]) {
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === 'toolCall' && block.name === 'read' && /(?:^|[\\/])SKILL\.md$/i.test(block.arguments?.path || '')) skillPaths.add(block.arguments.path);
    }
  }
  const snapshot = input.checkpoint?.schemaVersion === 2 ? input.checkpoint.gitSnapshot : null;
  const skills = (items: any) => Array.isArray(items) ? items.map((s: any) => Object.fromEntries(['name', 'filePath', 'baseDir'].filter(k => typeof s?.[k] === 'string').map(k => [k, s[k]]))) : null;
  const loaded = skills(snapshot?.loadedSkills);
  if (snapshot && (snapshot.skillInventoryStatus !== 'loaded' || loaded === null)) missing.push('scene_loaded_skills_missing');
  for (const skill of loaded || []) if (skill.filePath) skillPaths.add(skill.filePath);
  const scene = sceneInventory(input.checkpoint, input.sceneChanges);
  if (scene && scene.metadataSource !== 'checkpoint_git_snapshot_v2') missing.push('scene_git_snapshot_missing');
  if (scene && !scene.head) missing.push('scene_head_not_recorded');
  if (scene && scene.branch === null) missing.push('scene_branch_not_recorded');
  if (scene && scene.changes === null) missing.push('scene_changes_not_recorded');
  if (scene && (scene.skipped.length || scene.uncaptured.length)) missing.push('scene_files_skipped');
  const raw = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source, frozenAt: input.frozenAt,
    origin: input.origin, complete: missing.every(reason => reason === 'provider_request_bytes_missing'), missingReasons: [...new Set(missing)],
    markedMessage: reply, actual: input.actual ?? '', expected: input.expected ?? '', markedStep,
    context: { snapshotId: input.snapshot?.snapshotId ?? null, sections,
      systemPrompt: system?.content ?? null,
      systemPromptSource: archiveUnavailableReason ? 'unavailable' : system ? archived ? 'known_value_archive' : 'historical_display' : 'missing',
      ...(archiveUnavailableReason ? { archiveUnavailableReason } : {}),
      providerRequestBytesCaptured: false,
      trigger: parsed?.trigger ?? null, priorSessionEntries: parsed?.prior || [],
      skillSections: sections.filter((s: any) => /skills/.test(s.sectionKey)), loadedSkillPaths: [...skillPaths],
      ...(snapshot ? { captureLoadedSkills: { status: snapshot.skillInventoryStatus ?? 'unavailable', loaded,
        sdk: skills(snapshot.sdkLoadedSkills), prompt: skills(snapshot.promptLoadedSkills) } } : {}),
      ...(input.retained == null ? {} : { retained: input.retained }) },
    steps, metrics: { modelUsage: input.modelUsage ?? null, timeline: input.timeline ?? null }, scene,
    redaction: { policy: 'known_values_only', count: 0 } };
  const safe = redactTraceKnownValues(raw, input.knownKeyValues || []);
  safe.value.redaction.count = safe.count + Number(original?.redactionCount || 0);
  return safe.value;
}
function validBundle(bundle: any) {
  if (!object(bundle) || bundle.schemaVersion !== 1 || bundle.kind !== 'wikiskill-trace-bundle'
    || !['mark', 'backfill'].includes(bundle.origin) || !Number.isFinite(Date.parse(bundle.frozenAt))
    || typeof bundle.complete !== 'boolean' || !Array.isArray(bundle.missingReasons)
    || !object(bundle.context) || !Array.isArray(bundle.steps) || bundle.redaction?.policy !== 'known_values_only') throw fail('wiki_trace_invalid');
  traceSourceIdentity(bundle.source);
  return bundle;
}
// This store only accepts an explicitly resolved Wiki root. Directory ancestors
// are same-OS-user trusted; it is not a path-swap/security sandbox.
export function createWikiTraceStore(globalRoot: string) {
  if (!path.isAbsolute(globalRoot || '')) throw fail('wiki_trace_invalid');
  const fileFor = (source: any) => path.join(globalRoot, 'traces', hash(JSON.stringify(traceSourceIdentity(source))) + '.json');
  function read(source: any, expectedHash?: string): any {
    let bytes: Buffer;
    try {
      const file = fileFor(source), st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) throw fail('wiki_trace_invalid');
      bytes = fs.readFileSync(file);
    } catch (e: any) { if (e.code === 'ENOENT' && !expectedHash) return null; throw fail('wiki_trace_invalid'); }
    try {
      if (bytes.length > MAX_BYTES) throw Error();
      const envelope = JSON.parse(bytes.toString('utf8')), packet = validBundle(envelope.bundle);
      const checksum = hash(JSON.stringify(packet));
      if (envelope.schemaVersion !== 1 || checksum !== envelope.hash || (expectedHash && checksum !== expectedHash)
        || !sameTraceSource(packet.source, source)) throw Error();
      return packet;
    } catch { throw fail('wiki_trace_invalid'); }
  }
  return { read, freeze(bundle: any) {
    validBundle(bundle);
    const existing = read(bundle.source);
    if (existing) return { created: false, bundle: existing };
    const serialized = JSON.stringify(bundle), bytes = JSON.stringify({ schemaVersion: 1, hash: hash(serialized), bundle }) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('wiki_trace_too_large');
    const file = fileFor(bundle.source), temp = file + '.tmp-' + crypto.randomUUID();
    let created = true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(temp, file); } catch (e: any) { if (e.code !== 'EEXIST') throw e; created = false; }
    } catch { throw fail('wiki_trace_write_failed'); }
    finally { try { fs.unlinkSync(temp); } catch {} }
    return { created, bundle: read(bundle.source) };
  } };
}
export function wikiTraceReference(bundle: any) {
  return { schemaVersion: 1, hash: hash(JSON.stringify(bundle)), frozenAt: bundle.frozenAt, origin: bundle.origin,
    complete: bundle.complete, missingReasons: bundle.missingReasons, stepCount: bundle.steps.length, markedStep: bundle.markedStep,
    ...(bundle.scene ? { scene: { metadataStatus: bundle.scene.metadataStatus, metadataSource: bundle.scene.metadataSource,
      skippedCount: bundle.scene.skipped.length, head: bundle.scene.head, branch: bundle.scene.branch } } : {}) };
}
