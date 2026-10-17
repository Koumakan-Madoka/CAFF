// Container-side mapping only. No SDK import, model egress, credentials or scorer.
// The host protocol validates every outbound request and provider response.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
function texts(content) {
  if (typeof content === 'string') return content;
  assert.ok(Array.isArray(content) && content.every(b => b.type === 'text' && typeof b.text === 'string'), 'unsupported_content');
  // Text blocks are concatenated in order, without inventing separator bytes.
  return content.map(b => b.text).join('');
}
function sdkTools(tools, profile) {
  assert.ok(Array.isArray(tools));
  const wire = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  assert.deepEqual(stable(wire), stable(profile.tools), 'reviewed_tools_changed');
  return profile.tools;
}
function sdkMessages(context) {
  assert.equal(typeof context.systemPrompt, 'string'); assert.ok(Array.isArray(context.messages));
  return [{ role: 'system', content: context.systemPrompt }, ...context.messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: texts(m.content) };
    if (m.role === 'toolResult') return { role: 'tool', tool_call_id: m.toolCallId, content: texts(m.content) };
    assert.equal(m.role, 'assistant', 'unsupported_history'); assert.ok(Array.isArray(m.content));
    const calls = m.content.filter(b => b.type === 'toolCall');
    assert.ok(calls.length <= 1 && m.content.every(b => ['text', 'toolCall'].includes(b.type)), 'unsupported_content');
    const text = texts(m.content.filter(b => b.type === 'text'));
    return calls.length ? { role: 'assistant', content: text || null, tool_calls: calls.map(c => ({ id: c.id, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : { role: 'assistant', content: text };
  })];
}
function nonThinking(s) {
  if (!Object.hasOwn(s, 'compatibilityProfile')) return false;
  assert.ok(['opencode-go-deepseek-nonthinking-v1', 'opencode-go-deepseek-nonthinking-cached-v1', 'opencode-go-deepseek-nonthinking-cached-index0-v1'].includes(s.compatibilityProfile));
  assert.equal(s.provider, 'opencode-go'); assert.equal(s.model, 'deepseek-v4.1-flash'); return true;
}
function promptCacheTokens(u, s) {
  if (!Object.hasOwn(u, 'prompt_tokens_details')) return 0;
  const d = u.prompt_tokens_details;
  assert.ok(d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).every(k => ['cached_tokens', 'audio_tokens'].includes(k)));
  const cached = Object.hasOwn(d, 'cached_tokens') ? d.cached_tokens : 0;
  assert.ok(Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 1 && Number.isSafeInteger(cached) && cached >= 0 && cached <= u.prompt_tokens);
  assert.ok(!Object.hasOwn(d, 'audio_tokens') || d.audio_tokens === 0);
  if (!['opencode-go-deepseek-nonthinking-cached-v1', 'opencode-go-deepseek-nonthinking-cached-index0-v1'].includes(s.compatibilityProfile)) assert.equal(cached, 0);
  return cached;
}
function assistantMessage(raw, profile) {
  const s = profile.settings, off = nonThinking(s); assert.equal(raw.model, s.model); assert.equal(raw.choices.length, 1);
  const c = raw.choices[0], content = [];
  // Host validation comes first; this second boundary must not silently erase
  // reasoning if invoked directly or if a future host path bypasses that guard.
  assert.ok(!Object.hasOwn(c.message, 'reasoning_content') || (off && (c.message.reasoning_content === null || c.message.reasoning_content === '')));
  assert.ok(['stop', 'tool_calls'].includes(c.finish_reason));
  if (c.message.content !== null) { assert.equal(typeof c.message.content, 'string'); content.push({ type: 'text', text: c.message.content }); }
  if (c.finish_reason === 'tool_calls') {
    assert.equal(c.message.tool_calls.length, 1);
    for (const t of c.message.tool_calls) {
      // Independent metadata guard: never silently discard an unapproved index
      // or unknown field even when the host boundary is bypassed by a caller.
      const indexed = s.compatibilityProfile === 'opencode-go-deepseek-nonthinking-cached-index0-v1';
      assert.ok(t && typeof t === 'object' && !Array.isArray(t)
        && ['id', 'type', 'function'].every(k => Object.hasOwn(t, k))
        && Object.keys(t).every(k => ['id', 'type', 'function', ...(indexed ? ['index'] : [])].includes(k)));
      if (Object.hasOwn(t, 'index')) assert.ok(t.index === 0);
      assert.equal(t.type, 'function');
      assert.ok(profile.tools.some(x => x.function.name === t.function.name));
      content.push({ type: 'toolCall', id: t.id, name: t.function.name, arguments: JSON.parse(t.function.arguments) });
    }
  }
  const u = raw.usage, cached = promptCacheTokens(u, s), uncached = u.prompt_tokens - cached;
  // SDK counters partition the prompt. Both partitions use the SAME declared
  // full input rate; there is no invented provider discount or extra cache charge.
  const input = uncached * s.inputMicroUsdPerMillionTokens / 1e12;
  const cacheRead = cached * s.inputMicroUsdPerMillionTokens / 1e12;
  const output = u.completion_tokens * s.outputMicroUsdPerMillionTokens / 1e12;
  return { role: 'assistant', content, api: 'openai-completions', provider: s.provider, model: s.model,
    usage: { input: uncached, output: u.completion_tokens, cacheRead: cached, cacheWrite: 0, totalTokens: u.total_tokens,
      cost: { input, output, cacheRead, cacheWrite: 0, total: input + cacheRead + output } },
    stopReason: c.finish_reason === 'tool_calls' ? 'toolUse' : 'stop', timestamp: Date.now() };
}
function createMailbox(profile, gate) {
  fs.mkdirSync('/work/model-relay', { mode: 0o700 });
  let sequence = 0, busy = false;
  return async body => {
    gate(); assert.equal(busy, false); busy = true;
    try {
      assert.ok(++sequence <= profile.maxRequests && body.length <= profile.settings.maxRequestBytes);
      const request = JSON.stringify({ sequence, body: body.toString('base64') });
      fs.writeFileSync('/work/model-relay/request.tmp', request, { flag: 'wx', mode: 0o600 });
      fs.renameSync('/work/model-relay/request.tmp', '/work/model-relay/request.json');
      for (;;) {
        gate();
        try {
          const file = '/work/model-relay/response.json', st = fs.lstatSync(file);
          assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= profile.settings.maxResponseBytes * 2 + 128);
          const r = JSON.parse(fs.readFileSync(file));
          if (r.sequence === sequence) {
            const b = Buffer.from(r.body, 'base64'); assert.ok(b.length <= profile.settings.maxResponseBytes && b.toString('base64') === r.body);
            fs.unlinkSync(file); return b;
          }
          assert.ok(r.sequence < sequence);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { busy = false; }
  };
}
function modelStream(profile, exchange, gate) {
  return (selected, context, options) => {
    const result = (async () => {
      gate(); assert.ok(!options?.signal?.aborted); assert.equal(selected.provider, profile.settings.provider); assert.equal(selected.id, profile.settings.model);
      const tools = sdkTools(context.tools, profile), s = profile.settings;
      const body = Buffer.from(JSON.stringify({ model: s.model, messages: sdkMessages(context), temperature: s.temperature,
        max_completion_tokens: s.maxOutputTokens, n: 1, stream: false, store: false, tools, tool_choice: 'auto', parallel_tool_calls: false,
        ...(nonThinking(s) ? { thinking: { type: 'disabled' } } : {}) }));
      const response = await exchange(body); gate(); assert.ok(!options?.signal?.aborted);
      return assistantMessage(JSON.parse(response), profile);
    })();
    // Avoid a temporarily unhandled rejection if the SDK opens the iterator later.
    void result.catch(() => {});
    return { result: () => result, async *[Symbol.asyncIterator]() {
      const message = await result;
      yield { type: 'start', partial: message };
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === 'toolCall') yield { type: 'toolcall_end', contentIndex, toolCall: block, partial: message };
        else yield { type: 'text_end', contentIndex, content: block.text, partial: message };
      }
      yield { type: 'done', reason: message.stopReason, message };
    } };
  };
}
module.exports = { sdkMessages, sdkTools, assistantMessage, createMailbox, modelStream };
