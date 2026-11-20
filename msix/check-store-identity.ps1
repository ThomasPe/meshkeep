<#
.SYNOPSIS
  Release gate for the Store MSIX: are the three Partner Center identity values configured?

  release.yml runs this before anything is built. The values come from the repository
  variables MSIX_IDENTITY_NAME, MSIX_PUBLISHER and MSIX_PUBLISHER_DISPLAY_NAME (see
  docs/store/README.md, "Partner Center identity"). Without them the "Store" package would
  carry the side-load identity, and Partner Center rejects that on upload, so a build from a
  tag stops here. A manual run from a branch only warns and packs with the side-load
  identity, which is enough to try the pipeline.

  Writes `configured=true|false` to GITHUB_OUTPUT. check-store-identity.test.ps1 covers the
  cases; CI runs it, because this script itself only runs when a release is built.
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
if ($configured) {
  Write-Host "Partner Center identity: $($env:MSIX_IDENTITY_NAME) / $($env:MSIX_PUBLISHER) / $($env:MSIX_PUBLISHER_DISPLAY_NAME)"
  exit 0
}
$fix = "Copy the three values from Partner Center (Product management, Product identity) into the repository variables (Settings, Secrets and variables, Actions, Variables); see docs/store/README.md."
if ($env:GITHUB_REF_TYPE -eq "tag") {
  Write-Host "::error title=Partner Center identity not configured::$problem. A release must not carry a Store package with the side-load identity. $fix"
  exit 1
}
Write-Host "::warning title=Store MSIX cannot be submitted::$problem. This run packs the Store MSIX with the side-load identity. $fix"
exit 0
