import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type AclInput = {
  operation: 'prepare' | 'inspect';
  directory: string;
  targetPath: string;
  temporaryPath?: string;
};

type Ace = { sid: string; rights: number; type: number; inherited: boolean; inheritance: number; propagation: number };
type Snapshot = { ownerSid: string; protected: boolean; reparse: boolean; daclPresent: boolean; rules: Ace[] };
export type AclResult = { currentSid: string; directory: Snapshot; file: Snapshot; existingFile?: Snapshot };

const FULL_CONTROL = 2032127;
// DELETE | WRITE_DAC | WRITE_OWNER | DELETE_CHILD | GENERIC_ALL | GENERIC_WRITE.
// Read/execute (including signed GENERIC_READ) and create-only directory rights
// do not permit replacing an already protected child.
const REPLACEMENT_RIGHTS = 1343029312;
const SYSTEM_SID = 'S-1-5-18';
const ADMIN_SID = 'S-1-5-32-544';
const INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;
const STAGES = new Set(['create', 'set_acl', 'verify_acl', 'publish']);
const FAILURE_REASONS = new Set([
  'reparse_path', 'path_type', 'unsupported_ace', 'unsafe_ancestor_owner', 'unsafe_ancestor_access',
  'ancestor_type', 'missing_root', 'directory_owner', 'temporary_parent', 'unknown_operation', 'windows_acl_failed',
]);

function safeSid(value: unknown) { return typeof value === 'string' && SID_PATTERN.test(value) ? value : undefined; }
function safeNumber(value: unknown) { return Number.isSafeInteger(value) ? value as number : undefined; }

export function aclError(reason: string, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(reason), { diagnostic: { reason, ...details } });
}

function snapshotDiagnostic(value: any, currentSid: string, ace?: any) {
  return { expectedOwnerSid: safeSid(currentSid), actualOwnerSid: safeSid(value?.ownerSid),
    protected: typeof value?.protected === 'boolean' ? value.protected : undefined,
    ...(ace ? { aceSid: safeSid(ace.sid), rights: safeNumber(ace.rights), inheritance: safeNumber(ace.inheritance),
      propagation: safeNumber(ace.propagation), type: safeNumber(ace.type) } : {}) };
}

function validAce(ace: any): ace is Ace {
  return ace && safeSid(ace.sid) && Number.isInteger(ace.rights) && ace.rights >= -0x80000000 && ace.rights <= 0x7fffffff
    && (ace.type === 0 || ace.type === 1) && typeof ace.inherited === 'boolean'
    && Number.isInteger(ace.inheritance) && ace.inheritance >= 0 && ace.inheritance <= 3
    && Number.isInteger(ace.propagation) && ace.propagation >= 0 && ace.propagation <= 3;
}

export function validateWindowsAclSnapshot(value: any, currentSid: string, directory: boolean) {
  const fail = (reason: string, ace?: any): never => { throw aclError(reason, snapshotDiagnostic(value, currentSid, ace)); };
  if (!safeSid(currentSid)) fail('current_sid_invalid');
  if (!value || value.ownerSid !== currentSid || value.protected !== true || value.reparse !== false
    || value.daclPresent !== true || !Array.isArray(value.rules) || !value.rules.length) fail('descriptor_invalid');
  const seen = new Set<string>();
  for (const ace of value.rules) {
    if (!validAce(ace) || (ace.sid !== currentSid && ace.sid !== SYSTEM_SID) || seen.has(ace.sid)
      || ace.rights !== FULL_CONTROL || ace.type !== 0 || ace.inherited !== false
      || ace.inheritance !== (directory ? 3 : 0) || ace.propagation !== 0) fail('ace_invalid', ace);
    seen.add(ace.sid);
  }
  if (!seen.has(currentSid)) fail('owner_access_missing');
}

export function validateWindowsAncestors(ancestors: any, currentSid: string) {
  if (!safeSid(currentSid) || !Array.isArray(ancestors) || !ancestors.length) throw aclError('ancestors_invalid');
  const trusted = new Set([currentSid, SYSTEM_SID, ADMIN_SID, INSTALLER_SID]);
  for (const ancestor of ancestors) {
    const value = ancestor?.descriptor;
    if (!value || value.reparse !== false || value.daclPresent !== true || !trusted.has(value.ownerSid)
      || !Array.isArray(value.rules)) throw aclError('unsafe_ancestor_owner', snapshotDiagnostic(value, currentSid));
    for (const ace of value.rules) {
      if (!validAce(ace)) throw aclError('unsupported_ace', snapshotDiagnostic(value, currentSid, ace));
      if (ace.type === 0 && !(ace.propagation & 2) && (ace.rights & REPLACEMENT_RIGHTS) && !trusted.has(ace.sid)) {
        throw aclError('unsafe_ancestor_access', snapshotDiagnostic(value, currentSid, ace));
      }
    }
  }
}

// This helper never receives token bytes. All paths are JSON stdin, never code;
// only numeric fields/SIDs leave it. Node also revalidates the private snapshots.
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stage = 'verify_acl'
$failure = $null
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  function Fail-Policy($reason, $descriptor, $ace) {
    $script:failure = @{ reason = $reason; expectedOwnerSid = $sid.Value }
    if ($null -ne $descriptor) { $script:failure.actualOwnerSid = $descriptor.ownerSid; $script:failure.protected = $descriptor.protected }
    if ($null -ne $ace) {
      $script:failure.aceSid = $ace.sid; $script:failure.rights = $ace.rights
      $script:failure.inheritance = $ace.inheritance; $script:failure.propagation = $ace.propagation; $script:failure.type = $ace.type
    }
    throw 'policy_rejected'
  }
  function Read-Security($p, $directory) {
    $item = Get-Item -LiteralPath $p -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail-Policy 'reparse_path' $null $null }
    if ($directory -ne $item.PSIsContainer) { Fail-Policy 'path_type' $null $null }
    if ($directory) { $acl = [IO.Directory]::GetAccessControl($p) } else { $acl = [IO.File]::GetAccessControl($p) }
    $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = [int]$_.AccessControlType;
         inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
    })
    if ($null -ne $raw.DiscretionaryAcl) {
      foreach ($ace in $raw.DiscretionaryAcl) {
        if ($ace.AceType -ne [System.Security.AccessControl.AceType]::AccessAllowed -and $ace.AceType -ne [System.Security.AccessControl.AceType]::AccessDenied) { Fail-Policy 'unsupported_ace' $null $null }
      }
      if ($raw.DiscretionaryAcl.Count -ne $rules.Count) { Fail-Policy 'unsupported_ace' $null $null }
    }
    return @{ ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
      protected = $acl.AreAccessRulesProtected; reparse = $false;
      daclPresent = ($null -ne $raw.DiscretionaryAcl); rules = $rules }
  }
  function Check-Ancestors($p) {
    $script:ancestorResults = @()
    $current = [IO.Directory]::GetParent($p)
    while ($null -ne $current) {
      if (Test-Path -LiteralPath $current.FullName) {
        if (-not [IO.Directory]::Exists($current.FullName)) { Fail-Policy 'ancestor_type' $null $null }
        $a = Read-Security $current.FullName $true
        $script:ancestorResults += @{ path = $current.FullName; descriptor = $a }
        if (-not $a.daclPresent -or $trusted -notcontains $a.ownerSid) { Fail-Policy 'unsafe_ancestor_owner' $a $null }
        foreach ($rule in $a.rules) {
          if ($rule.type -eq 0 -and ($rule.propagation -band 2) -eq 0 -and ($rule.rights -band ${REPLACEMENT_RIGHTS}) -ne 0 -and $trusted -notcontains $rule.sid) { Fail-Policy 'unsafe_ancestor_access' $a $rule }
        }
      }
      $current = $current.Parent
    }
  }
  function New-PrivateSecurity($directory) {
    if ($directory) { $a = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $a = New-Object System.Security.AccessControl.FileSecurity }
    $a.SetOwner($sid)
    $a.SetAccessRuleProtection($true, $false)
    foreach ($who in @($sid, $systemSid) | Select-Object -Unique) {
      if ($directory) { $inherit = [System.Security.AccessControl.InheritanceFlags]3 } else { $inherit = [System.Security.AccessControl.InheritanceFlags]0 }
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($who, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
      $a.AddAccessRule($rule)
    }
    return $a
  }
  $directory = [IO.Path]::GetFullPath($inputData.directory)
  Check-Ancestors $directory
  $existing = $null
  if ($inputData.operation -eq 'prepare') {
    $stage = 'set_acl'
    $missing = New-Object 'System.Collections.Generic.List[string]'
    $p = $directory
    while (-not [IO.Directory]::Exists($p)) {
      $missing.Add($p); $p = [IO.Path]::GetDirectoryName($p)
      if (-not $p) { Fail-Policy 'missing_root' $null $null }
    }
    for ($i = $missing.Count - 1; $i -ge 0; $i--) { [void][IO.Directory]::CreateDirectory($missing[$i], (New-PrivateSecurity $true)) }
    # Never repair an existing unsafe directory/target. Return its actual DACL
    # for Node's strict validator before writing any credential bytes.
    if (Test-Path -LiteralPath $inputData.targetPath) { $existing = Read-Security $inputData.targetPath $false }
    if ([IO.Path]::GetDirectoryName($inputData.temporaryPath) -ne $directory) { Fail-Policy 'temporary_parent' $null $null }
    # CreateNew: do not truncate an existing path, even with a random filename.
    $stream = New-Object IO.FileStream($inputData.temporaryPath, [IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, (New-PrivateSecurity $false))
    $stream.Dispose()
    $filePath = $inputData.temporaryPath
  } elseif ($inputData.operation -eq 'inspect') { $filePath = $inputData.targetPath }
  else { Fail-Policy 'unknown_operation' $null $null }
  $stage = 'verify_acl'
  Check-Ancestors $directory
  @{ currentSid = $sid.Value; ancestors = $ancestorResults; directory = (Read-Security $directory $true); file = (Read-Security $filePath $false); existingFile = $existing } | ConvertTo-Json -Depth 8 -Compress
} catch {
  if ($null -eq $failure) { $failure = @{ reason = 'windows_acl_failed' } }
  $failure.failed = $true; $failure.stage = $stage; $failure.osCode = $_.Exception.HResult
  $failure | ConvertTo-Json -Compress
  exit 1
}
`;

export function buildWindowsAclInvocation(input: AclInput, env: NodeJS.ProcessEnv = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw aclError('windows_system_root_missing');
  return {
    file: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64')],
    options: { input: JSON.stringify(input), encoding: 'utf8' as const, shell: false as const, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
  };
}

export function runWindowsAcl(input: AclInput, env: NodeJS.ProcessEnv, run: typeof spawnSync = spawnSync): AclResult {
  const invocation = buildWindowsAclInvocation(input, env);
  const result = run(invocation.file, invocation.args, invocation.options);
  let data: any;
  try { data = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '').trim()); } catch {}
  if (result.status !== 0 || result.error || data?.failed) {
    // Never relay subprocess output or exception text. Only our fixed-schema
    // JSON diagnostic is public; even malformed output stays private.
    throw aclError(FAILURE_REASONS.has(data?.reason) ? data.reason : 'windows_acl_helper_failed', {
      stage: STAGES.has(data?.stage) ? data.stage : 'verify_acl', exitCode: result.status,
      osCode: safeNumber(data?.osCode), expectedOwnerSid: safeSid(data?.expectedOwnerSid), actualOwnerSid: safeSid(data?.actualOwnerSid),
      protected: typeof data?.protected === 'boolean' ? data.protected : undefined,
      aceSid: safeSid(data?.aceSid), rights: safeNumber(data?.rights), inheritance: safeNumber(data?.inheritance),
      propagation: safeNumber(data?.propagation), type: safeNumber(data?.type),
    });
  }
  if (!data || !safeSid(data.currentSid) || !data.directory || !data.file) throw aclError('windows_acl_output_invalid');
  validateWindowsAncestors(data.ancestors, data.currentSid);
  return data;
}
