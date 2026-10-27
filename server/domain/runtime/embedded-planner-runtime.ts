import { isLoopbackAddress } from '../../http/request-authority';
import { MINIMUM_PLANNER_CLI, resolvePlannerCli, probePlannerCli } from './embedded-planner-cli';
import { buildPlannerEnvironment, plannerError } from './embedded-planner-env';
import { createEmbeddedPlannerHost, type EmbeddedPlannerHost } from './embedded-planner-host';
import { resolvePlannerRoom } from './embedded-planner-room';
import { EmbeddedPlannerRepository } from '../../../storage/chat/embedded-planner.repository';
import { PlannerWakeupRepository } from '../../../storage/chat/planner-wakeup.repository';
import { createPlannerWakeupRuntime } from './planner-wakeup-runtime';

export function createEmbeddedPlannerRuntime(options: any) {
  const config = options.config || {};
  const requested = config.enabled ?? process.env.CAFF_PLANNER_TERMINAL === '1';
  const enabled = requested && isLoopbackAddress(options.host);
  let host: EmbeddedPlannerHost | null = null;
  let closed = false;
  let startup: Promise<void> | null = null;
  let capability = { enabled: !!enabled, available: false, reasonCode: enabled ? 'planner_cli_checking' : requested ? 'planner_terminal_local_only' : 'planner_terminal_disabled',
    minimumVersion: MINIMUM_PLANNER_CLI, cliVersion: null as string | null };
  const repository = enabled ? new EmbeddedPlannerRepository(options.store) : null;
  let records = enabled ? new PlannerWakeupRepository(options.store) : null;
  let wakeups: ReturnType<typeof createPlannerWakeupRuntime> | null = null;
  async function start(baseUrl: string, credentialPath: string | null, credential?: any) {
    if (!enabled || closed) return;
    startup = (async () => {
      try {
        records!.interrupt();
        repository!.reconcileLeases({ probe: config.probeGuardian, log: config.log });
        const env = buildPlannerEnvironment({ source: config.env, baseUrl });
        const cli = resolvePlannerCli({ override: config.cliPath ?? process.env.CAFF_CLAUDE_CLI, env });
        const version = await probePlannerCli(cli, env);
        if (closed) return;
        host = createEmbeddedPlannerHost({ repository: repository!, cli, baseUrl, credentialPath, env: config.env, launch: config.launch,
          resolveRoom: id => resolvePlannerRoom(options.store, options.projectManager, id) });
        capability = { ...capability, available: true, reasonCode: '', cliVersion: version };
        wakeups = createPlannerWakeupRuntime({store:options.store,host,version,credentialPath,credential,env:config.env,privateValues:options.privateValues,config});
        records = wakeups.repository;
      } catch (error: any) {
        const allowed = ['planner_environment_invalid','planner_cli_missing','planner_cli_version_invalid','planner_cli_version_unsupported','planner_cli_probe_timeout','planner_cli_launch_unsupported','planner_conpty_unavailable'];
        capability = { ...capability, available: false, reasonCode: allowed.includes(error?.code) ? error.code : 'planner_cli_launch_unsupported' };
      }
    })();
    await startup;
  }
  function roomState(id: string) {
    const room = options.store.getConversationWithoutMessages(id);
    if (!room) throw plannerError('planner_room_missing');
    const metadata = repository?.read(id);
    const processState = host?.state(id) || (repository?.hasLease(id) ? 'uncertain' : 'absent');
    const goal=room.metadata?.sessionGoal,binding=room.metadata?.sessionGoalPlannerBinding;
    const bound=goal && ['active','paused'].includes(goal.status) && binding?.goalId===goal.goalId && binding?.plannerId==='local-planner' && !room.metadata?.dagNodeGoalBinding;
    const unavailableWakeReason=['planner_cli_version_unsupported','planner_cli_version_invalid'].includes(capability.reasonCode)?'planner_wakeup_tools_unverified':capability.reasonCode;
    return { available: capability.available,
      reasonCode: processState === 'uncertain' ? 'planner_process_exit_unconfirmed' : capability.reasonCode,
      processState, attached: processState === 'interactive-attached', wakeupsEnabled: metadata?.wakeupsEnabled || false,
      sessionInitialized: metadata?.launchAttempted || false,
      ...(records?.counts(id,room.metadata?.sessionGoal?.goalId) || {pendingCount:0,needsUserCount:0}),
      wakeupAvailable:!!bound && (wakeups?.capability().available || false),
      wakeupReasonCode:wakeups?.capability().reasonCode || (!capability.available?unavailableWakeReason:!bound?'planner_wakeup_goal_unbound':!metadata?.launchAttempted?'session_uninitialized':''),
      quota: records?.quota(id) || { used: 0, limit: 4, nextEligibleAt: null } };
  }
  function repair(id: string) {
    if (!enabled || closed || host?.hasEntry(id)) throw plannerError('planner_room_busy');
    if (!options.store.getConversationWithoutMessages(id)) throw plannerError('planner_room_missing');
    const repaired = repository!.repair(id);
    if (repaired) {
      const log = config.log || ((entry: object) => console.info(JSON.stringify(entry)));
      log({ event: 'planner_lease_released', conversationId: id, reasonCode: 'planner_user_confirmed_repair' });
    }
    return { repaired };
  }
  function reinitializeSession(id: string) {
    if (!enabled || closed || host?.hasEntry(id)) throw plannerError('planner_room_busy');
    if (!options.store.getConversationWithoutMessages(id)) throw plannerError('planner_room_missing');
    // Ownership check and repository transaction are synchronous: admission
    // cannot race between the in-memory fence, durable lease and metadata write.
    const reinitialized = repository!.reinitializeSession(id);
    if (reinitialized) {
      const log = config.log || ((entry: object) => console.info(JSON.stringify(entry)));
      log({ event: 'planner_session_reinitialized', conversationId: id, reasonCode: 'planner_session_reinitialized' });
    }
    return { reinitialized };
  }
  function toggleWakeups(id:string,value:boolean) {
    const room=options.store.getConversationWithoutMessages(id);if(!room)throw plannerError('planner_room_missing');
    if(value){
      const m=room.metadata,g=m?.sessionGoal,b=m?.sessionGoalPlannerBinding;
      if(!g || !['active','paused'].includes(g.status) || b?.goalId!==g.goalId || b?.plannerId!=='local-planner' || m.dagNodeGoalBinding)throw plannerError('planner_wakeup_goal_unbound');
      if(!wakeups?.capability().available)throw plannerError(wakeups?.capability().reasonCode||'planner_wakeup_tools_unverified');
    }
    const result=records!.toggle(id,value);wakeups?.scan();return result;
  }
  return { start, roomState, repair, reinitializeSession, toggleWakeups,
    listWakeups:(id:string,before?:number,limit?:number)=>records!.list(id,before,limit),
    wakeupDetail:(id:string,attempt:string,after?:number,limit?:number)=>records!.detail(id,attempt,after,limit),
    finishWakeup:(id:string,attempt:string,items:any)=>{if(!wakeups)throw plannerError('planner_wakeup_tools_unverified');return records!.finish(id,attempt,items);},
    getHost: () => host, capability: () => ({ ...capability }),
    async close() { closed = true; capability.available = false; await startup; await wakeups?.stop(); await host?.close(); wakeups?.finalize(); } };
}
