// Explicit OFFLINE rehearsal: native SDK -> local fake supplier SSE -> real
// Docker file tool. NOT a real-model, sealed-checkpoint or badcase score.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { prepareDirectTurnFiles, runDirectDockerTask } = require('./direct-docker.cjs');
const { syntheticSession } = require('./pi-probe-materials.cjs');
const fakeEntry = `
const http=require('node:http'),assert=require('node:assert/strict');
let calls=0;
const server=http.createServer(async(req,res)=>{try{
 assert.equal(req.url,'/v1/chat/completions');assert.equal(req.method,'POST');
 assert.equal(req.headers.authorization,'Bearer '+process.env.CAFF_BADCASE_MODEL_KEY);
 let data='';for await(const b of req)data+=b;const q=JSON.parse(data);
 assert.equal(q.model,'deepseek-v4.1-flash');assert.equal(q.stream,true);assert.ok(q.tools.length>=10);
 const resumed=JSON.parse(require('node:fs').readFileSync('/work/replay-input.json')).sessionText!==null;
 assert.equal(JSON.stringify(q.messages).includes('synthetic history only'),resumed);
 calls++;assert.ok(calls<=2);
 const chunk=(delta,finish_reason=null)=>({id:'offline-direct-'+calls,object:'chat.completion.chunk',created:1,model:q.model,choices:[{index:0,delta,finish_reason}]});
 const rows=calls===1?[chunk({role:'assistant',tool_calls:[{index:0,id:'offline-write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'validation-result.txt',content:'native direct SDK file tool\\n'})}}]}),chunk({},'tool_calls')]
  :[chunk({role:'assistant',content:'DONE'}),chunk({},'stop')];
 rows.push({id:'offline-direct-'+calls,object:'chat.completion.chunk',created:1,model:q.model,choices:[],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}});
 res.writeHead(200,{'content-type':'text/event-stream'});for(const row of rows)res.write('data: '+JSON.stringify(row)+'\\n\\n');res.end('data: [DONE]\\n\\n');
}catch{res.writeHead(500);res.end('offline_fixture_failed')}});
server.listen(0,'127.0.0.1',async()=>{try{
 const r=await require('/work/direct-sdk-container.cjs').main({baseUrl:'http://127.0.0.1:'+server.address().port+'/v1'});
 assert.equal(calls,2);assert.equal(r.modelCalls.length,2);assert.equal(r.success,true);
 assert.equal(r.historyMessages,JSON.parse(require('node:fs').readFileSync('/work/replay-input.json')).sessionText===null?0:1);
 assert.equal(require('node:fs').readFileSync('/work/restored/validation-result.txt','utf8'),'native direct SDK file tool\\n');
 await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({...r,offlineSupplierRequests:calls,realModelRequests:0}));
}catch(e){await new Promise(resolve=>server.close(resolve));process.stderr.write('offline_direct_sdk_failed:'+e.message+'\\n');process.exitCode=1}});
`;
async function verifyDirectSdk(repoRoot, dependencyRoot, image, mode = 'fresh') {
  assert.ok(['fresh', 'resume'].includes(mode));
  const input = { kind: 'prepared-caff-turn-v1', prompt: 'Use write to create validation-result.txt, then reply DONE.', files: [], sessionText: mode === 'resume' ? syntheticSession() : null,
    systemPrompt: 'Follow the requested file task in this disposable test project.', settings: { retry: { enabled: false }, compaction: { enabled: false } }, callback: null };
  const files = prepareDirectTurnFiles(repoRoot, dependencyRoot, image, input);
  files.find(f => f.path === 'probe.cjs').path = 'direct-sdk-container.cjs'; files.push({ path: 'probe.cjs', bytes: Buffer.from(fakeEntry) });
  const r = await runDirectDockerTask(image, files, { key: 'offline-direct-model-test-key-123456', network: 'none', timeoutMs: 30000 });
  assert.equal(r.code, 0); assert.equal(r.cleaned, true); assert.equal(r.receipt.realModelRequests, 0); assert.equal(r.receipt.success, true);
  assert.equal(r.receipt.modelCalls.length, 2); assert.ok(r.receipt.modelCalls.every(c => c.success && c.usage.totalTokens === 25));
  assert.deepEqual(r.receipt.toolCalls, [{ name: 'write', isError: false }]);
  assert.equal(r.receipt.sealedCheckpointVerified, false); assert.equal(r.isolation.privileged, false); assert.equal(r.isolation.network, 'none');
  return { ...r, deliveryMode: mode, verification: 'offline-native-sdk-direct-http', realModelRequests: 0, realCheckpoint: false };
}
if (require.main === module) {
  const [imageFile, dependencyRoot] = process.argv.slice(2);
  (async () => {
    const reports = [];
    for (const mode of ['fresh', 'resume']) reports.push(await verifyDirectSdk(path.resolve(__dirname, '../..'), path.resolve(dependencyRoot), JSON.parse(fs.readFileSync(imageFile)), mode));
    console.log(JSON.stringify({ reports, realModelRequests: 0, realCheckpoint: false }, null, 2));
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { verifyDirectSdk };
