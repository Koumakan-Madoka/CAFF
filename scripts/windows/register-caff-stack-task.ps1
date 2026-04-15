param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$WslDistro = 'Debian',
  [string]$TaskName = 'CAFF Local Stack',
  [int]$PollSeconds = 15,
  [switch]$RunNow,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$runnerScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-caff-stack.ps1')).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$actionArgs = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-WindowStyle', 'Hidden',
  '-File', "`"$runnerScript`"",
  '-RepoRoot', "`"$resolvedRepoRoot`"",
  '-WslDistro', "`"$WslDistro`"",
  '-PollSeconds', $PollSeconds
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$description = 'Keeps WSL Docker/OpenSandbox and the local CAFF server running after Windows logon.'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  if (-not $Force) {
    throw "Scheduled task '$TaskName' already exists. Re-run with -Force to replace it."
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description | Out-Null

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host "Registered scheduled task '$TaskName' for user '$currentUser'."
Write-Host "Runner: $runnerScript"
Write-Host "Repo:   $resolvedRepoRoot"
Write-Host "WSL:    $WslDistro"
if ($RunNow) {
  Write-Host 'Task started immediately.'
}
