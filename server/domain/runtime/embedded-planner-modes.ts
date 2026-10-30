// Ephemeral DEC private-mode state only: no screen, transcript or raw-output
// buffer. A fresh xterm gets only these CAFF-generated sequences on reattach.
const MODES = [1049, 1, 25, 47, 1047, 1000, 1002, 1003, 1006, 1015, 1004, 2004, 2031, 9001];
const ALLOWED = new Set(MODES);
export function createTerminalModeTracker() {
  const modes = new Map<number, boolean>();
  let state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' | 'ignore-escape' = 'text';
  let csi = '', overflow = false, osc = false;
  function beginCsi() { state = 'csi'; csi = ''; overflow = false; }
  function finish(final: string) {
    if (overflow) return;
    if (csi === '!' && final === 'p') { modes.clear(); return; }
    if ((final !== 'h' && final !== 'l') || !/^\?\d*(;\d*)*$/.test(csi)) return;
    for (const parameter of csi.slice(1).split(';')) {
      const mode = Number(parameter);
      if (ALLOWED.has(mode)) modes.set(mode, final === 'h');
    }
  }
  function feed(data: string) {
    for (const char of data) {
      // CAN/SUB cancel escape/control strings. Strings ignore all embedded CSI
      // and RIS bytes (OSC title, DCS payload, etc. must not spoof modes).
      if (char === '\x18' || char === '\x1a') { state = 'text'; csi = ''; continue; }
      if (state === 'string' || state === 'string-escape') {
        if (char === '\x9c' || (osc && char === '\x07') || (state === 'string-escape' && char === '\\')) state = 'text';
        else state = char === '\x1b' ? 'string-escape' : 'string';
        continue;
      }
      if (char === '\x1b') { state = 'escape'; csi = ''; continue; }
      if (char === '\x9b') { beginCsi(); continue; }
      if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(char)) { state = 'string'; osc = char === '\x9d'; continue; }
      if (state === 'escape') {
        if (char === '[') beginCsi();
        else if (']PX^_'.includes(char)) { state = 'string'; osc = char === ']'; }
        else if (char === 'c') { modes.clear(); state = 'text'; }
        else if (char >= ' ' && char <= '/') state = 'ignore-escape';
        else if (char >= '0') state = 'text';
      } else if (state === 'ignore-escape') {
        if (char >= '0') state = 'text';
      } else if (state === 'csi') {
        if (char >= '@' && char <= '~') { finish(char); state = 'text'; csi = ''; }
        else if (char >= ' ' && char <= '?') {
          if (csi.length < 128 && !overflow) csi += char;
          else { overflow = true; csi = ''; }
        } else if (char >= '\x80') { state = 'text'; csi = ''; }
      }
    }
  }
  return { feed, restore: () => MODES.filter(mode => modes.has(mode)).map(mode => `\x1b[?${mode}${modes.get(mode) ? 'h' : 'l'}`).join('') };
}
export type TerminalModeTracker = ReturnType<typeof createTerminalModeTracker>;
