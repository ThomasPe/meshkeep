# Runs check-store-identity.ps1 once per case, the way release.yml calls it, and compares the
# exit code, what it writes to GITHUB_OUTPUT and the annotation it prints. CI runs this on
# every push: the check itself only runs when a release is built, which is the worst moment
# to find out that it is broken.
$ErrorActionPreference = "Stop"
$check = Join-Path $PSScriptRoot "check-store-identity.ps1"
$shell = (Get-Process -Id $PID).Path
$names = @("MSIX_IDENTITY_NAME", "MSIX_PUBLISHER", "MSIX_PUBLISHER_DISPLAY_NAME", "MSIX_VERSION", "GITHUB_REF_TYPE", "GITHUB_OUTPUT")
$identity = @{
  MSIX_IDENTITY_NAME          = "12345DevSym.Meshkeep"
  MSIX_PUBLISHER              = "CN=0A1B2C3D-0000-4000-8000-000000000000"
  MSIX_PUBLISHER_DISPLAY_NAME = "DevSym"
}

# One run in a child process with exactly the given variables; the caller's own environment
# (CI sets GITHUB_OUTPUT and GITHUB_REF_TYPE for this step too) is put back afterwards.
function Invoke-Check([hashtable]$vars, [string]$refType) {
  $saved = @{}
  foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $null) }
    foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
    $env:GITHUB_REF_TYPE = $refType
    $env:GITHUB_OUTPUT = $outFile
    $log = (& $shell -NoProfile -File $check | Out-String)
    $code = $LASTEXITCODE
    $output = [string](Get-Content $outFile -Raw)
    return @{ Code = $code; Log = $log; Output = $output }
  } finally {
    foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
    Remove-Item $outFile -ErrorAction SilentlyContinue
  }
}

$script:failed = 0
function Expect([string]$case, [bool]$ok, [hashtable]$result) {
  if ($ok) {
    Write-Host "ok   $case"
  } else {
    $script:failed++
    Write-Host "FAIL $case (exit $($result.Code), output '$($result.Output.Trim())')"
    Write-Host $result.Log
  }
}

$r = Invoke-Check $identity "tag"
Expect "a tag with all three values passes" ($r.Code -eq 0 -and $r.Output -match "configured=true" -and $r.Log -notmatch "::(error|warning)") $r

$r = Invoke-Check @{} "tag"
Expect "a tag without the values stops the release" ($r.Code -eq 1 -and $r.Output -match "configured=false" -and $r.Log -match "::error" -and $r.Log -match "MSIX_IDENTITY_NAME, MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME") $r

$r = Invoke-Check @{} "branch"
Expect "a manual run from a branch only warns" ($r.Code -eq 0 -and $r.Output -match "configured=false" -and $r.Log -match "::warning" -and $r.Log -notmatch "::error") $r

$partial = $identity.Clone()
$partial.Remove("MSIX_PUBLISHER_DISPLAY_NAME")
$r = Invoke-Check $partial "tag"
Expect "one missing value is named, the others are not" ($r.Code -eq 1 -and $r.Output -match "configured=false" -and $r.Log -match "not set: MSIX_PUBLISHER_DISPLAY_NAME" -and $r.Log -notmatch "MSIX_IDENTITY_NAME") $r

$blank = $identity.Clone()
$blank["MSIX_IDENTITY_NAME"] = "   "
$r = Invoke-Check $blank "tag"
Expect "a blank value counts as missing" ($r.Code -eq 1 -and $r.Log -match "not set: MSIX_IDENTITY_NAME") $r

$guidOnly = $identity.Clone()
$guidOnly["MSIX_PUBLISHER"] = "0A1B2C3D-0000-4000-8000-000000000000"
$r = Invoke-Check $guidOnly "tag"
Expect "a publisher without CN= stops the release" ($r.Code -eq 1 -and $r.Output -match "configured=false" -and $r.Log -match "starts with 'CN='") $r

$versioned = $identity.Clone()
$versioned["MSIX_VERSION"] = "1.0.0.0"
$r = Invoke-Check $versioned "tag"
Expect "a tag with the identity and version 1.0.0.0 passes" ($r.Code -eq 0 -and $r.Output -match "configured=true" -and $r.Log -notmatch "::(error|warning)") $r

$zero = $identity.Clone()
$zero["MSIX_VERSION"] = "0.1.0.0"
$r = Invoke-Check $zero "tag"
Expect "a tag whose version starts with 0 stops the release" ($r.Code -eq 1 -and $r.Output -match "configured=true" -and $r.Log -match "::error" -and $r.Log -match "0\.1\.0\.0 is not accepted") $r

$r = Invoke-Check $zero "branch"
Expect "a manual run with such a version only warns" ($r.Code -eq 0 -and $r.Output -match "configured=true" -and $r.Log -match "::warning" -and $r.Log -notmatch "::error") $r

$revision = $identity.Clone()
$revision["MSIX_VERSION"] = "1.2.3.4"
$r = Invoke-Check $revision "tag"
Expect "a fourth part other than 0 stops the release" ($r.Code -eq 1 -and $r.Log -match "1\.2\.3\.4 is not accepted") $r

$both = @{ MSIX_VERSION = "0.1.0.0" }
$r = Invoke-Check $both "tag"
Expect "a tag with both problems names both" ($r.Code -eq 1 -and $r.Output -match "configured=false" -and $r.Log -match "identity not configured" -and $r.Log -match "is not accepted") $r

if ($script:failed -gt 0) { throw "$($script:failed) case(s) of the Store identity check failed" }
Write-Host "Store identity check: all cases OK"
# The last child exited with 1 on purpose; without this the calling step would inherit it.
exit 0
