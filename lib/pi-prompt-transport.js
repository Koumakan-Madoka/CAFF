function getPiPromptStdio() {
  return /** @type {['pipe', 'pipe', 'pipe']} */ (['pipe', 'pipe', 'pipe']);
}

function writePiPromptToStdin(child, prompt) {
  if (!child || !child.stdin) {
    return;
  }

  child.stdin.on('error', () => {});
  child.stdin.end(String(prompt || ''));
}

module.exports = {
  getPiPromptStdio,
  writePiPromptToStdin,
};
