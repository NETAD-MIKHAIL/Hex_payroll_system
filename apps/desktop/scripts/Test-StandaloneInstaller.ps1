param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [string]$UpgradeInstaller,
  [string]$UpgradeSha256,
  [switch]$ConfirmDisposableMachine
)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmDisposableMachine) { throw 'Run only inside a disposable Windows VM, with -ConfirmDisposableMachine.' }
if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Installer checksum mismatch' }
if ($UpgradeInstaller -and ((Get-FileHash -LiteralPath $UpgradeInstaller -Algorithm SHA256).Hash -ne $UpgradeSha256)) { throw 'Upgrade checksum mismatch' }
$installDirectory = Join-Path $env:LOCALAPPDATA 'ProgramsHex Payroll'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'Hex Payroll'
if ((Test-Path -LiteralPath $installDirectory) -or (Test-Path -LiteralPath $dataDirectory)) { throw 'VM must have no existing Hex Payroll installation or data.' }
$report = [System.Collections.Generic.List[string]]::new()
$report.Add('VM operator must record Windows version, network disabled state, and absence of Node/pnpm/PostgreSQL before this run.')
function Install-Hex([string]$Setup) {
  $process = Start-Process -FilePath $Setup -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Setup failed: $($process.ExitCode)" }
}
function Open-And-CloseHex {
  $statusFile = Join-Path $dataDirectory 'private-runtimestartup-status.json'
  $startedAt = [DateTime]::UtcNow
  $process = Start-Process -FilePath (Join-Path $installDirectory 'Hex Payroll.exe') -WindowStyle Hidden -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 180; $attempt++) {
    if ($process.HasExited) { throw 'Application exited before readiness; inspect retained startup-status.json and PostgreSQL logs.' }
    if (Test-Path -LiteralPath $statusFile) {
      try {
        $status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
        if ($status.phase -eq 'ready' -and [DateTime]::Parse($status.at).ToUniversalTime() -ge $startedAt) { $ready = $true; break }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw 'Application readiness timed out. Preserve the VM for inspection.' }
  $process.Refresh()
  if (-not $process.CloseMainWindow()) { throw 'Close the application window normally and inspect the VM; do not force-kill the database.' }
  if (-not $process.WaitForExit(90000)) { throw 'Graceful shutdown timed out' }
  & (Join-Path $installDirectory 'resourcespostgresinpg_ctl.exe') -D (Join-Path $dataDirectory 'private-runtimepgdata') status | Out-Null
  if ($LASTEXITCODE -ne 3) { throw 'Private PostgreSQL did not stop normally' }
}
Install-Hex $Installer
Open-And-CloseHex
$report.Add('PASS: silent clean NSIS installation, database initialization/migrations, API readiness, application launch and graceful database shutdown.')
$vault = Join-Path $dataDirectory 'private-runtimecredentials.dpapi'
$marker = Join-Path $dataDirectory 'private-runtimecluster-owner.json'
$vaultHash = (Get-FileHash -LiteralPath $vault -Algorithm SHA256).Hash
$markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash
Open-And-CloseHex
$report.Add('PASS: restart with retained private cluster and Windows-protected credentials.')
if ($UpgradeInstaller) {
  Install-Hex $UpgradeInstaller
  Open-And-CloseHex
  if ((Get-FileHash -LiteralPath $vault -Algorithm SHA256).Hash -ne $vaultHash) { throw 'Upgrade changed protected credentials unexpectedly' }
  if ((Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -ne $markerHash) { throw 'Upgrade replaced cluster identity' }
  $report.Add('PASS: supplied upgrade preserves cluster identity and credentials. Operator must also test a populated payroll fixture.')
}
$uninstall = Join-Path $installDirectory 'Uninstall Hex Payroll.exe'
$process = Start-Process -FilePath $uninstall -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Uninstall failed' }
if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'private-runtimepgdataPG_VERSION'))) { throw 'Uninstall removed the private cluster' }
if ((Get-FileHash -LiteralPath $vault -Algorithm SHA256).Hash -ne $vaultHash) { throw 'Uninstall removed or changed credentials' }
Install-Hex $(if ($UpgradeInstaller) { $UpgradeInstaller } else { $Installer })
Open-And-CloseHex
$report.Add('PASS: uninstall preserves database and credentials; reinstall opens the retained cluster.')
$report.Add('NOT COVERED: populated payroll comparison, TLS central enrollment/revocation, connectivity recovery, interrupted NSIS installation, reboot during initialization, restore from backup, hardware protocols, signing validation.')
$report | Set-Content -LiteralPath (Join-Path $env:TEMP 'Hex-Payroll-installer-rehearsal.txt') -Encoding UTF8
$report
