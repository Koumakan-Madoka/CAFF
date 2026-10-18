// CONTAINER ONLY, fixed synthetic diagnostic. No SDK/model/captured program.
// Stage trusted CAFF build and matching Linux npm/native dependencies at /work.
// Missing dependencies FAIL; never npm-install or substitute a bridge/store.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const failed = () => Error('evaluation_bridge_diagnostic_failed');
async function runContainerBridgeDiagnostic() {
  let a, b;
  try {
    // Check BEFORE importing any CAFF module, opening SQLite or spawning a child.
    if (process.platform !== 'linux' || process.getuid?.() !== 65534 || process.cwd() !== '/work'
      || !fs.existsSync('/.dockerenv') || Object.keys(process.env).some(k => /^(CAFF_|PI_|OPENAI_|ANTHROPIC_|AWS_|NODE_OPTIONS$|NODE_PATH$)/.test(k))) throw failed();
    const { startEvaluationCallback } = require('/work/build/server/domain/runtime/badcase-capture/evaluation-callback');
    const { createChatAppStore } = require('/work/build/lib/chat-app-store');
    const seed = { conversationId: 'eval-conversation', turnId: 'eval-turn', agent: { id: 'eval-agent', name: 'Evaluation Agent' },
      userMessage: { id: 'eval-user', content: 'Synthetic container bridge context.' }, assistantMessageId: 'eval-assistant' };
    a = await startEvaluationCallback({ directory: '/work/evaluation-callback-a', seed, lifetimeMs: 20000 });
    b = await startEvaluationCallback({ directory: '/work/evaluation-callback-b', seed, lifetimeMs: 20000 });
    async function cli(service, args) {
      // Fixed installed CLI only, not caller/capsule selected. Auth is in fresh
      // child env, never argv, receipt, persistent file or Docker Config.Env.
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp',
        CAFF_CHAT_API_URL: service.apiUrl, CAFF_CHAT_INVOCATION_ID: service.credentials.invocationId,
        CAFF_CHAT_CALLBACK_TOKEN: service.credentials.callbackToken };
      const result = await new Promise((resolve, reject) => {
        let child, timer, bytes = 0, invalid = false;
        const stdout = [], stderr = [];
        try { child = spawn(process.execPath, ['/work/build/lib/agent-chat-tools.js', ...args], {
          cwd: '/work', env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch { reject(failed()); return; }
        const kill = () => { invalid = true; child.kill('SIGKILL'); };
        timer = setTimeout(kill, 3000);
        for (const [stream, chunks] of [['stdout', stdout], ['stderr', stderr]]) child[stream].on('data', chunk => {
          bytes += chunk.length; if (bytes > 65536) { kill(); return; } chunks.push(chunk);
        });
        child.on('error', () => { invalid = true; });
        // Join close even after timeout/error; don't close SQLite underneath an
        // owned child still sending HTTP. Outer Docker supervisor is the hard
        // process-tree deadline, NOT this direct-child observation timeout.
        child.on('close', code => { clearTimeout(timer); if (invalid || code !== 0 || stderr.length) reject(failed());
          else resolve(Buffer.concat(stdout).toString('utf8')); });
      });
      try { return JSON.parse(result); } catch { throw failed(); }
    }
    const context = await cli(a, ['read-context']);
    if (context.latestUserMessage?.id !== seed.userMessage.id || context.latestUserMessage?.content !== seed.userMessage.content) throw failed();
    const participants = await cli(a, ['list-participants']);
    if (participants.participants?.length !== 1 || participants.participants[0].id !== seed.agent.id) throw failed();
    const url = new URL(b.apiUrl + '/api/agent-tools/context');
    for (const [key, value] of Object.entries(a.credentials)) url.searchParams.set(key, value);
    const cross = await fetch(url, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(3000) });
    if (cross.status !== 401) throw failed(); await cross.arrayBuffer();
    const content = 'Synthetic container public result.';
    const sent = await cli(a, ['send-public', '--content', content, '--no-finalize']);
    if (sent.message?.id !== seed.assistantMessageId) throw failed();
    const after = await cli(a, ['read-context']), other = await cli(b, ['read-context']);
    if (after.publicMessages?.find(m => m.id === seed.assistantMessageId)?.content !== content
      || other.publicMessages?.some(m => m.content === content)) throw failed();
    await a.stop(); await b.stop();
    for (const service of [a, b]) {
      let refused = false;
      try { const response = await fetch(service.apiUrl, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(3000) });
        await response.arrayBuffer(); } catch (e) { refused = e?.cause?.code === 'ECONNREFUSED'; }
      // A timeout/abort/DNS error is NOT evidence that the listener is closed.
      if (!refused) throw failed();
    }
    const store = createChatAppStore({ agentDir: '/work/evaluation-callback-a', sqlitePath: a.databasePath });
    try { if (store.getMessage(seed.assistantMessageId)?.content !== content) throw failed(); } finally { store.close(); }
    return { kind: 'container-evaluation-bridge-diagnostic-v1', instances: 2, cliCalls: 5, crossAuthDenied: true,
      contextVerified: true, participantsVerified: true, publicMessagePersisted: true, callbackClosed: true,
      modelCalls: 0, piExecuted: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false };
  } catch { throw failed(); }
  finally {
    // If second startup/any CLI fails, still stop all successfully owned servers.
    // Cleanup failure is failure too; no success receipt before both stores close.
    const results = await Promise.allSettled([a, b].filter(Boolean).map(s => s.stop()));
    if (results.some(r => r.status === 'rejected')) throw failed();
  }
}
if (require.main === module) runContainerBridgeDiagnostic().then(r => console.log(JSON.stringify(r))).catch(() => {
  process.stderr.write('evaluation_bridge_diagnostic_failed\n'); process.exitCode = 1;
});
module.exports = { runContainerBridgeDiagnostic };
