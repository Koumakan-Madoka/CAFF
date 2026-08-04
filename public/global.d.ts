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
    source?: 'runtime' | 'models_json';
    sourceLabel?: string;
    family?: 'gpt' | 'claude' | 'gemini' | 'deepseek' | 'qwen' | 'glm' | 'kimi' | null;
    familySource?: 'explicit' | 'provider_alias' | 'model_alias' | 'unknown' | 'conflict';
    supportedThinkingLevels?: Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
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

  type CaffSafeMarkdown = {
    render: (
      container: HTMLElement | null,
      source: string,
      options?: { appendText?: (container: HTMLElement, text: string) => void }
    ) => void;
  };

  type CaffShared = {
    fetchJson: <T = unknown>(url: string, options?: CaffFetchJsonOptions) => Promise<T>;
    modelOptions: CaffModelOptionUtils;
    avatar: CaffAvatarUtils;
    createToastController: (element: HTMLElement | null, delayMs?: number) => CaffToastController;
    copyTextToClipboard?: (text: string) => Promise<void>;
    safeMarkdown?: CaffSafeMarkdown;
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

  type CaffShellChangePayload = {
    open: boolean;
    tab: string;
  };

  type CaffAppShell = {
    openTab: (panelId: string) => void;
    releaseTab: (panelId: string) => void;
    closeDrawer: () => void;
    isDrawerOpen: () => boolean;
    activeTab: () => string;
    onChange: (cb: (payload: CaffShellChangePayload) => void) => () => void;
    setTabVisible: (panelId: string, visible: boolean, options?: { count?: number }) => void;
    scrollToBottom: (smooth?: boolean) => void;
    syncComposerHeight: () => void;
    setComposerValue: (value: unknown) => void;
  };

  type CaffThemeController = {
    getTheme: () => 'light' | 'dark';
    hasExplicitPreference: () => boolean;
    setTheme: (theme: 'light' | 'dark') => 'light' | 'dark';
    toggle: () => 'light' | 'dark';
    syncControls: () => void;
  };

  type CaffIconController = {
    create: (name: string, options?: { className?: string }) => SVGSVGElement;
  };

  interface Window {
    CaffChat?: any;
    CaffPersonas?: any;
    CaffShared?: any;
    CaffTheme?: CaffThemeController;
    CaffIcons?: CaffIconController;
    caffShell?: CaffAppShell;
  }

  interface HTMLElement {
    inert: boolean;
  }
}
