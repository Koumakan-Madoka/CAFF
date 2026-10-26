import { isLoopbackAddress } from '../../http/request-authority';
import { MINIMUM_PLANNER_CLI, resolvePlannerCli, probePlannerCli } from './embedded-planner-cli';
import { buildPlannerEnvironment, plannerError } from './embedded-planner-env';
import { createEmbeddedPlannerHost, type EmbeddedPlannerHost } from './embedded-planner-host';
import { resolvePlannerRoom } from './embedded-planner-room';
import { EmbeddedPlannerRepository } from '../../../storage/chat/embedded-planner.repository';

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
  async function start(baseUrl: string, credentialPath: string | null) {
    if (!enabled || closed) return;
    startup = (async () => {
      try {
        const env = buildPlannerEnvironment({ source: config.env, baseUrl });
        const cli = resolvePlannerCli({ override: config.cliPath ?? process.env.CAFF_CLAUDE_CLI, env });
        const version = await probePlannerCli(cli, env);
        if (closed) return;
        host = createEmbeddedPlannerHost({ repository: repository!, cli, baseUrl, credentialPath, env: config.env, launch: config.launch,
          resolveRoom: id => resolvePlannerRoom(options.store, options.projectManager, id) });
        capability = { ...capability, available: true, reasonCode: '', cliVersion: version };
      } catch (error: any) {
        const allowed = ['planner_environment_invalid','planner_cli_missing','planner_cli_version_invalid','planner_cli_version_unsupported','planner_cli_probe_timeout','planner_cli_launch_unsupported'];
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
    return { available: capability.available,
      reasonCode: processState === 'uncertain' ? 'planner_process_exit_unconfirmed' : capability.reasonCode,
      processState, attached: processState === 'interactive-attached', wakeupsEnabled: metadata?.wakeupsEnabled || false,
      sessionInitialized: metadata?.launchAttempted || false,
      pendingCount: repository?.pendingCount(id, room.metadata?.sessionGoal?.goalId) || 0, needsUserCount: 0,
      quota: { used: 0, limit: 4, nextEligibleAt: null } };
  }
  return { start, roomState, getHost: () => host, capability: () => ({ ...capability }),
    async close() { closed = true; capability.available = false; await startup; await host?.close(); } };
}
