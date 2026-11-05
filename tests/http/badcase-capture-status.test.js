// Real metadata-only coverage and location reporting; no native reader/model.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),{PassThrough}=require('node:stream');
const {createBadcaseCaptureController}=require('../../build/server/api/badcase-capture-controller');
const {createBadcaseCaptureService}=require('../../build/server/domain/runtime/badcase-capture');
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'caff-status-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'repo');fs.mkdirSync(root);const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0'};
 for(const k of Object.keys(env))if(/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(k))delete env[k];
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 git(root,'init','-q');fs.writeFileSync(path.join(root,'base.txt'),'base');git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=f@invalid.local','commit','-qm','base');
 const rooms=[],project={id:'p',path:root},service=createBadcaseCaptureService({captureRoot:path.join(base,'capture'),agentDir:path.join(base,'agent'),getProject:()=>project});
 const options={service,projectManager:{listProjects:()=>[project]},listRoomWorktrees:id=>{assert.equal(id,'p');return rooms;},sessionInputDir:path.join(base,'sessions'),host:'127.0.0.1',port:4313,csrfToken:'fixture'};
 const invoke=async(body,custom={})=>{const controller=createBadcaseCaptureController({...options,...custom}),req=new PassThrough();req.method=body===undefined?'GET':'POST';req.socket={remoteAddress:'127.0.0.1'};req.headers={host:'127.0.0.1:4313',origin:'http://127.0.0.1:4313','content-type':'application/json','x-caff-csrf-token':'fixture'};let payload;const res={writeHead(s){this.status=s;},end(b){payload={status:this.status,body:JSON.parse(b)};}};const pending=controller({req,res,pathname:'/api/projects/p/badcase-capture'+(body===undefined?'':'/configure')});req.end(body===undefined?undefined:JSON.stringify(body));assert.equal(await pending,true);return payload;};
 const room=name=>{const dir=path.join(base,name);git(root,'worktree','add','-qb','room/'+name,dir);return dir;};
 return {base,root,rooms,project,service,git,room,invoke};
}
test('state counts distinct registered room worktrees, including new bindings; not root, unrelated clones, plain paths or stale bindings',async t=>{
 const h=fixture(t),a=h.room('a'),b=h.room('b'),other=path.join(h.base,'other'),plain=path.join(h.base,'plain');h.git(h.base,'clone','-q','--no-local',h.root,other);fs.mkdirSync(plain);
 h.rooms.push(a,a,b,h.root,other,plain,path.join(h.base,'missing'));
 const policy=h.service.loadPolicy('p'),before=fs.readFileSync(path.join(h.root,'.git','index'));
 h.service.estimateGitDirectoryAsync=()=>assert.fail('GET must not scan files');h.service.captureTurnCheckpoint=()=>assert.fail('GET must not capture');
 const first=(await h.invoke()).body;assert.equal(first.projectPath,h.root);assert.equal(first.coverage.roomWorktreeCount,2);assert.equal(first.coverage.basis,'git-registered-room-worktrees');
 h.rooms.push(h.room('new'));assert.equal((await h.invoke()).body.coverage.roomWorktreeCount,3);
 h.git(h.root,'worktree','remove',b);assert.equal((await h.invoke()).body.coverage.roomWorktreeCount,2);
 assert.deepEqual(h.service.loadPolicy('p'),policy);assert.deepEqual(fs.readFileSync(path.join(h.root,'.git','index')),before);assert.equal(h.service.store.listCheckpoints('p').length,0);
});
test('coverage failures are unknown, preserve last capture and do not break the off switch',async t=>{
 const h=fixture(t);h.service.store.savePolicy({projectId:'p',status:'enabled',authorizedDirs:[h.root]});
 h.service.store.saveCaptureResult('p',{status:'partial',captured:true,skippedCount:2,targetDir:h.root,createdAt:new Date().toISOString()});
 const unavailable={listRoomWorktrees:()=>{throw Error('private failure');}};
 const state=(await h.invoke(undefined,unavailable)).body;assert.equal(state.coverage.roomWorktreeCount,null);assert.equal(state.coverage.reason,'coverage_unavailable');assert.equal(state.lastCapture.skippedCount,2);assert.doesNotMatch(JSON.stringify(state),/private failure/);
 assert.equal((await h.invoke({enabled:false,confirmed:true},unavailable)).body.policy.status,'disabled');
});
test('location warning is read-only and a dedicated enable rejection gives the project-outside remedy; disabling stays possible',async t=>{
 const h=fixture(t),service=createBadcaseCaptureService({captureRoot:path.join(h.root,'capture'),agentDir:path.join(h.base,'agent'),getProject:()=>h.project});
 const state=(await h.invoke(undefined,{service})).body;assert.equal(state.storage.insideProject,true);assert.equal(state.storage.overlapsProject,true);assert.equal(state.policy.status,'disabled');
 await assert.rejects(()=>h.invoke({enabled:true,confirmed:true},{service}),e=>e.issues?.[0]?.code==='badcase_capture_storage_overlaps_project');
 service.store.savePolicy({projectId:'p',status:'enabled',authorizedDirs:[h.root]});assert.equal((await h.invoke({enabled:false,confirmed:true},{service})).body.policy.status,'disabled');
});
test('storage aliases are recognized without exposing the capture-library absolute path',async t=>{
 const h=fixture(t),alias=path.join(h.base,'alias');fs.symlinkSync(h.root,alias,process.platform==='win32'?'junction':'dir');
 const captureRoot=path.join(alias,'capture'),service=createBadcaseCaptureService({captureRoot});fs.mkdirSync(captureRoot);
 const state=(await h.invoke(undefined,{service})).body;assert.equal(state.storage.insideProject,true);assert.equal(JSON.stringify(state).includes(captureRoot),false);
});
