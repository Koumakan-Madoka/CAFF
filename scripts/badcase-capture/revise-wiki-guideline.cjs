#!/usr/bin/env node
// Trusted, local manual wording revision. Creates a draft only; normal review,
// candidate confirmation and model execution remain separate authorizations.
const fs=require('node:fs'),path=require('node:path');
const {createWikiStore}=require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const fail=code=>Object.assign(Error(code),{code});
function main(args=process.argv.slice(2)){
 if(args.length!==5 || args[0]!=='--config' || !path.isAbsolute(args[1]||'') || args[2]!=='--confirmed'
   || args[3]!=='--expected-revision' || !/^(0|[1-9][0-9]{0,11})$/.test(args[4]||''))throw fail('wiki_guideline_usage');
 if(!fs.lstatSync(args[1]).isFile() || fs.statSync(args[1]).size>65536)throw fail('wiki_config_invalid');
 const config=JSON.parse(fs.readFileSync(args[1],'utf8'));
 if(!config || Object.keys(config).sort().join(',')!=='entryId,globalRoot,guideline,sourceWorktree,versionId')throw fail('wiki_config_invalid');
 const store=createWikiStore({globalRoot:config.globalRoot,sourceWorktree:config.sourceWorktree}),v=store.reviseGuideline({versionId:config.versionId,entryId:config.entryId,guideline:config.guideline,expectedRevision:Number(args[4])});
 const result={versionId:v.id,parentVersionId:v.parentVersionId,entryId:config.entryId,status:'draft',origin:v.origin,modelsCalled:0};
 process.stdout.write(JSON.stringify(result)+'\n');return result;
}
if(require.main===module){try{main();}catch(e){process.stderr.write(JSON.stringify({error:/^wiki_[a-z_]+$/.test(e?.code||'')?e.code:'wiki_guideline_failed'})+'\n');process.exitCode=1;}}
module.exports={main};
