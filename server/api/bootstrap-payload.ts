import {
  DEFAULT_CONVERSATION_DIRECTORY_PAGE_LIMIT,
  buildConversationDirectoryPage,
} from '../domain/conversation/conversation-directory-pagination';

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
    const directoryPage = typeof store.listConversationDirectoryPage === 'function'
      ? buildConversationDirectoryPage(
          store,
          new URLSearchParams(`limit=${DEFAULT_CONVERSATION_DIRECTORY_PAGE_LIMIT}`)
        )
      : null;
    const conversations = directoryPage
      ? directoryPage.conversations
      : typeof store.listConversationTree === 'function'
        ? store.listConversationTree()
        : store.listConversations();
    const selectedConversationId = conversations[0] ? conversations[0].id : null;

    return {
      localAdmin: typeof localAdmin === 'function' ? localAdmin() : localAdmin || {},
      runtime: turnOrchestrator.buildRuntimePayload(),
      modelOptions: roleDirectory.modelOptions,
      agents: roleDirectory.agents,
      skills: skillRegistry.listSkills(),
      modes: modeStore ? modeStore.list() : [],
      conversations,
      conversationsNextCursor: directoryPage ? directoryPage.nextCursor : null,
      conversationsHasMore: directoryPage ? directoryPage.hasMore : false,
      conversationsQuery: '',
      selectedConversationId,
    };
  }

  return {
    buildBootstrapPayload,
    buildConfiguredModelOptions,
  };
}
