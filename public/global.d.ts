export {};

declare global {
  type CaffFetchJsonOptions = {
    method?: string;
    body?: unknown;
  };

  type CaffToastController = {
    hide: () => void;
    show: (message: string) => void;
  };

  type CaffModelOption = {
    key: string;
    provider: string;
    model: string;
    label: string;
    sourceLabel?: string;
  };

  type CaffModelOptionUtils = {
    buildModelOptionLabel: (option: CaffModelOption | null) => string;
    fillModelSelect: (
      select: HTMLSelectElement | null,
      modelOptions: CaffModelOption[] | unknown,
      currentProvider?: string,
      currentModel?: string
    ) => void;
    modelOptionKey: (provider: string, model: string) => string;
    selectedModelOption: (select: HTMLSelectElement | null, modelOptions: CaffModelOption[] | unknown) => CaffModelOption | null;
    syncProviderFromModelSelect: (
      select: HTMLSelectElement | null,
      providerInput: HTMLInputElement | null,
      modelOptions: CaffModelOption[] | unknown
    ) => void;
  };

  type CaffAvatarUtils = {
    avatarInitial: (name: string) => string;
    buildAgentAvatarElement: (agent: unknown, className?: string) => HTMLElement;
    readAvatarFileAsDataUrl: (file: File | null | undefined) => Promise<string>;
    renderAvatarPreview: (
      container: HTMLElement | null,
      dataUrl: string,
      name: string,
      accentColor?: string
    ) => void;
  };

  type CaffShared = {
    fetchJson: <T = unknown>(url: string, options?: CaffFetchJsonOptions) => Promise<T>;
    modelOptions: CaffModelOptionUtils;
    avatar: CaffAvatarUtils;
    createToastController: (element: HTMLElement | null, delayMs?: number) => CaffToastController;
  };

  type CaffChat = {
    createConversationListRenderer?: (args: unknown) => { render: () => void };
    createParticipantPaneRenderer?: (args: unknown) => { render: (conversation: unknown) => void };
    createMessageTimelineRenderer?: (args: unknown) => { render: (conversation: unknown, activeTurn: unknown) => void };
    createConversationSettingsController?: (args: unknown) => {
      bindEvents: () => void;
      closeAllProfileMenus: () => void;
      render: () => void;
      selectedModelProfileName: (agent: unknown) => string;
      selectedParticipants: () => unknown[];
      setProfileSelectorDisabled: (...args: unknown[]) => void;
      setProfileSelectorValue: (...args: unknown[]) => void;
      toggleProfileSelector: (...args: unknown[]) => void;
    };
    createUndercoverPanelRenderer?: (args: unknown) => { render: () => void };
    createConversationPaneRenderer?: (args: unknown) => { render: () => void };
    createMentionMenuController?: (args: unknown) => {
      appendHighlightedMessageBody: (container: HTMLElement, text: string, agents: unknown[]) => void;
      bindEvents: () => void;
      closeMenu: () => void;
      syncMenu: () => void;
    };
  };

  interface Window {
    CaffChat?: any;
    CaffShared?: any;
  }
}
