import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { aclError, runWindowsAcl, validateWindowsAclSnapshot, type AclInput, type AclResult } from './windows-planner-acl';

export { buildWindowsAclInvocation, validateWindowsAclSnapshot, validateWindowsAncestors, runWindowsAcl } from './windows-planner-acl';

export type PlannerPrincipal = Readonly<{ kind: 'planner'; plannerId: string; plannerName: string }>;
export type PlannerCredential = {
  initialize(): void;
  authenticate(token: string): PlannerPrincipal | null;
  disable(): void;
  readonly path: string | null;
  readonly identity: PlannerPrincipal;
};
type PathOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; host: string; port: number };
type CredentialFileSystem = Pick<typeof fs, 'lstatSync' | 'mkdirSync' | 'closeSync' | 'openSync' | 'writeFileSync' | 'fsyncSync' | 'renameSync' | 'unlinkSync'>;
type CredentialOptions = {
  fileSystem?: CredentialFileSystem;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  host: string;
  getPort(): number;
  windowsAcl?: (input: AclInput) => AclResult;
  log?: (entry: Record<string, unknown>) => void;
};

export function resolvePlannerCredentialPath(options: PathOptions) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const override = String(env.CAFF_PLANNER_CREDENTIAL_FILE || '').trim();
  if (override) {
    if (!paths.isAbsolute(override)) throw aclError('credential_path_not_absolute');
    return paths.normalize(override);
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw aclError('credential_port_invalid');
  const host = String(options.host || '').trim().toLowerCase().replace(/^\[([^\]]+)\]$/, '$1');
  if (!host) throw aclError('credential_host_invalid');
  const hostHash = createHash('sha256').update(host, 'utf8').digest('hex');
  const base = platform === 'win32'
    ? String(env.LOCALAPPDATA || '')
    : String(env.XDG_STATE_HOME || (env.HOME ? paths.join(env.HOME, '.local', 'state') : ''));
  if (!base || !paths.isAbsolute(base)) throw aclError('credential_state_directory_invalid');
  return paths.join(base, platform === 'win32' ? 'CAFF' : 'caff', 'planner', `planner-${hostHash}-${port}.json`);
}

function principalFor(name?: string): PlannerPrincipal {
  return Object.freeze({ kind: 'planner', plannerId: 'local-planner', plannerName: String(name || '').trim().slice(0, 160) || 'External Planner' });
}
function tokenDigest(token: string) { return createHash('sha256').update(token).digest(); }
function validToken(token: unknown): token is string { return typeof token === 'string' && token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token); }
function authenticate(digest: Buffer | null, token: string, principal: PlannerPrincipal) {
  return digest && validToken(token) && timingSafeEqual(digest, tokenDigest(token)) ? principal : null;
}

// An explicit dependency-injection seam, not an env flag or HTTP capability.
// Test callers own the token; the production file-backed provider never exposes
// one through this interface, bootstrap, logs or the store.
export function createInMemoryPlannerCredential(options: { token: string; plannerName?: string }): PlannerCredential {
  if (!validToken(options.token)) throw aclError('credential_token_invalid');
  const expected = tokenDigest(options.token);
  const principal = principalFor(options.plannerName);
  let digest: Buffer | null = null;
  return { path: null, identity: principal, initialize() { digest = expected; }, disable() { digest = null; },
    authenticate(token) { return authenticate(digest, token, principal); } };
}

function lstatIfPresent(target: string, io: CredentialFileSystem = fs) {
  try { return io.lstatSync(target); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
function assertPosixPrivate(target: string, directory: boolean, io: CredentialFileSystem) {
  const s = io.lstatSync(target);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid!()
    || (s.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && s.nlink !== 1)) throw aclError('posix_permissions_invalid');
}
function assertPosixAncestors(directory: string, io: CredentialFileSystem) {
  let ancestor = path.posix.dirname(directory);
  while (true) {
    const s = lstatIfPresent(ancestor, io);
    if (s) {
      // OpenSSH-style exception: root-owned sticky /tmp cannot replace a
      // securely owned private child. An arbitrary writable ancestor can.
      const stickyRoot = s.uid === 0 && (s.mode & 0o1000) !== 0;
      if (s.isSymbolicLink() || !s.isDirectory() || (s.uid !== process.getuid!() && s.uid !== 0)
        || ((s.mode & 0o022) !== 0 && !stickyRoot)) throw aclError('unsafe_ancestor');
    }
    const parent = path.posix.dirname(ancestor);
    if (ancestor === parent) break;
    ancestor = parent;
  }
}

export function createPlannerCredential(options: CredentialOptions): PlannerCredential {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const io = options.fileSystem || fs;
  const acl = options.windowsAcl || ((input: AclInput) => runWindowsAcl(input, env));
  const log = options.log || ((entry: Record<string, unknown>) => console.info(JSON.stringify(entry)));
  let digest: Buffer | null = null;
  let credentialFile: string | null = null;
  const principal = principalFor(env.CAFF_PLANNER_NAME);

  function initialize() {
    digest = null;
    let temporaryPath: string | null = null;
    let published = false;
    let stage = 'create';
    try {
      credentialFile = resolvePlannerCredentialPath({ env, platform, host: options.host, port: options.getPort() });
      log({ event: 'planner_credential_path', path: credentialFile });
      const directory = paths.dirname(credentialFile);
      temporaryPath = paths.join(directory, `.planner-${randomBytes(16).toString('hex')}.tmp`);
      stage = 'set_acl';
      if (platform === 'win32') {
        const result = acl({ operation: 'prepare', directory, temporaryPath, targetPath: credentialFile });
        stage = 'verify_acl';
        validateWindowsAclSnapshot(result?.directory, result?.currentSid, true);
        validateWindowsAclSnapshot(result?.file, result?.currentSid, false);
        if (lstatIfPresent(credentialFile, io)) validateWindowsAclSnapshot(result?.existingFile, result?.currentSid, false);
      } else {
        assertPosixAncestors(directory, io);
        io.mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertPosixAncestors(directory, io);
        assertPosixPrivate(directory, true, io);
        if (lstatIfPresent(credentialFile, io)) assertPosixPrivate(credentialFile, false, io);
        io.closeSync(io.openSync(temporaryPath, 'wx', 0o600));
        assertPosixPrivate(temporaryPath, false, io);
      }
      stage = 'publish';
      const token = randomBytes(32).toString('base64url');
      const fd = io.openSync(temporaryPath, 'r+');
      try {
        io.writeFileSync(fd, JSON.stringify({ version: 1, plannerId: principal.plannerId, plannerName: principal.plannerName, token, issuedAt: new Date().toISOString() }));
        io.fsyncSync(fd);
      } finally { io.closeSync(fd); }
      io.renameSync(temporaryPath, credentialFile);
      published = true;
      temporaryPath = null;
      stage = 'verify_acl';
      if (platform === 'win32') {
        const result = acl({ operation: 'inspect', directory, targetPath: credentialFile });
        validateWindowsAclSnapshot(result?.directory, result?.currentSid, true);
        validateWindowsAclSnapshot(result?.file, result?.currentSid, false);
      } else { assertPosixAncestors(directory, io); assertPosixPrivate(directory, true, io); assertPosixPrivate(credentialFile, false, io); }
      digest = tokenDigest(token);
    } catch (error: any) {
      digest = null;
      if (temporaryPath) { try { io.unlinkSync(temporaryPath); } catch {} }
      if (published && credentialFile) { try { io.unlinkSync(credentialFile); } catch {} }
      log({ event: 'planner_credentials_disabled', stage, path: credentialFile,
        ...(error?.diagnostic || { reason: 'secure_publication_failed' }) });
    }
  }

  return { initialize, identity: principal, get path() { return credentialFile; },
    authenticate(token) { return authenticate(digest, token, principal); }, disable() { digest = null; } };
}
