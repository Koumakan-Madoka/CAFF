// Pure bridge from a retained capsule to a production SDK start descriptor.
// NO filesystem reads, SDK imports, authorizing, model/network or execution.
// Requires a FULL captured IPC config. Legacy version/model summaries are not
// converted to defaults. External agent/config/skill roots remain unsupported.
import crypto from 'node:crypto';
import { prepareWorktreeReplayInputs } from './worktree-replay-inputs';
import { planModePreservingReplayCapsule } from './capsule-materialization';
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const fail = (code = 'replay_sdk_config_invalid') => Object.assign(Error(code), { code });
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: any, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const text = (v: any) => typeof v === 'string' && v.length > 0 && v.trim() === v && !v.includes('\0');
const CONFIG_KEYS = ['provider', 'model', 'thinking', 'agentDir', 'sessionPath', 'resume', 'cwd', 'heartbeatIntervalMs',
  'extensionPaths', 'additionalSkillPaths', 'retireUserScopeSkills'];
const DESTINATION = '/work/restored/snapshot';
export function planRetainedCaffStart(capsule: string, expected: any, worktreeDeclaration: any, declaration: any) {
  const input = prepareWorktreeReplayInputs(capsule, expected, worktreeDeclaration);
  const material = planModePreservingReplayCapsule(capsule, expected);
  const cp = JSON.parse(material.files.find(f => f.path === 'materials/checkpoint.json')!.bytes.toString('utf8'));
  const source = input.harness.sdkStartConfig;
  if (source === undefined) throw fail('replay_sdk_config_missing');
  if (!exact(source, CONFIG_KEYS) || !text(source.provider) || !text(source.model)
    || typeof source.thinking !== 'string' || !['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(source.thinking)
    || source.provider !== input.runConfig.provider || source.model !== input.runConfig.model
    || input.harness.agentPromptVersion !== input.runConfig.promptVersion
    || !['0.85.1', 'pi:0.85.1'].includes(input.harness.piVersion)
    || source.cwd !== worktreeDeclaration.sourceRoot || source.resume !== (input.deliveryMode === 'resume')
    || !text(source.agentDir) || typeof source.sessionPath !== 'string'
    || (source.resume ? !text(source.sessionPath) : source.sessionPath !== '')
    || !Number.isSafeInteger(source.heartbeatIntervalMs) || source.heartbeatIntervalMs < 0
    || typeof source.retireUserScopeSkills !== 'boolean'
    || !['extensionPaths', 'additionalSkillPaths'].every(k => Array.isArray(source[k]) && source[k].length <= 256
      && source[k].every(text) && new Set(source[k]).size === source[k].length)) throw fail();
  if (!exact(declaration, ['schemaVersion', 'sdkConfigHash', 'bindings']) || declaration.schemaVersion !== 1
    || declaration.sdkConfigHash !== hash(JSON.stringify(source)) || !Array.isArray(declaration.bindings)
    || declaration.bindings.length > 515) throw fail('replay_sdk_bindings_invalid');
  const config = structuredClone(source), seen = new Set<string>();
  const root = worktreeDeclaration.sourceRoot, separator = worktreeDeclaration.sourcePlatform === 'win32' ? root[2] : '/';
  // Exact lexical spelling, including Windows case. Never resolve/discover a
  // path on this host. Every mapped directory must have archived descendants.
  const mapWorktree = (value: string) => {
    if (value !== root && !value.startsWith(root + separator)) throw fail('replay_sdk_external_dependency');
    const suffix = value.slice(root.length).split(separator).join('/');
    if (suffix && (!/^\/[A-Za-z0-9_.@\-/]+$/.test(suffix)
      || suffix.slice(1).split('/').some((p: string) => !p || p === '.' || p === '..' || p.length > 255))) throw fail();
    const relative = suffix.slice(1);
    if (relative && !Object.keys(cp.files).some(p => p === relative || p.startsWith(relative + '/'))) throw fail('replay_sdk_dependency_missing');
    return DESTINATION + suffix;
  };
  const required = new Map<string, string>([['/cwd', source.cwd], ['/agentDir', source.agentDir]]);
  if (source.resume) required.set('/sessionPath', source.sessionPath);
  for (const key of ['extensionPaths', 'additionalSkillPaths']) source[key].forEach((v: string, i: number) => required.set(`/${key}/${i}`, v));
  for (const b of declaration.bindings) {
    if (!exact(b, ['pointer', 'sourcePath', 'targetPath']) || !required.has(b.pointer) || seen.has(b.pointer)
      || b.sourcePath !== required.get(b.pointer)) throw fail('replay_sdk_bindings_invalid');
    const lexical = b.sourcePath.replaceAll('\\', '/');
    const components = worktreeDeclaration.sourcePlatform === 'win32'
      ? (/^[A-Za-z]:\//.test(lexical) ? lexical.slice(3) : '') : (lexical.startsWith('/') ? lexical.slice(1) : '');
    if (!components || components.split('/').some((p: string) => !p || p === '.' || p === '..'
      || p.length > 255 || !/^[A-Za-z0-9_.@ -]+$/.test(p) || p.trim() !== p)) throw fail('replay_sdk_bindings_invalid');
    let target: string;
    if (b.pointer === '/sessionPath') target = '/work/restored/working-inputs/session.jsonl';
    else if (b.pointer.startsWith('/extensionPaths/')) {
      // Only this explicitly selected installed CAFF extension may substitute
      // for an external distribution path. Other extensions must be archived.
      const installed = '/work/build/lib/pi-extensions/caff-capabilities.mjs';
      if (b.targetPath === installed) {
        if (!lexical.endsWith('/lib/pi-extensions/caff-capabilities.mjs')) throw fail('replay_sdk_bindings_invalid');
        target = installed;
      } else target = mapWorktree(b.sourcePath);
    } else target = mapWorktree(b.sourcePath);
    if (b.targetPath !== target) throw fail('replay_sdk_bindings_invalid');
    const array = /^\/(extensionPaths|additionalSkillPaths)\/(\d+)$/.exec(b.pointer);
    if (array) config[array[1]][Number(array[2])] = target;
    else config[b.pointer.slice(1)] = target;
    seen.add(b.pointer);
  }
  if (seen.size !== required.size || ['extensionPaths', 'additionalSkillPaths'].some(k => new Set(config[k]).size !== config[k].length)) {
    throw fail('replay_sdk_bindings_invalid');
  }
  if (config.agentDir === DESTINATION) throw fail('replay_sdk_agent_directory_invalid');
  const agentRelative = config.agentDir.slice(DESTINATION.length + 1);
  // Never create a synthetic SYSTEM/settings to make an incomplete archive
  // look executable. Other external inputs still require future archival.
  if (!cp.files[agentRelative + '/settings.json'] || !cp.files[agentRelative + '/SYSTEM.md']) throw fail('replay_sdk_dependency_missing');
  if (Object.keys(cp.files).some(p => p.toLowerCase() === (agentRelative + '/auth.json').toLowerCase())) throw fail('replay_sdk_auth_forbidden');
  return { config, invocation: input.invocation, sessionText: input.sessionText,
    archivedHarness: structuredClone(input.harness), skillSnapshots: input.skillSnapshots,
    controlledReplacements: input.controlledReplacements,
    receipt: { kind: 'retained-caff-start-plan-v1', deliveryMode: input.deliveryMode,
      capsuleHash: expected.capsuleHash, checkpointChecksum: expected.checkpointChecksum,
      sdkConfigHash: declaration.sdkConfigHash, effectiveConfigHash: hash(JSON.stringify(config)),
      runtimeBindingsHash: hash(JSON.stringify(declaration)), worktreeDeclarationHash: input.receipt.declarationHash,
      invocationHash: input.receipt.invocationHash, sessionHash: input.receipt.sessionHash,
      sdkInitialized: false, invocationSubmitted: false, launchAuthorized: false,
      runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false } };
}
