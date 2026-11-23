<#
.SYNOPSIS
  Release gate for the Store MSIX: can the package this run builds be submitted?

  release.yml runs this before anything is built. It checks two things:

  - The Partner Center identity is configured: the repository variables MSIX_IDENTITY_NAME,
    MSIX_PUBLISHER and MSIX_PUBLISHER_DISPLAY_NAME (docs/store/README.md, "Partner Center
    identity"). Without them the "Store" package would carry the side-load identity.
  - The package version in MSIX_VERSION is one the Store accepts: four parts, the first 1 or
    higher, the last 0 (it is reserved for the Store). A tag v0.1.0 gives 0.1.0.0, which
    Partner Center rejects on upload.

  A build from a tag stops here on either problem. A manual run from a branch only warns,
  which is enough to try the pipeline; without the identity it packs with the side-load one.

  Writes `configured=true|false` (the identity) to GITHUB_OUTPUT.
  check-store-identity.test.ps1 covers the cases; CI runs it, because this script itself only
  runs when a release is built.
#>
$ErrorActionPreference = "Stop"
$names = @("MSIX_IDENTITY_NAME", "MSIX_PUBLISHER", "MSIX_PUBLISHER_DISPLAY_NAME")
$missing = @($names | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
$problem = ""
if ($missing.Count -gt 0) {
  $problem = "repository variable(s) not set: $($missing -join ', ')"
} elseif (-not $env:MSIX_PUBLISHER.StartsWith("CN=")) {
  $problem = "MSIX_PUBLISHER is '$($env:MSIX_PUBLISHER)', but Package/Identity/Publisher in Partner Center starts with 'CN='"
}
$configured = ($problem -eq "")
if ($env:GITHUB_OUTPUT) { "configured=$($configured.ToString().ToLower())" >> $env:GITHUB_OUTPUT }
$fix = "Copy the three values from Partner Center (Product management, Product identity) into the repository variables (Settings, Secrets and variables, Actions, Variables); see docs/store/README.md."
$versionProblem = ""
if ($env:MSIX_VERSION -and $env:MSIX_VERSION -notmatch '^[1-9]\d*\.\d+\.\d+\.0$') {
  $versionProblem = "package version $($env:MSIX_VERSION) is not accepted by the Store: the first part must be 1 or higher and the fourth 0. Release from a tag v1.0.0 or later"
}
if ($configured) { Write-Host "Partner Center identity: $($env:MSIX_IDENTITY_NAME) / $($env:MSIX_PUBLISHER) / $($env:MSIX_PUBLISHER_DISPLAY_NAME)" }
if ($configured -and -not $versionProblem) { exit 0 }
if ($env:GITHUB_REF_TYPE -eq "tag") {
  if (-not $configured) { Write-Host "::error title=Partner Center identity not configured::$problem. A release must not carry a Store package with the side-load identity. $fix" }
  if ($versionProblem) { Write-Host "::error title=Store rejects this package version::$versionProblem." }
  exit 1
}
if (-not $configured) { Write-Host "::warning title=Store MSIX cannot be submitted::$problem. This run packs the Store MSIX with the side-load identity. $fix" }
if ($versionProblem) { Write-Host "::warning title=Store MSIX cannot be submitted::$versionProblem." }
exit 0
