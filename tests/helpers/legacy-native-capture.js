// Explicit offline schema-v1 fixture, NEVER a production facade. Keep old
// capture/restore regressions exercising the retained native implementations
// without asserting that a new service turn still selects that retired path.
const base = '../../build/server/domain/runtime/badcase-capture/';
function createLegacyNativeCaptureService(options = {}, { readCallbackSource = false } = {}) {
  const service = require(base + 'index').createBadcaseCaptureService(options);
  const collectorOptions = { ...options, store: service.store };
  if (readCallbackSource) {
    const { readPreTurnCallbackInput } = require(base + 'callback-source');
    collectorOptions.readCallbackInput = (input, policy) => readPreTurnCallbackInput(options.chatStore, input, policy);
  }
  const collector = process.platform === 'win32'
    ? require(base + 'windows-turn-collector').createWindowsTurnCollector({ ...collectorOptions,
      resolveRoomWorktreeScope: require(base + 'room-worktree-scope').createRoomWorktreeScopeResolver(options) })
    : require(base + 'collector').createCollector(collectorOptions);
  service.captureTurnCheckpoint = collector.captureTurnCheckpoint;
  delete service.captureLoadedProjectSkills; // no v2 SDK gate in this offline v1 fixture
  return service;
}
module.exports = { createLegacyNativeCaptureService };
