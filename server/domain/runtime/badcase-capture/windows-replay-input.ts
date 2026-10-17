// Internal memory-only Windows input preparation. No management/turn/enable
// wiring, publication, re-pin or fallback. A complete replayInput covers only
// the dimensions validated by the existing validator, NOT the whole checkpoint.
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readWindowsSessionInput } from './windows-session-input';
import { prepareReplayInput } from './replay-input-preparation';

export async function prepareWindowsReplayInput(options: any = {}): Promise<any> {
  const fail = (reason: string) => ({ ok: false, reason });
  if (process.platform !== 'win32') return fail('windows_required');
  const deadline = performance.now() + 25000;
  const expired = () => performance.now() >= deadline;
  try {
    // Latch plain runtime materials before await. A caller changing the live
    // invocation while the reader waits cannot re-associate old session bytes.
    const input = structuredClone(options.input), authorizedRoot = options.authorizedRoot;
    if (!input || (input.deliveryMode !== 'fresh' && input.deliveryMode !== 'resume')
        || typeof authorizedRoot !== 'string' || !/^[a-z]:[\\/]/i.test(authorizedRoot)
        || !path.win32.isAbsolute(authorizedRoot)) return fail('replay_input_invalid');
    const mode = input.deliveryMode, sessionPath = String(input.sessionPath || '').trim();
    let access: any;
    if (expired()) return fail('replay_input_timeout');
    if (mode === 'resume' && sessionPath) {
      try {
        access = await readWindowsSessionInput({ inputPath: sessionPath, captureRoot: options.captureRoot,
          policy: options.policy, privateDirs: options.privateDirs });
      } catch { access = { ok: false, reason: 'session_input_unavailable' }; }
    }
    // Do not consume late content, and never switch deliveryMode to fresh.
    if (expired()) return fail('replay_input_timeout');
    const result = prepareReplayInput(input, mode, authorizedRoot, () => access);
    if (expired()) return fail('replay_input_timeout');
    return { ok: true, ...result };
  } catch { return fail('replay_input_unavailable'); }
}
