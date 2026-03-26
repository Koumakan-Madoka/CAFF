export function getPiPromptStdio() {
  return ['pipe', 'pipe', 'pipe'] as const;
}

export function writePiPromptToStdin(child, prompt) {
  if (!child || !child.stdin) {
    return;
  }

  child.stdin.on('error', () => {});
  child.stdin.end(String(prompt || ''));
}
