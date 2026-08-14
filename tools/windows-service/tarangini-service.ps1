param(
  [ValidateSet('install','uninstall','start','stop','restart','status')]
  [string]$Action = 'status',
  [string]$ServiceName = 'TaranginiWorkflowMain',
  [string]$AppExe = '',
  [string]$ConfigPath = '',
  [switch]$StartAfterInstall
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-JsonStatus {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) {
    [pscustomobject]@{
      installed = $false
      status = 'not_installed'
      service_name = $ServiceName
    } | ConvertTo-Json -Compress
    return
  }
  $wmi = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  [pscustomobject]@{
    installed = $true
    status = $svc.Status.ToString()
    service_name = $ServiceName
    start_type = if ($wmi) { $wmi.StartMode } else { '' }
    path_name = if ($wmi) { $wmi.PathName } else { '' }
  } | ConvertTo-Json -Compress
}

if ($Action -eq 'status') {
  Write-JsonStatus
  exit 0
}

if (-not (Test-Admin)) {
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`"",
    '-Action', $Action,
    '-ServiceName', "`"$ServiceName`"",
    '-AppExe', "`"$AppExe`"",
    '-ConfigPath', "`"$ConfigPath`""
  )
  if ($StartAfterInstall) { $args += '-StartAfterInstall' }
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Administrator action failed with exit code $($process.ExitCode)." }
  Write-JsonStatus
  exit 0
}

if ([string]::IsNullOrWhiteSpace($AppExe) -and $Action -eq 'install') {
  throw 'AppExe is required to install the Tarangini Windows Service.'
}

$quotedExe = '"' + $AppExe + '"'
$quotedConfig = if ($ConfigPath) { '"' + $ConfigPath + '"' } else { '""' }
$binPath = "$quotedExe --tarangini-service --tarangini-config $quotedConfig"

switch ($Action) {
  'install' {
    if (-not (Test-Path -LiteralPath $AppExe)) { throw "Application executable was not found: $AppExe" }
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
      sc.exe config $ServiceName binPath= $binPath start= auto DisplayName= "Tarangini Workflow Main System" | Out-Null
    } else {
      sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "Tarangini Workflow Main System" | Out-Null
      sc.exe description $ServiceName "Runs the Tarangini Main System server, customer portal, backups and attachment workers without opening the desktop window." | Out-Null
    }
    if ($ConfigPath) {
      $configDir = Split-Path -Parent $ConfigPath
      if ($configDir -and -not (Test-Path -LiteralPath $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
      }
    }
    if ($StartAfterInstall) {
      Start-Service -Name $ServiceName
    }
  }
  'uninstall' {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
      if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      }
      sc.exe delete $ServiceName | Out-Null
    }
  }
  'start' {
    Start-Service -Name $ServiceName
  }
  'stop' {
    Stop-Service -Name $ServiceName -Force
  }
  'restart' {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) { throw "Service is not installed: $ServiceName" }
    if ($svc.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      $svc.WaitForStatus('Stopped', '00:00:20')
    }
    Start-Service -Name $ServiceName
  }
}

Write-JsonStatus
