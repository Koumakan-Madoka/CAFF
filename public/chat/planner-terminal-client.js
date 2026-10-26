// @ts-check
(function registerPlannerTerminalClient() {
  const chat = window.CaffChat || (window.CaffChat = {});

  /** Live transport only: no retry, history buffer, transcript storage or input queue. @param {any} options */
  chat.createPlannerTerminalClient = function createPlannerTerminalClient(options) {
    const screen = options.screen;
    const TerminalCtor = options.TerminalCtor || window.Terminal;
    const FitAddonCtor = options.FitAddonCtor || window.FitAddon?.FitAddon;
    const SocketCtor = options.SocketCtor || window.WebSocket;
    const ResizeObserverCtor = options.ResizeObserverCtor || window.ResizeObserver;
    const encoder = new TextEncoder();
    let generation = 0, attached = false, readable = false, outputBytes = 0;
    let socket = null, terminal = null, addon = null, observer = null, themeObserver = null;
    let subscriptions = [];

    function status(state, code = '') { options.onState?.(state, code); }
    function dispose() {
      generation++; attached = readable = false;
      observer?.disconnect(); themeObserver?.disconnect(); observer = themeObserver = null;
      for (const subscription of subscriptions) subscription.dispose();
      subscriptions = [];
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close(1000, 'Terminal detached'); socket = null;
      }
      terminal?.dispose(); terminal = addon = null; outputBytes = 0;
      screen.replaceChildren();
    }
    function fail(code) {
      attached = readable = false;
      if (terminal) terminal.options.disableStdin = true;
      status('unavailable', code);
      // Browser close() permits only 1000 or application codes 3000..4999.
      // Policy codes such as 1008 are server-side only; retain the UI reason.
      socket?.close(1000, 'Terminal unavailable');
    }
    function send(message) {
      if (!socket || socket.readyState !== 1) return;
      const data = JSON.stringify(message);
      if (socket.bufferedAmount + encoder.encode(data).length > 1024 * 1024) return fail('planner_terminal_slow_consumer');
      socket.send(data);
    }
    function fit() {
      if (!terminal || !addon) return;
      const size = addon.proposeDimensions();
      if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
        terminal.resize(Math.max(20, Math.min(500, Math.floor(size.cols))), Math.max(5, Math.min(300, Math.floor(size.rows))));
      }
      if (attached) send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
    }
    function theme() {
      if (!terminal) return;
      const style = getComputedStyle(document.documentElement);
      const background = style.getPropertyValue('--caff-surface-sunk').trim() || '#111312';
      const foreground = style.getPropertyValue('--caff-text').trim() || '#f0f1ed';
      terminal.options.theme = { background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: '#57759066' };
    }
    function connect(roomId, token) {
      dispose();
      const current = generation;
      if (!TerminalCtor || !FitAddonCtor || !SocketCtor) return status('unavailable', 'planner_terminal_assets_unavailable');
      terminal = new TerminalCtor({ cols: 120, rows: 30, fontSize: 13, fontFamily: 'Consolas, "Liberation Mono", monospace',
        scrollback: 2000, disableStdin: true, allowProposedApi: false, allowTransparency: false,
        // Do not install web-links/clipboard addons or permit OSC hyperlink activation.
        linkHandler: { activate() {} }, windowOptions: {} });
      addon = new FitAddonCtor(); terminal.loadAddon(addon); terminal.open(screen); theme();
      for (const id of [8, 52]) subscriptions.push(terminal.parser.registerOscHandler(id, () => true));
      subscriptions.push(terminal.onData(data => {
        if (current !== generation || !attached) return;
        // 8 KiB also bounds a complete JSON frame under worst-case 6x escaping.
        let chunk = '', bytes = 0;
        for (const char of data) {
          const n = encoder.encode(char).length;
          if (bytes + n > 8192) { send({ type: 'input', data: chunk }); chunk = ''; bytes = 0; }
          chunk += char; bytes += n;
        }
        if (chunk) send({ type: 'input', data: chunk });
      }));
      terminal.attachCustomKeyEventHandler?.(event => {
        if (event.ctrlKey && event.shiftKey && event.key === 'F6') {
          options.focusToolbar?.(); return false;
        }
        return true;
      });
      fit();
      observer = new ResizeObserverCtor(() => { if (current === generation) fit(); }); observer.observe(screen);
      themeObserver = new MutationObserver(() => { if (current === generation) theme(); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      const url = new URL(`/api/conversations/${encodeURIComponent(roomId)}/planner/terminal`, window.location.href);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new SocketCtor(url.href);
      const owned = socket;
      status('connecting');
      owned.onopen = () => {
        if (current !== generation) return;
        status('authenticating');
        send({ type: 'auth', version: 1, token, cols: terminal.cols, rows: terminal.rows });
      };
      owned.onmessage = event => {
        if (current !== generation) return;
        try {
          if (typeof event.data !== 'string' || encoder.encode(event.data).length > 65536) throw new Error();
          const message = JSON.parse(event.data);
          if (message.type === 'ready' && !readable && message.version === 1 && message.historyReplay === false) {
            attached = readable = true; terminal.options.disableStdin = false; status('attached'); options.onReady?.(message); fit();
            // User focus stays on controls until the user enters the terminal.
          } else if (message.type === 'output' && readable && typeof message.data === 'string' && encoder.encode(message.data).length <= 16384) {
            const bytes = encoder.encode(message.data).length; outputBytes += bytes;
            if (outputBytes > 1024 * 1024) return fail('planner_terminal_slow_consumer');
            terminal.write(message.data, () => { if (current === generation) outputBytes -= bytes; });
          } else if (message.type === 'exit') {
            attached = readable = false; terminal.options.disableStdin = true; status('exited', message.reasonCode); options.onExit?.(message);
          } else if (message.type === 'error') fail(message.code);
          else if (message.type === 'attention') options.onAttention?.(message);
          else if (message.type !== 'state') throw new Error();
        } catch { fail('planner_terminal_message_invalid'); }
      };
      owned.onerror = () => { if (current === generation) status('disconnected', 'planner_terminal_connection_failed'); };
      owned.onclose = () => {
        if (current !== generation) return;
        attached = readable = false; if (terminal) terminal.options.disableStdin = true;
        status('disconnected');
      };
    }
    return { connect, dispose, fit, terminate() {
      if (!attached) return;
      send({ type: 'terminate' }); attached = false; terminal.options.disableStdin = true; status('stopping');
    } };
  };
})();
