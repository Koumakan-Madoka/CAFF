export function createBootstrapPayloadBuilder({
  store,
  skillRegistry,
  turnOrchestrator,
  modeStore,
  localAdmin,
  modelCatalog,
  roleService,
}: any) {
  if (!modelCatalog || typeof modelCatalog.getOptions !== 'function') {
    throw new Error('Configured model catalog is required');
  }

  function buildConfiguredModelOptions() {
    return modelCatalog.getOptions();
  }

  function buildBootstrapPayload() {
    if (!roleService || typeof roleService.getDirectory !== 'function') {
      throw new Error('RoleService is required for bootstrap role availability');
    }
    const roleDirectory = roleService.getDirectory();
    const starterConversation = store.ensureStarterConversation();
    const conversations = typeof store.listConversationTree === 'function'
      ? store.listConversationTree()
      : store.listConversations();
    const selectedConversationId = starterConversation ? starterConversation.id : conversations[0] ? conversations[0].id : null;

    return {
      localAdmin: typeof localAdmin === 'function' ? localAdmin() : localAdmin || {},
      runtime: turnOrchestrator.buildRuntimePayload(),
      modelOptions: roleDirectory.modelOptions,
      agents: roleDirectory.agents,
      skills: skillRegistry.listSkills(),
      modes: modeStore ? modeStore.list() : [],
      conversations,
      selectedConversationId,
    };
  }

  return {
    buildBootstrapPayload,
    buildConfiguredModelOptions,
  };
}
