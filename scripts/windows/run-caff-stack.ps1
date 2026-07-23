param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$WslDistro = 'Debian',
  [int]$PollSeconds = 15
)

$ErrorActionPreference = 'Stop'

function Write-Log {
  param(
    [string]$Path,
    [string]$Message
  )

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $Path -Value "[$timestamp] $Message" -Encoding UTF8
}

function Unwrap-QuotedValue {
  param([AllowNull()][string]$Value)

  if ($null -eq $Value) {
    return ''
  }

  $trimmed = $Value.Trim()
  if (
    $trimmed.Length -ge 2 -and
    (($trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) -or ($trimmed.StartsWith("'") -and $trimmed.EndsWith("'")))
  ) {
    return $trimmed.Substring(1, $trimmed.Length - 2)
  }

  return $trimmed
}

function Get-DotEnvValue {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    if ($line.TrimStart().StartsWith('#')) {
      continue
    }
    if ($line -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') {
      continue
    }
    $parts = $line.Split('=', 2)
    if ($parts[0] -ceq $Name) {
      return Unwrap-QuotedValue -Value $parts[1]
    }
  }

  return $null
}

function Test-HttpOk {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -Method Get -TimeoutSec 5
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-WslKeepaliveProcess {
  param([string]$Distro)

  Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" |
    Where-Object {
      $_.CommandLine -like "* -d $Distro *" -and
      $_.CommandLine -like '*sleep infinity*'
    } |
    Select-Object -First 1
}

function Start-WslKeepalive {
  param(
    [string]$Distro,
    [string]$LogPath
  )

  $arguments = @(
    '-d',
    $Distro,
    '-u',
    'root',
    '-e',
    'sh',
    '-lc',
    'systemctl restart docker; exec sleep infinity'
  )
  Start-Process -FilePath 'wsl.exe' -ArgumentList $arguments -WindowStyle Hidden | Out-Null
  Write-Log -Path $LogPath -Message "Started WSL keepalive for distro '$Distro'."
}

function Resolve-NpmCommand {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  if ($env:ProgramFiles) {
    $fallback = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
    if (Test-Path -LiteralPath $fallback) {
      return $fallback
    }
  }

  throw 'npm.cmd not found. Install Node.js or add npm.cmd to PATH.'
}

function Start-Caff {
  param(
    [string]$RepoRootPath,
    [string]$NpmCommand,
    [string]$ServerLog,
    [string]$SupervisorLog
  )

  $command = "`"$NpmCommand`" run start >> `"$ServerLog`" 2>&1"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/d', '/c', $command -WorkingDirectory $RepoRootPath -WindowStyle Hidden | Out-Null
  Write-Log -Path $SupervisorLog -Message "Started CAFF with npm run start from '$RepoRootPath'."
}

$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$logsDir = Join-Path $env:LOCALAPPDATA 'caff\logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$supervisorLog = Join-Path $logsDir 'stack-supervisor.log'
$serverLog = Join-Path $logsDir 'caff-server.log'
$envLocalPath = Join-Path $resolvedRepoRoot '.env.local'
$chatPort = Get-DotEnvValue -Path $envLocalPath -Name 'CHAT_APP_PORT'
if ([string]::IsNullOrWhiteSpace($chatPort)) {
  $chatPort = '3100'
}
$caffHealthUrl = "http://localhost:$chatPort/"
$npmCommand = Resolve-NpmCommand
$lastCaffStart = [datetime]::MinValue

Write-Log -Path $supervisorLog -Message "Supervisor booted. repo='$resolvedRepoRoot' distro='$WslDistro' caff='$caffHealthUrl'."

while ($true) {
  if (-not (Get-WslKeepaliveProcess -Distro $WslDistro)) {
    Start-WslKeepalive -Distro $WslDistro -LogPath $supervisorLog
    Start-Sleep -Seconds 3
  }
  }

  if (-not (Test-HttpOk -Url $caffHealthUrl)) {
    if ((New-TimeSpan -Start $lastCaffStart -End (Get-Date)).TotalSeconds -ge 30) {
      Start-Caff -RepoRootPath $resolvedRepoRoot -NpmCommand $npmCommand -ServerLog $serverLog -SupervisorLog $supervisorLog
      $lastCaffStart = Get-Date
      Start-Sleep -Seconds 8
    }
  }

  Start-Sleep -Seconds $PollSeconds
}
