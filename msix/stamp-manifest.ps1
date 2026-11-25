<#
.SYNOPSIS
  Writes the package manifest of one build: msix/AppxManifest.xml with the package version
  and the identity stamped in. build-msix.ps1 calls it; it is a script of its own so that CI
  can test it without a built exe and without the Windows SDK (stamp-manifest.test.ps1).

  The values go in through the XML document, not through a text replacement. The replacement
  this script took over from build-msix.ps1 was `Version="a.b.c.d"`, which also matches inside
  `MinVersion="10.0.17763.0"`: the 1.0.0 package claimed to run on Windows 1.0.0.0. Windows
  installs such a package when it is side-loaded, so the round trip in CI passed, and
  Partner Center refused it on upload.

.EXAMPLE
  ./msix/stamp-manifest.ps1 -Out target/msix-layout/AppxManifest.xml -Version 1.0.0.0 `
    -IdentityName "DevSym.Meshkeep" -Publisher "CN=DevSym Dev" -PublisherDisplayName "DevSym"
#>
param(
  [Parameter(Mandatory)][string]$Out,
  [Parameter(Mandatory)][string]$Version,
  [Parameter(Mandatory)][string]$IdentityName,
  [Parameter(Mandatory)][string]$Publisher,
  [Parameter(Mandatory)][string]$PublisherDisplayName,
  [string]$Source = (Join-Path $PSScriptRoot "AppxManifest.xml")
)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Version must have four parts (got '$Version')" }

# .NET resolves a relative path against the process directory, not against the location of
# the PowerShell session.
$Source = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Source)
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)

$doc = [System.Xml.XmlDocument]::new()
$doc.PreserveWhitespace = $true
$doc.Load($Source)
$ns = [System.Xml.XmlNamespaceManager]::new($doc.NameTable)
$ns.AddNamespace("m", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")

$identity = $doc.SelectSingleNode("/m:Package/m:Identity", $ns)
if (-not $identity) { throw "no Package/Identity in $Source" }
$identity.SetAttribute("Name", $IdentityName)
$identity.SetAttribute("Publisher", $Publisher)
$identity.SetAttribute("Version", $Version)

$display = $doc.SelectSingleNode("/m:Package/m:Properties/m:PublisherDisplayName", $ns)
if (-not $display) { throw "no Package/Properties/PublisherDisplayName in $Source" }
$display.InnerText = $PublisherDisplayName

# Partner Center takes an MSIX only when every device family it names starts above Windows 10
# 1803: "You cannot upload msix/msixbundle/msixupload packages that targets Windows
# MinVersion <= 10.0.17134.0". Nothing on a developer machine or in CI notices a lower value.
$families = $doc.SelectNodes("/m:Package/m:Dependencies/m:TargetDeviceFamily", $ns)
if ($families.Count -eq 0) { throw "no Package/Dependencies/TargetDeviceFamily in $Source" }
foreach ($family in $families) {
  $min = $family.GetAttribute("MinVersion")
  if ($min -notmatch '^\d+\.\d+\.\d+\.\d+$' -or [version]$min -le [version]"10.0.17134.0") {
    throw "TargetDeviceFamily $($family.GetAttribute('Name')) has MinVersion '$min'; the Store accepts MSIX packages above 10.0.17134.0 only"
  }
}

$settings = [System.Xml.XmlWriterSettings]::new()
$settings.Encoding = [System.Text.UTF8Encoding]::new($false)
$writer = [System.Xml.XmlWriter]::Create($Out, $settings)
try { $doc.Save($writer) } finally { $writer.Dispose() }
