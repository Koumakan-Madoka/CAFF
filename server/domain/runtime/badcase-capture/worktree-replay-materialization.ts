// Internal STATIC working-copy staging. Never imports the SDK, executes captured
// files, injects credentials or grants launch permission. Container destination is
// /work/restored; owned temporary destinations are only for static filesystem tests.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareWorktreeReplayInputs } from './worktree-replay-inputs';
import { materializeModePreservingReplayCapsule } from './capsule-materialization';
const hash = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const fail = (code = 'replay_working_copy_write_failed') => Object.assign(Error(code), { code });

// Pure expectation only. Both variants must consume the same declaration; this
// step does not choose roles, reinterpret full config or validate SDK semantics.
export function planWorktreeReplayMaterialization(capsule: any, expected: any, declaration: any) {
  const input = prepareWorktreeReplayInputs(capsule, expected, declaration);
  if (!input.runConfig || typeof input.runConfig !== 'object' || Array.isArray(input.runConfig)
    || !Array.isArray(input.controlledReplacements)) throw fail('replay_working_copy_inputs_invalid');
  const files: { path: string; bytes: Buffer }[] = [];
  const add = (name: string, text: string) => files.push({ path: name, bytes: Buffer.from(text) });
  add('prompt.txt', input.invocation);
  if (input.sessionText !== null) add('session.jsonl', input.sessionText);
  add('run-config.json', JSON.stringify(input.runConfig));
  add('harness.json', JSON.stringify(input.harness));
  add('skill-snapshots.json', JSON.stringify(input.skillSnapshots));
  add('controlled-replacements.json', JSON.stringify(input.controlledReplacements));
  add('declaration.json', JSON.stringify(declaration));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, expectedReceipt: { ...input.receipt, kind: 'worktree-replay-materialization-v1',
    workingInputHash: hash(JSON.stringify(files.map(f => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes) })))),
    workingInputCount: files.length, fileModePreserved: true } };
}

export function materializeWorktreeReplayInputs(capsule: any, expected: any, declaration: any, destination: string) {
  const plan = planWorktreeReplayMaterialization(capsule, expected, declaration); // ALL validation before writes
  if (process.platform !== 'linux') throw fail('replay_working_copy_platform_unsupported');
  // Original materials and snapshot remain distinct from transformed inputs.
  // This owns the exclusive new destination; never reuse or overwrite a variant.
  const restored = materializeModePreservingReplayCapsule(capsule, expected, destination);
  if (restored.materializedHash !== plan.expectedReceipt.materializedHash
    || restored.modeInventoryHash !== plan.expectedReceipt.modeInventoryHash || restored.fileModePreserved !== true) throw fail();
  const directory = path.join(destination, 'working-inputs');
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const file of plan.files) {
    const fd = fs.openSync(path.join(directory, file.path), fs.constants.O_CREAT | fs.constants.O_EXCL
      | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, file.bytes);
      fs.fchmodSync(fd, 0o600);
      const observed = fs.fstatSync(fd);
      if (!observed.isFile() || observed.size !== file.bytes.length || (observed.mode & 0o7777) !== 0o600) throw fail();
      // Positional read starts at zero, not the descriptor's post-write cursor.
      // Extra byte detects growth, bounded by already validated capsule inputs.
      const bytes = Buffer.alloc(file.bytes.length + 1); let offset = 0;
      while (offset < bytes.length) {
        const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!n) break;
        offset += n;
      }
      if (offset !== file.bytes.length || !bytes.subarray(0, offset).equals(file.bytes)) throw fail();
    } finally { fs.closeSync(fd); }
  }
  // No success on write/read/chmod/close failure; may leave a NEW partial copy.
  // No rollback, cleanup, fsync/power-loss guarantee, unpin or execution claim.
  return plan.expectedReceipt;
}
