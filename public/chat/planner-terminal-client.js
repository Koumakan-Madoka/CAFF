// @ts-check
(function registerPlannerTerminalClient() {
  const chat = window.CaffChat || (window.CaffChat = {});

  /** Live transport only: no retry, history buffer, transcript storage or input queue. @param {any} options */
  chat.createPlannerTerminalClient = function createPlannerTerminalClient(options) {
    const screen = options.screen;
    const TerminalCtor = options.TerminalCtor || window.Terminal;
    const FitAddonCtor = options.FitAddonCtor || window.FitAddon?.FitAddon;
    const UnicodeAddonCtor = options.UnicodeGraphemesAddonCtor || window.UnicodeGraphemesAddon?.UnicodeGraphemesAddon;
    const SocketCtor = options.SocketCtor || window.WebSocket;
    const ResizeObserverCtor = options.ResizeObserverCtor || window.ResizeObserver;
    const encoder = new TextEncoder();
    let generation = 0, attached = false, readable = false, outputBytes = 0, copying = 0;
    let socket = null, terminal = null, addon = null, observer = null;
    let subscriptions = [];

    function status(state, code = '') { options.onState?.(state, code); }
    function dispose() {
      generation++; attached = readable = false; copying = 0;
      observer?.disconnect(); observer = null;
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
      // Claude Code's default ANSI palette expects a dark background. CAFF's
      // chrome may switch themes, but must not recolor CLI output or its settings.
      const style = getComputedStyle(screen);
      const background = style.getPropertyValue('--planner-terminal-background').trim() || '#111312';
      const foreground = style.getPropertyValue('--planner-terminal-foreground').trim() || '#f0f1ed';
      return { background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: '#57759066', brightBlack: '#9a9a9a' };
    }
    async function copySelection() {
      const owned = terminal, current = generation;
      copying++;
      try {
        // User keydown only, never CLI/OSC output. Use the shared write-only helper.
        await window.CaffShared.copyTextToClipboard(owned.getSelection());
        if (current === generation) owned.clearSelection();
      } catch {
        if (current === generation) {
          const selection = owned.getSelectionPosition(), cols = owned.cols;
          options.onNotice?.('复制失败，请重试；选区已保留。');
          // The notice changes available height; xterm clears selection on row
          // resize. Fit synchronously and restore before ResizeObserver runs.
          fit();
          if (selection && owned.cols === cols) owned.select(selection.start.x, selection.start.y,
            (selection.end.y - selection.start.y) * cols + selection.end.x - selection.start.x);
        }
      } finally {
        // The helper's textarea fallback can steal focus; never focus a stale view.
        if (current === generation) { owned.focus(); copying--; }
      }
    }
    function connect(roomId, token) {
      dispose();
      const current = generation;
      if (!TerminalCtor || !FitAddonCtor || !SocketCtor) return status('unavailable', 'planner_terminal_assets_unavailable');
      if (!UnicodeAddonCtor) return status('unavailable', 'planner_terminal_unicode_unavailable');
      terminal = new TerminalCtor({ cols: 120, rows: 30, fontSize: 13, fontFamily: 'Consolas, "Liberation Mono", monospace',
        scrollback: 2000, disableStdin: true, allowProposedApi: true, allowTransparency: false, theme: theme(),
        // Do not install web-links/clipboard addons or permit OSC hyperlink activation.
        linkHandler: { activate() {} }, windowOptions: {} });
      addon = new FitAddonCtor(); terminal.loadAddon(addon); terminal.open(screen);
      try {
        // Unicode's proposed API is required by the pinned grapheme addon only.
        // No extra output capabilities; OSC 8/52 remain intercepted below.
        terminal.loadAddon(new UnicodeAddonCtor());
        if (terminal.unicode.activeVersion !== '15-graphemes') throw new Error();
      } catch {
        dispose(); return status('unavailable', 'planner_terminal_unicode_unavailable');
      }
      for (const id of [8, 52]) subscriptions.push(terminal.parser.registerOscHandler(id, () => true));
      subscriptions.push(terminal.onData(data => {
        if (current !== generation || !attached) return;
        // Clipboard fallback focus changes are UI-only, not CLI input.
        if (copying && (data === '\x1b[I' || data === '\x1b[O')) return;
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
        if (event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
          && event.key.toLowerCase() === 'v') {
          // Skip xterm's ^V conversion without cancelling the browser's native
          // paste event; xterm already handles its text and bracketed-paste mode.
          return false;
        }
        if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey
          && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
          event.preventDefault();
          void copySelection();
          return false; // Even failed copies must not become a CLI interrupt.
        }
        if (event.ctrlKey && event.shiftKey && event.key === 'F6') {
          options.focusToolbar?.(); return false;
        }
        return true;
      });
      fit();
      observer = new ResizeObserverCtor(() => { if (current === generation) fit(); }); observer.observe(screen);
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
