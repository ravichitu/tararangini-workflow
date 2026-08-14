param(
  [ValidateSet('enable','disable','status')]
  [string]$Action = 'status',
  [ValidateRange(1024,65535)]
  [int]$Port = 3001,
  [string]$RuleName = 'Tarangini Workflow Local Portal'
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Status {
  $rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $rule) {
    [pscustomobject]@{ enabled = $false; status = 'not_configured'; rule_name = $RuleName; port = $Port } |
      ConvertTo-Json -Compress
    return
  }
  $filter = $rule | Get-NetFirewallPortFilter
  [pscustomobject]@{
    enabled = $rule.Enabled -eq 'True'
    status = if ($rule.Enabled -eq 'True') { 'enabled' } else { 'disabled' }
    rule_name = $RuleName
    profile = $rule.Profile.ToString()
    direction = $rule.Direction.ToString()
    protocol = $filter.Protocol
    port = $filter.LocalPort
  } | ConvertTo-Json -Compress
}

if ($Action -eq 'status') {
  Write-Status
  exit 0
}

if (-not (Test-Admin)) {
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-Action', $Action, '-Port', $Port, '-RuleName', "`"$RuleName`""
  )
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Administrator firewall action failed with exit code $($process.ExitCode)." }
  Write-Status
  exit 0
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) { $existing | Remove-NetFirewallRule }

if ($Action -eq 'enable') {
  New-NetFirewallRule -DisplayName $RuleName -Group 'Tarangini Workflow Suite' `
    -Description 'Allows customer intake to this Tarangini client from the local private network only.' `
    -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol TCP `
    -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null
}

Write-Status
