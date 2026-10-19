// Pure, bounded placeholder interpreter for the isolated callback bridge. NO
// source I/O, ambient env, authorization, provider credential or launch grant.
// Only invocation text and enumerated session text fields may change. Archive
// bytes stay intact; receipts bind the NORMALIZED plan, never ephemeral values.
import crypto from 'node:crypto';
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const fail = () => Object.assign(Error('replay_bridge_replacements_invalid'), { code: 'replay_bridge_replacements_invalid' });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const names = ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_CONVERSATION_ID',
  'CAFF_CHAT_TURN_ID', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH'];
// A bare }} is ordinary nested JSON/prose, not a placeholder. Every controlled
// marker starts with {{; unknown/malformed starts are rejected rather than guessed.
const unresolved = (s: string) => s.includes('{{');
function transform(input: any, values?: Record<string, string>) {
  if (!object(input) || typeof input.invocation !== 'string' || (input.sessionText !== null && typeof input.sessionText !== 'string')
    || !Array.isArray(input.controlledReplacements) || input.controlledReplacements.length > 512
    || Buffer.byteLength(input.invocation) + Buffer.byteLength(input.sessionText || '') > 64 * 1024 * 1024) throw fail();
  const declared = new Map<string, number>(), observed = new Map<string, number>();
  for (const r of input.controlledReplacements) {
    if (!object(r) || Object.keys(r).sort().join('|') !== 'count|name' || !names.includes(r.name)
      || !Number.isSafeInteger(r.count) || r.count < 1 || r.count > 100000) throw fail();
    const count = (declared.get(r.name) || 0) + r.count;
    if (count > 100000) throw fail();
    declared.set(r.name, count);
  }
  const replace = (s: string) => {
    const output = s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (marker, name) => {
      if (!names.includes(name)) throw fail();
      const count = (observed.get(name) || 0) + 1;
      if (count > 100000) throw fail();
      observed.set(name, count); return values ? values[name] : marker;
    });
    // Check malformed/unknown braces even during the plan-only pass.
    if (unresolved(s.replace(/\{\{([A-Z0-9_]+)\}\}/g, '')) || (values && unresolved(output))) throw fail();
    return output;
  };
  const invocation = replace(input.invocation);
  let sessionText: string | null = input.sessionText;
  if (sessionText !== null) {
    if (!sessionText.endsWith('\n')) throw fail();
    const lines = sessionText.split('\n');
    if (lines.length > 100001) throw fail();
    let visited = 0;
    const checkRemaining = (value: any) => {
      const stack = [value];
      while (stack.length) {
        if (++visited > 100000) throw fail();
        const v = stack.pop();
        if (typeof v === 'string') { if (unresolved(v)) throw fail(); }
        else if (Array.isArray(v)) { if (stack.length + v.length > 100000) throw fail(); for (const item of v) stack.push(item); }
        else if (object(v)) for (const [k, item] of Object.entries(v)) { if (stack.length > 100000) throw fail(); stack.push(k, item); }
      }
    };
    for (let i = 0; i < lines.length - 1; i++) {
      let entry: any; try { entry = JSON.parse(lines[i]); } catch { throw fail(); }
      if (!object(entry)) throw fail();
      const fields: string[] = [];
      const content = (v: any) => {
        if (typeof v === 'string') fields.push(v);
        else if (Array.isArray(v)) for (const b of v) if (object(b) && b.type === 'text' && typeof b.text === 'string') fields.push(b.text);
      };
      if (entry.type === 'message' && object(entry.message) && ['user', 'assistant'].includes(entry.message.role)) content(entry.message.content);
      if (entry.type === 'custom_message') content(entry.content);
      const edits: { start: number; end: number; replacement: string }[] = [];
      let checked = lines[i];
      for (const field of fields) if (unresolved(field)) {
        const token = JSON.stringify(field), start = lines[i].indexOf(token);
        // No reserialization, alternate escaping, duplicate token, identity/key
        // substitution or changing arbitrary extension/tool/model state.
        if (start < 0 || lines[i].indexOf(token, start + 1) !== -1) throw fail();
        edits.push({ start, end: start + token.length, replacement: JSON.stringify(replace(field)) });
      }
      edits.sort((a, b) => b.start - a.start);
      for (const e of edits) checked = checked.slice(0, e.start) + '"checked"' + checked.slice(e.end);
      checkRemaining(JSON.parse(checked));
      for (const e of edits) lines[i] = lines[i].slice(0, e.start) + e.replacement + lines[i].slice(e.end);
    }
    sessionText = lines.join('\n');
  }
  const inventory = [...declared].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, count]) => ({ name, count }));
  if (declared.size !== observed.size || [...declared].some(([name, count]) => observed.get(name) !== count)) throw fail();
  const receipt = { kind: 'controlled-callback-inputs-v1', replacementPlanHash: hash(JSON.stringify(inventory)),
    replacementCount: inventory.reduce((n, r) => n + r.count, 0), variableCount: inventory.length };
  return { invocation, sessionText, receipt };
}
export function planControlledBridgeInputs(input: any) { return transform(input).receipt; }
export function applyControlledBridgeInputs(input: any, values: any) {
  if (!object(values) || Object.keys(values).sort().join('|') !== [...names].sort().join('|')
    || !names.every(n => typeof values[n] === 'string')
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(values.CAFF_CHAT_API_URL)
    || Number(values.CAFF_CHAT_API_URL.split(':').at(-1)) > 65535
    || !/^[a-f0-9]{64}$/.test(values.CAFF_CHAT_CALLBACK_TOKEN)
    || !['CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CONVERSATION_ID', 'CAFF_CHAT_TURN_ID'].every(n => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(values[n]))
    || values.CAFF_CHAT_TOOLS_PATH !== '/work/build/lib/agent-chat-tools.js'
    || values.CAFF_CHAT_TOOLS_RELATIVE_PATH !== '../../build/lib/agent-chat-tools.js') throw fail();
  return transform(input, values);
}
