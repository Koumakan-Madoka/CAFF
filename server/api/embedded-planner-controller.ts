import { createLocalAdminGuard } from '../http/local-admin-guard';
import { singleHeader } from '../http/request-authority';
import { matchesPlannerToken } from '../http/planner-terminal';
import { createHttpError } from '../http/http-errors';
import { sendJson } from '../http/response';
import { readRawRequestBody } from '../http/request-body';

export function createEmbeddedPlannerController(options: any) {
  const guard = createLocalAdminGuard({ host: options.host, getAuthority: options.getAuthority, csrfToken: options.csrfToken });
  function readGuard(req:any,principal:any) {
    const {authority}=guard.assertRead(req);
    if(principal?.kind!=='planner'){
      const origin=singleHeader(req,'origin');
      if(!matchesPlannerToken(singleHeader(req,'x-caff-csrf-token'),options.csrfToken)||(origin&&origin.toLowerCase()!==new URL('http://'+authority).origin))throw createHttpError(403,'Planner read rejected',{code:'planner_terminal_auth_invalid'});
    }
  }
  function number(params:URLSearchParams,key:string,fallback:number,min:number,max=Number.MAX_SAFE_INTEGER){
    const raw=params.get(key);if(raw===null)return fallback;
    const n=Number(raw);if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(n)||n<min||n>max)throw createHttpError(400,'Invalid wake-up cursor');return n;
  }
  return async function route({ req, res, pathname, requestUrl, principal }: any) {
    const wake=/^\/api\/conversations\/([^/]+)\/planner\/wakeups(?:\/([^/]+)(\/finish)?)?$/.exec(pathname);
    if(wake&&options.runtime.capability().enabled){
      try {
      const [_,id,attempt,finish]=wake;
      if((req.method==='PUT'&&!attempt)||(req.method==='POST'&&finish)){
        if(principal?.kind!==(finish?'planner':'user'))throw createHttpError(403,'Wake-up principal rejected',{code:finish?'planner_wakeup_planner_required':'planner_wakeup_user_required'});
        guard.assertMutation(req);
        if(!options.store.getConversationWithoutMessages(id))throw createHttpError(404,'Room not found');
        if(requestUrl.search)throw createHttpError(400,'Invalid wake-up query');
        const bytes=await readRawRequestBody(req,{bodyLimit:finish?16384:1024});
        const raw=bytes.toString('utf8');if(!Buffer.from(raw,'utf8').equals(bytes))throw createHttpError(400,'Invalid UTF-8 receipt');
        try{
          if(finish){
            let body:any;try{body=JSON.parse(raw);}catch{throw createHttpError(400,'Invalid receipt');}
            // Exact adapter wrapper: rejects duplicate keys and alternate encodings
            // independently of the argument parser. No browser submits receipts.
            if(JSON.stringify(body)!==raw||!body||Object.keys(body).join()!=='items')throw createHttpError(400,'Invalid receipt');
            sendJson(res,200,options.runtime.finishWakeup(id,attempt,body.items));
          }else{
            const match=/^\s*\{\s*"enabled"\s*:\s*(true|false)\s*\}\s*$/.exec(raw);if(!match)throw createHttpError(400,'Invalid wake-up toggle');
            sendJson(res,200,options.runtime.toggleWakeups(id,match[1]==='true'));
          }
        }catch(error:any){
          if(error?.code==='planner_room_missing')throw createHttpError(404,'Room not found');
          if(error?.code==='planner_session_unavailable')throw createHttpError(409,'Planner session metadata unavailable',{code:error.code});
          if(error?.code==='planner_wakeup_goal_unbound')throw createHttpError(409,'A matching planner-bound Goal is required',{code:error.code});
          if(['planner_process_limit_invalid','planner_wakeup_tools_unverified','planner_wakeup_credential_unavailable','planner_wakeup_settings_unsafe'].includes(error?.code))throw createHttpError(503,'Wake-ups unavailable',{code:error.code});
          throw error;
        }
        return true;
      }
      if(req.method==='GET'&&!finish){
        readGuard(req,principal);
        if(!options.store.getConversationWithoutMessages(id))throw createHttpError(404,'Room not found');
        const allowed=attempt?['afterChunk','limit']:['before','limit'];
        for(const key of requestUrl.searchParams.keys())if(!allowed.includes(key)||requestUrl.searchParams.getAll(key).length!==1)throw createHttpError(400,'Invalid wake-up query');
        const limit=number(requestUrl.searchParams,'limit',attempt?50:20,1,100);
        sendJson(res,200,attempt?options.runtime.wakeupDetail(id,attempt,number(requestUrl.searchParams,'afterChunk',0,0),limit):options.runtime.listWakeups(id,number(requestUrl.searchParams,'before',Number.MAX_SAFE_INTEGER,1),limit));return true;
      }
      return false;
      } catch (error:any) {
        if(String(error?.code||'').startsWith('SQLITE_'))throw createHttpError(503,'Wake-up storage unavailable',{code:'planner_wakeup_storage_unavailable'});
        throw error;
      }
    }
    const mutation = /^\/api\/conversations\/([^/]+)\/planner\/terminal\/(repair|session\/reinitialize)$/.exec(pathname);
    if (mutation && req.method === 'POST' && options.runtime.capability().enabled) {
      const operation = mutation[2] === 'repair' ? 'repair' : 'session_reinitialize';
      if (principal?.kind !== 'user') throw createHttpError(403, 'Only a browser user may recover a planner terminal', { code: `planner_terminal_${operation}_user_required` });
      guard.assertMutation(req);
      if (requestUrl.search) throw createHttpError(400, 'Invalid planner query');
      const body = await readRawRequestBody(req, { bodyLimit: 1024 });
      // This closed, single-field protocol also rejects duplicate confirmations.
      if (!/^[\x20\t\r\n]*\{[\x20\t\r\n]*"confirm"[\x20\t\r\n]*:[\x20\t\r\n]*true[\x20\t\r\n]*\}[\x20\t\r\n]*$/.test(body.toString('utf8'))) {
        throw createHttpError(400, 'Explicit recovery confirmation required', { code: `planner_terminal_${operation}_confirmation_required` });
      }
      try { sendJson(res, 200, operation === 'repair' ? options.runtime.repair(mutation[1]) : options.runtime.reinitializeSession(mutation[1])); }
      catch (error: any) {
        if (error?.code === 'planner_room_missing') throw createHttpError(404, 'Room not found');
        if (error?.code === 'planner_room_busy') throw createHttpError(409, 'Planner process is still owned by this instance', { code: error.code });
        if (error?.code === 'planner_process_exit_unconfirmed') throw createHttpError(409, 'Repair the planner lease before reinitializing its session', { code: error.code });
        if (error?.code === 'planner_session_unavailable') throw createHttpError(409, 'Planner session metadata is unavailable; user inspection is required', { code: error.code });
        throw error;
      }
      return true;
    }
    const match = /^\/api\/conversations\/([^/]+)\/planner\/state$/.exec(pathname);
    if (!match || req.method !== 'GET' || !options.runtime.capability().enabled) return false;
    const { authority } = guard.assertRead(req);
    if (principal?.kind !== 'planner') {
      const origin = singleHeader(req, 'origin');
      if (!matchesPlannerToken(singleHeader(req, 'x-caff-csrf-token'), options.csrfToken)
        || (origin && origin.toLowerCase() !== new URL('http://' + authority).origin)) {
        throw createHttpError(403, 'Planner read rejected', { code: 'planner_terminal_auth_invalid' });
      }
    }
    if (requestUrl.search) throw createHttpError(400, 'Invalid planner query');
    try { sendJson(res, 200, options.runtime.roomState(match[1])); }
    catch (error: any) {
      if (error?.code === 'planner_room_missing') throw createHttpError(404, 'Room not found');
      if (error?.code === 'planner_session_unavailable') throw createHttpError(409, 'Planner session metadata is unavailable; user inspection is required', { code: error.code });
      throw error;
    }
    return true;
  };
}
