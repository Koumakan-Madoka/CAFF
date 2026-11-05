// Offline Docker execution primitive. Trusted internal callers only, NOT a replay launcher.
// No HTTP/model/credential/callback configuration. See contract §4.1.
import { containsSecretSentinel } from './secrets';
import { isSafeRelativePath, isSafeDistributionPath } from './replay-path';
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const LABEL = 'caff.badcase.offline';
const LIMIT = 16 * 1024 * 1024;
const OUTPUT = 1024 * 1024;
const WORK = 'rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700';
const TMP = 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=65534,mode=0700';
let active = 0;
const hash = (b: any) => crypto.createHash('sha256').update(b).digest('hex');
const failure = (code: string) => Object.assign(new Error(code), { code });
function exact(v: any, keys: string[]) {
  return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
}
function relative(v: any): boolean {
  return isSafeDistributionPath(v) && v.length <= 1024 && v.split('/').every(p => p.length <= 255);
}

export function prepareOfflineTask(input: any) {
  const bad = () => { throw failure('offline_input_invalid'); };
  if (!exact(input, ['image', 'entrypoint', 'files', 'timeoutMs'])) bad();
  const i = input.image;
  if (!exact(i, ['imageId', 'repositoryDigest', 'architecture', 'nodeVersion', 'pythonVersion'])
      || Object.values(i).some(v => typeof v !== 'string')
      || !/^sha256:[a-f0-9]{64}$/.test(i.imageId)
      || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(i.repositoryDigest)
      || !['amd64', 'arm64'].includes(i.architecture)
      || !/^v\d+\.\d+\.\d+$/.test(i.nodeVersion) || !/^Python 3\.\d+\.\d+$/.test(i.pythonVersion)
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300000
      || !relative(input.entrypoint) || !input.entrypoint.endsWith('.cjs')
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 4096) bad();
  let bytes = 0;
  const names = new Set<string>();
  const files = input.files.map((f: any) => {
    if (!exact(f, ['path', 'base64', 'sha256']) || !relative(f.path) || names.has(f.path)
        || typeof f.base64 !== 'string' || f.base64.length > LIMIT * 2 || !/^[a-f0-9]{64}$/.test(f.sha256)) bad();
    names.add(f.path);
    const b = Buffer.from(f.base64, 'base64'); bytes += b.length;
    if (bytes > LIMIT || b.toString('base64') !== f.base64 || hash(b) !== f.sha256) bad();
    if (containsSecretSentinel(b) || containsSecretSentinel(f.path)) throw failure('offline_input_secret');
    return { path: f.path, base64: f.base64, sha256: f.sha256 };
  }).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!names.has(input.entrypoint)) bad();
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) bad(); parts.pop(); }
  }
  const image = { imageId: i.imageId, repositoryDigest: i.repositoryDigest, architecture: i.architecture, nodeVersion: i.nodeVersion, pythonVersion: i.pythonVersion };
  const payload = JSON.stringify({ files, entrypoint: input.entrypoint, nodeVersion: image.nodeVersion, pythonVersion: image.pythonVersion });
  if (Buffer.byteLength(payload) > LIMIT * 2) bad();
  return { image, payload, inputHash: hash(JSON.stringify({ image, payload })), timeoutMs: input.timeoutMs };
}

// Passed as a fixed argument, never evaluated on the host. Root filesystem stays read-only.
// Restore is exclusively into fresh /work tmpfs, before any user code runs, without symlinks.
const BOOTSTRAP = `
const isSafeRelativePath = ${isSafeRelativePath.toString()};
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
let chunks=[],n=0;
process.stdin.on('data',b=>{n+=b.length;if(n>33554432)process.exit(78);chunks.push(b)});
process.stdin.on('end',()=>{try{
 const p=JSON.parse(Buffer.concat(chunks));
 if(process.version!==p.nodeVersion||cp.execFileSync('/usr/bin/python3',['--version'],{encoding:'utf8',timeout:5000}).trim()!==p.pythonVersion)throw Error();
 for(const f of p.files){
  if(!isSafeRelativePath(f.path,{allowGit:true,allowNodeModules:true}))throw Error();
  const b=Buffer.from(f.base64,'base64');if(crypto.createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error();
  const dest=path.join('/work',f.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,b,{flag:'wx',mode:0o600});
 }
 const child=cp.spawn(process.execPath,['/work/'+p.entrypoint],{cwd:'/work',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/work',TMPDIR:'/tmp'},stdio:['ignore','inherit','inherit']});
 child.on('error',()=>process.exit(79));child.on('exit',(code,signal)=>process.exit(signal?80:(code??79)));
}catch{process.stderr.write('offline_bootstrap_failed\\n');process.exit(78)}});
`;

// Docker CLI receives only local discovery/system variables, never CAFF/provider/Node hooks.
// No shell, no caller-controlled executable. dockerHost is internal offline-recovery
// routing only (not HTTP/agent input); the recovery caller verifies dedicated ownership.
export function runDockerCommand(args: string[], options: any = {}): Promise<any> {
  const prefix = Object.hasOwn(options, 'dockerHost') ? ['--host', options.dockerHost] : ['--context', 'default'];
  if (Object.hasOwn(options, 'dockerHost') && (typeof options.dockerHost !== 'string'
      || !/^unix:\/\/\/[^\s\0]+$/.test(options.dockerHost))) return Promise.reject(failure('offline_host_unsupported'));
  const env: any = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise(resolve => {
    let child: any, reason = '', size = 0, done = false;
    const output: any = { stdout: [], stderr: [] };
    let timer: any;
    const finish = (code: any) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), ...(reason ? { failure: reason } : {}) }); };
    try { child = spawn('docker', [...prefix, ...args], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reason = 'spawn'; finish(null); return; }
    const stop = (r: string) => { if (!reason) reason = r; child.kill('SIGKILL'); };
    timer = setTimeout(() => stop('timeout'), options.timeoutMs || 15000);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (b: Buffer) => {
      size += b.length;
      if (size > (options.maxOutput || OUTPUT)) { stop('output_limit'); return; }
      output[stream].push(b);
    });
    child.on('error', () => { reason = 'spawn'; });
    child.on('close', finish);
    child.stdin.on('error', () => {}); // daemon exit/EPIPE is observed via close; never log input.
    child.stdin.end(options.input || '');
  });
}
function good(r: any) { return r && r.code === 0 && !r.failure; }
function one(r: any): any {
  if (!good(r)) return null;
  try { const a = JSON.parse(r.stdout); return Array.isArray(a) && a.length === 1 ? a[0] : null; } catch { return null; }
}
function owned(c: any, owner: string) {
  return c && /^[a-f0-9]{64}$/.test(c.Id) && c.Config?.Labels?.[LABEL] === owner;
}
function containerCommand() {
  return ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/work', 'TMPDIR=/tmp', '/usr/local/bin/node', '-e', BOOTSTRAP];
}
function isolated(c: any, imageId: string) {
  const h = c?.HostConfig;
  return c?.Image === imageId && c.Config?.User === '65534:65534'
    && JSON.stringify(c.Config.Entrypoint) === JSON.stringify(['/usr/bin/env']) && c.Config.WorkingDir === '/work'
    && JSON.stringify(c.Config.Cmd) === JSON.stringify(containerCommand())
    && (!c.Config.Volumes || Object.keys(c.Config.Volumes).length === 0)
    && Array.isArray(c.Mounts) && c.Mounts.every((m: any) => m.Type === 'tmpfs' && ['/work', '/tmp'].includes(m.Destination))
    && h?.NetworkMode === 'none' && h.ReadonlyRootfs === true && h.Privileged === false
    && JSON.stringify(h.CapDrop) === '["ALL"]' && !h.CapAdd?.length
    && h.SecurityOpt?.includes('no-new-privileges') && h.Memory === 536870912 && h.MemorySwap === 536870912
    && h.NanoCpus === 1000000000 && h.PidsLimit === 64 && !h.Binds?.length && !h.Mounts?.length && !h.VolumesFrom?.length
    && !h.Devices?.length && !h.DeviceRequests?.length && h.LogConfig?.Type === 'none'
    && ['no', ''].includes(h.RestartPolicy?.Name) && h.AutoRemove === false
    && !Object.keys(h.PortBindings || {}).length && !h.PidMode && h.IpcMode === 'private'
    && exact(h.Tmpfs, ['/work', '/tmp']) && h.Tmpfs['/work'] === WORK && h.Tmpfs['/tmp'] === TMP;
}

export async function runOfflineDockerTask(input: any, options: any = {}) {
  const p = prepareOfflineTask(input);
  if (active >= 2) throw failure('offline_busy');
  active++;
  try { return await execute(p, options); } finally { active--; }
}

async function execute(p: ReturnType<typeof prepareOfflineTask>, options: any) {
  // Injection is solely for deterministic internal fault tests, never HTTP/DB configuration.
  if (!options.runDocker && process.platform !== 'linux') throw failure('offline_host_unsupported');
  const run = options.runDocker || runDockerCommand;
  const endpoint = one(await run(['context', 'inspect', 'default']))?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !/^unix:\/\/\/[^\s\0]+$/.test(endpoint)) throw failure('offline_daemon_invalid');
  const img = one(await run(['image', 'inspect', p.image.imageId]));
  if (!img || img.Id !== p.image.imageId || !img.RepoDigests?.includes(p.image.repositoryDigest)
      || img.Architecture !== p.image.architecture || img.Os !== 'linux'
      || Object.keys(img.Config?.Volumes || {}).length || img.Config?.OnBuild?.length
      || (img.Config?.Healthcheck?.Test?.length && img.Config.Healthcheck.Test[0] !== 'NONE')) throw failure('offline_image_invalid');
  const owner = crypto.randomUUID(), name = 'caff-offline-' + owner;
  let id = '', result: any, primary: any;
  try {
    const created = await run(['create', '--name', name, '--label', `${LABEL}=${owner}`, '--pull', 'never', '-i',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64',
      '--user', '65534:65534', '--ipc', 'private', '--workdir', '/work', '--log-driver', 'none',
      '--tmpfs', '/work:' + WORK, '--tmpfs', '/tmp:' + TMP,
      '--entrypoint', '/usr/bin/env', p.image.imageId, ...containerCommand()]);
    if (!good(created) || !/^[a-f0-9]{64}$/.test(created.stdout.trim())) throw failure('offline_create_failed');
    id = created.stdout.trim();
    const pre = one(await run(['inspect', id]));
    if (!owned(pre, owner) || pre.Id !== id || pre.State?.Running !== false || !isolated(pre, p.image.imageId)) throw failure('offline_isolation_invalid');
    const execution = await run(['start', '-a', '-i', id], { input: p.payload, timeoutMs: p.timeoutMs, maxOutput: OUTPUT });
    const post = one(await run(['inspect', id]));
    if (!owned(post, owner) || post.Id !== id || !isolated(post, p.image.imageId)) throw failure('offline_state_unavailable');
    const killed = ['timeout', 'output_limit'].includes(execution.failure);
    if (!killed && (post.State?.Running !== false || !Number.isInteger(post.State?.ExitCode))) throw failure('offline_state_unavailable');
    result = { state: killed ? 'killed' : good(execution) && post.State.ExitCode === 0 && !post.State.OOMKilled ? 'completed' : 'failed',
      reason: killed ? execution.failure : post.State.OOMKilled ? 'oom' : good(execution) && post.State.ExitCode === 0 ? '' : 'runtime_or_task_failed',
      exitCode: killed ? null : post.State.ExitCode, inputHash: p.inputHash, containerId: id, image: p.image,
      isolation: { network: pre.HostConfig.NetworkMode, readonlyRootfs: pre.HostConfig.ReadonlyRootfs,
        user: pre.Config.User, privileged: pre.HostConfig.Privileged, capDrop: pre.HostConfig.CapDrop,
        securityOpt: pre.HostConfig.SecurityOpt, memory: pre.HostConfig.Memory, memorySwap: pre.HostConfig.MemorySwap,
        nanoCpus: pre.HostConfig.NanoCpus, pidsLimit: pre.HostConfig.PidsLimit, tmpfs: pre.HostConfig.Tmpfs,
        mounts: pre.Mounts.map((m: any) => ({ type: m.Type, destination: m.Destination })) },
      stdout: execution.stdout, stderr: execution.stderr, strictEvalEligible: false, cleaned: false };
  } catch (e) { primary = e; }
  // Even a create timeout may have created a container. Lookup unique name and verify ownership.
  // Never remove by unverified name, TTL/PID, label search across runs, or broad Docker prune.
  try {
    const c = one(await run(['inspect', id || name]));
    if (c) {
      if (!owned(c, owner) || (id && c.Id !== id)) throw failure('offline_cleanup_failed');
      if (!good(await run(['rm', '-f', c.Id]))) throw failure('offline_cleanup_failed');
    }
    const remaining = await run(['ps', '-a', '--no-trunc', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']);
    if (!good(remaining) || remaining.stdout.trim() || (!c && id)) throw failure('offline_cleanup_failed');
  } catch {
    throw Object.assign(failure('offline_cleanup_failed'), { containerName: name, containerId: id || null, primaryCode: primary?.code || result?.reason || null });
  }
  if (primary) throw primary;
  return { ...result, cleaned: true };
}
