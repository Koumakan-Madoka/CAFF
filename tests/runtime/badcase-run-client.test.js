const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib');
const { createWikiRunClient, loadWikiRunTools } = require('../../scripts/badcase-capture/wiki-run-client.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-run-client-')), dir = path.join(root, '.pi-sandbox'); fs.mkdirSync(dir);
  const access = 'test.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url') + '.synthetic';
  const authFile = path.join(dir, 'auth.json'), bytes = JSON.stringify({ 'openai-codex': { type: 'oauth', access, expires: Date.now() + 3600000, refresh: 'MUST-NOT-USE' } }); fs.writeFileSync(authFile, bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { authFile, access, bytes };
}
function sse() {
  const item = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'literal output <script>not HTML</script>', annotations: [] }] };
  return [{ type: 'response.created', response: { id: 'r', status: 'in_progress' } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('');
}
const request = () => ({ model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', context: { systemPrompt: 'frozen system [REDACTED]', messages: [{ role: 'user', content: 'frozen input', timestamp: 1 }], tools: [{ name: 'write', description: 'not executable', parameters: { type: 'object', properties: { content: { type: 'string' } } } }] } });
test('native serializer/parser makes exactly one proxied SSE request with xhigh and schemas; auth file stays byte-identical', async t => {
  const f = fixture(t); let calls = 0, wire;
  const client = await createWikiRunClient({ authFile: f.authFile }, { transport: { createDispatcher(uri) { assert.equal(uri, 'http://127.0.0.1:17890'); return { destroy: async () => {} }; }, async fetch(url, options) {
    calls++; assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses'); assert.equal(options.headers.get('authorization'), 'Bearer ' + f.access); assert.equal(options.redirect, 'error');
    const bytes = options.headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(options.body) : options.body; wire = JSON.parse(String(bytes));
    return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } });
  } } });
  t.after(() => client.close()); const q = request(), r = await client.complete(q);
  assert.equal(calls, 1); assert.equal(r.networkRequests, 1); assert.equal(wire.model, 'gpt-6.1-sol'); assert.equal(wire.reasoning.effort, 'xhigh'); assert.equal(wire.store, false);
  assert.equal(wire.instructions, q.context.systemPrompt); assert.equal(wire.tools[0].name, 'write'); assert.equal(r.wireRequest.tools[0].name, 'write');
  assert.match(r.message.content[0].text, /literal output/); assert.equal(r.message.usage.cost, undefined);
  assert.doesNotMatch(JSON.stringify(r), /MUST-NOT-USE|synthetic-account|test\./); assert.equal(fs.readFileSync(f.authFile, 'utf8'), f.bytes);
  await assert.rejects(client.complete(q), e => e.code === 'wiki_run_budget_exhausted'); assert.equal(calls, 1);
});
test('offline expected wire matches SDK serialization with ordered cross-provider history and schemas', async t => {
  const { buildWikiRunWireRequest, verifyWikiRunWireRequest } = require('../../build/server/domain/runtime/badcase-capture/wiki-run-wire');
  const f=fixture(t),q=request();
  q.context.tools.push({name:'read',description:'second schema',parameters:{type:'object',properties:{path:{type:'string'}}}});
  q.context.messages.push({role:'assistant',provider:'anthropic',api:'anthropic-messages',model:'foreign',stopReason:'toolUse',content:[
    {type:'thinking',thinking:'retained foreign reasoning'}, {type:'text',text:'before call'},
    {type:'toolCall',id:'call:1|item.with.dots',name:'write',arguments:{content:'quoted "text"\nnext'}}]},
    {role:'toolResult',toolCallId:'call:1|item.with.dots',toolName:'write',content:[{type:'text',text:'tool result'}]},
    {role:'user',content:[{type:'text',text:'last user message'}]});
  const before=structuredClone(q);let wire;
  const client=await createWikiRunClient({authFile:f.authFile},{transport:{createDispatcher:()=>({destroy:async()=>{}}),async fetch(url,options){
    wire=JSON.parse(String(options.headers.get('content-encoding')==='zstd'?zlib.zstdDecompressSync(options.body):options.body));
    return new Response(sse(),{headers:{'content-type':'text/event-stream'}});
  }}});t.after(()=>client.close());
  const r=await client.complete(q),expected=buildWikiRunWireRequest(q);
  assert.deepEqual(JSON.parse(JSON.stringify(expected)),wire);assert.equal(verifyWikiRunWireRequest(q,r.wireRequest),true);
  assert.deepEqual(buildWikiRunWireRequest(q),expected);assert.deepEqual(q,before);
  assert.equal(expected.input.filter(m=>m.type==='function_call').length,1);assert.equal(expected.input.filter(m=>m.type==='function_call_output').length,1);
  for(const mutate of [x=>x.model='other',x=>x.instructions+='changed',x=>x.input.reverse(),x=>x.input[0].content[0].text+='changed',
    x=>x.tools[0].name='other',x=>x.tools.reverse(),x=>x.tools[0].parameters.properties.content.type='number',x=>x.reasoning.effort='low',
    x=>x.reasoning.summary='none',x=>x.tool_choice='none',x=>x.parallel_tool_calls=false,x=>x.store=true,x=>x.stream=false,
    x=>x.text.verbosity='high',x=>x.include=[],x=>x.temperature=1,x=>x.prompt_cache_key='unexpected',x=>delete x.input]){
    const altered=structuredClone(wire);mutate(altered);assert.equal(verifyWikiRunWireRequest(q,altered),false);
  }
  for(const missing of [null,undefined,{},[],false])assert.equal(verifyWikiRunWireRequest(q,missing),false);
  // Identical known-value replacement on BOTH sides, including escaped strings.
  const key='synthetic-quote"\nvalue',withKnown=structuredClone(q);withKnown.context.systemPrompt+=key;
  const safe=buildWikiRunWireRequest(q);safe.instructions=withKnown.context.systemPrompt.replace(key,'[*]');
  assert.equal(verifyWikiRunWireRequest(withKnown,safe,[key]),true);assert.equal(verifyWikiRunWireRequest(withKnown,safe),false);
  assert.deepEqual(q,before);
});
test('comparison store imports without SDK; lazy wire verification fails closed and caches loading failures', () => {
  for(const mode of ['missing','require-failed','wrong-version','available']){
    // A fresh process exercises the entire server import chain without sharing
    // a previously cached serializer or changing another test's module loader.
    const script=`
      const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),Module=require('node:module');
      const mode=process.argv[1],lookup=Module._resolveLookupPaths,load=Module._load;let lookups=0,loads=0;
      Module._resolveLookupPaths=function(name,...args){if(name==='@earendil-works/pi-coding-agent'){lookups++;if(mode==='missing')return [];}return lookup.call(this,name,...args);};
      Module._load=function(name,...args){const portable=String(name).replaceAll('\\\\','/');
        if(portable.endsWith('/pi-ai/dist/api/openai-responses-shared.js')){loads++;if(mode==='require-failed')throw Error('synthetic SDK unavailable');}
        if(mode==='wrong-version'&&portable.endsWith('/pi-ai/package.json'))return {version:'0.0.0'};
        return load.call(this,name,...args);
      };
      assert.doesNotThrow(()=>require('./build/server/domain/runtime/badcase-capture/wiki-comparison-store'));
      const {buildWikiRunWireRequest,verifyWikiRunWireRequest}=require('./build/server/domain/runtime/badcase-capture/wiki-run-wire');
      assert.equal(lookups,0,'server import must not resolve SDK');assert.equal(loads,0,'server import must not load serializer');
      const request=${JSON.stringify(request())};
      if(mode==='available'){
        const wire=buildWikiRunWireRequest(request);assert.equal(verifyWikiRunWireRequest(request,wire),true);
        assert.equal(loads,1);const before=lookups;assert.deepEqual(buildWikiRunWireRequest(request),wire);assert.equal(lookups,before);assert.equal(loads,1);
      }else{
        assert.equal(verifyWikiRunWireRequest(request,{}),false);const before=[lookups,loads];assert.ok(lookups>0);
        assert.throws(()=>buildWikiRunWireRequest(request),{code:'wiki_run_wire_request_invalid'});
        assert.equal(verifyWikiRunWireRequest(request,{}),false);assert.deepEqual([lookups,loads],before,'failed load is cached too');
        if(mode==='require-failed')assert.equal(loads,1);
      }
      console.log('PASS');`;
    const child=require('node:child_process').spawnSync(process.execPath,['-e',script,mode],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8',timeout:30000});
    assert.equal(child.status,0,mode+': '+child.stderr);assert.equal(child.stdout.trim(),'PASS');
  }
});
test('provider/network failure cannot trigger retries, an auth refresh or diagnostic leaks', async t => {
  const f = fixture(t); let calls = 0;
  const client = await createWikiRunClient({ authFile: f.authFile }, { transport: { createDispatcher: () => ({ destroy: async () => {} }), async fetch() { calls++; return new Response('PRIVATE UPSTREAM BODY', { status: 503 }); } } });
  t.after(() => client.close());
  await assert.rejects(client.complete(request()), e => e.code === 'wiki_run_model_failed' && !e.message.includes('PRIVATE'));
  assert.equal(calls, 1); assert.equal(fs.readFileSync(f.authFile, 'utf8'), f.bytes);
});
test('fixed SDK and pinned capabilities produce JSON-only schemas, never executors', async () => {
  const root = path.resolve(__dirname, '../..'), sha = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const t = await loadWikiRunTools({ sourceWorktree: root, capabilitiesSha: sha });
  assert.equal(t.codingAgentVersion, '0.85.1'); assert.deepEqual(t.definitions.slice(0, 4).map(t => t.name), ['read', 'bash', 'edit', 'write']); assert.ok(t.definitions.length >= 10);
  for (const d of t.definitions) assert.deepEqual(Object.keys(d).sort(), ['description', 'name', 'parameters']);
});
