param(
  [Parameter(Mandatory = $true)]
  [string]$AppPath,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$BatchArguments
)

$ErrorActionPreference = 'Stop'

function Quote-Argument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\*)$', '$1$1') + '"'
}

if (-not (Test-Path -LiteralPath $AppPath)) {
  throw "Tarangini Workflow Suite.exe was not found: $AppPath"
}

$reportDirectory = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Tarangini Batch Reports'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$reportPath = $null
for ($index = 0; $index -lt $BatchArguments.Count; $index += 1) {
  if ($BatchArguments[$index] -eq '--report' -and $index + 1 -lt $BatchArguments.Count) {
    $reportPath = $BatchArguments[$index + 1]
    break
  }
}
if (-not $reportPath) {
  $reportPath = Join-Path $reportDirectory ("tarangini-web-invoice-batch-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $BatchArguments += @('--report', $reportPath)
}
Write-Host 'Tarangini Web Invoice Batch Creator' -ForegroundColor Cyan
Write-Host 'Dry-run is the default. Add --commit only after reviewing the report.' -ForegroundColor Yellow
$secureSecret = Read-Host 'Enter the Tarangini password or PIN for the selected user' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)

try {
  $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:TARANGINI_BATCH_SECRET = $secret
  $env:TARANGINI_BATCH_REPORT_DIR = $reportDirectory
  $arguments = @('--web-invoice-batch') + $BatchArguments
  $argumentLine = ($arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
  $process = Start-Process -FilePath $AppPath -ArgumentList $argumentLine -Wait -PassThru
  if ($process.ExitCode -eq 0) {
    Write-Host "Finished. Open the JSON audit report: $reportPath" -ForegroundColor Green
  } else {
    $reason = $null
    if (Test-Path -LiteralPath $reportPath) {
      try { $reason = @((Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json).errors)[0] } catch {}
    }
    Write-Host "The batch did not complete. Audit report: $reportPath" -ForegroundColor Red
    if ($reason) { Write-Host "Reason: $reason" -ForegroundColor Red }
  }
  exit $process.ExitCode
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Item Env:TARANGINI_BATCH_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:TARANGINI_BATCH_REPORT_DIR -ErrorAction SilentlyContinue
}
