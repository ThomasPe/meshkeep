# Runs stamp-manifest.ps1 the way build-msix.ps1 calls it and reads the result back as XML.
# CI runs this on every push, without a built exe and without the Windows SDK: what the
# stamped manifest says about Windows is checked by nothing else before Partner Center does.
$ErrorActionPreference = "Stop"
$stamp = Join-Path $PSScriptRoot "stamp-manifest.ps1"
$source = Join-Path $PSScriptRoot "AppxManifest.xml"
$shell = (Get-Process -Id $PID).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("meshkeep-stamp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null

$store = @{
  Version              = "1.0.0.0"
  IdentityName         = "12345DevSym.Meshkeep"
  Publisher            = "CN=0A1B2C3D-0000-4000-8000-000000000000"
  PublisherDisplayName = "DevSym Store"
}

# One run in a child process, like a step of the workflow: exit code and what it printed.
function Invoke-Stamp([hashtable]$values, [string]$from = $source) {
  $out = Join-Path $work ([guid]::NewGuid().ToString("N") + ".xml")
  $log = (& $shell -NoProfile -File $stamp -Out $out -Source $from -Version $values.Version -IdentityName $values.IdentityName `
      -Publisher $values.Publisher -PublisherDisplayName $values.PublisherDisplayName 2>&1 | Out-String)
  # An error is printed wrapped to the width of the console, with "|" in front of every line.
  $flat = $log -replace '\s*\r?\n\s*\|\s*', ' '
  return @{ Code = $LASTEXITCODE; Log = $flat; Out = $out }
}

# Every attribute and every text of a manifest as "path@name=value" lines, so that two
# manifests are compared by what they say and not by how they are laid out.
function Add-Facts($node, [string]$at, [System.Collections.Generic.List[string]]$facts) {
  # LocalName, not Name: on an element with a Name attribute PowerShell answers with the attribute.
  $here = "$at/$($node.LocalName)"
  foreach ($a in $node.Attributes) { $facts.Add("$here@$($a.LocalName)=$($a.Value)") }
  $elements = @($node.ChildNodes | Where-Object { $_.NodeType -eq "Element" })
  if ($elements.Count -eq 0 -and $node.InnerText.Trim()) { $facts.Add("$here=$($node.InnerText.Trim())") }
  foreach ($child in $elements) { Add-Facts $child $here $facts }
}
function Get-Facts([string]$path) {
  [xml]$doc = Get-Content $path -Raw
  $facts = [System.Collections.Generic.List[string]]::new()
  Add-Facts $doc.DocumentElement "" $facts
  return $facts
}

$script:failed = 0
function Expect([string]$case, [bool]$ok, [string]$detail = "") {
  if ($ok) {
    Write-Host "ok   $case"
  } else {
    $script:failed++
    Write-Host "FAIL $case"
    if ($detail) { Write-Host $detail }
  }
}

try {
  $r = Invoke-Stamp $store
  Expect "the Store values stamp without an error" ($r.Code -eq 0) $r.Log
  [xml]$stamped = Get-Content $r.Out -Raw
  [xml]$original = Get-Content $source -Raw
  $identity = $stamped.Package.Identity
  $identityOk = $identity.Version -eq "1.0.0.0" -and $identity.Name -eq $store.IdentityName -and $identity.Publisher -eq $store.Publisher
  Expect "the package carries the version, name and publisher it was given" $identityOk "Identity: $($identity.OuterXml)"
  Expect "the publisher display name is the one given" ($stamped.Package.Properties.PublisherDisplayName -eq "DevSym Store")

  $family = $stamped.Package.Dependencies.TargetDeviceFamily
  $wanted = $original.Package.Dependencies.TargetDeviceFamily
  $windowsOk = $family.MinVersion -eq $wanted.MinVersion -and $family.MaxVersionTested -eq $wanted.MaxVersionTested -and $family.MinVersion -ne "1.0.0.0"
  Expect "the Windows versions stay what the manifest says (MinVersion is not the package version)" $windowsOk "TargetDeviceFamily: $($family.OuterXml)"
  Expect "the manifest in the repository targets a Windows the Store accepts" ([version]$wanted.MinVersion -gt [version]"10.0.17134.0")

  # Nothing but the four stamped values may differ from the manifest in the repository.
  $changed = @(Compare-Object (Get-Facts $source) (Get-Facts $r.Out) | Where-Object SideIndicator -eq "=>" | ForEach-Object InputObject | Sort-Object)
  $expected = @(
    "/Package/Identity@Name=$($store.IdentityName)",
    "/Package/Identity@Publisher=$($store.Publisher)",
    "/Package/Identity@Version=1.0.0.0",
    "/Package/Properties/PublisherDisplayName=DevSym Store"
  ) | Sort-Object
  Expect "only version, name, publisher and display name change" (($changed -join "`n") -eq ($expected -join "`n")) ("changed:`n" + ($changed -join "`n"))

  $special = $store.Clone()
  $special.PublisherDisplayName = "Miller & Sons <3D>"
  $r = Invoke-Stamp $special
  $name = if ($r.Code -eq 0) { ([xml](Get-Content $r.Out -Raw)).Package.Properties.PublisherDisplayName } else { "" }
  Expect "a display name with & and < survives as text" ($name -eq "Miller & Sons <3D>") $r.Log

  $three = $store.Clone()
  $three.Version = "1.0.0"
  $r = Invoke-Stamp $three
  Expect "a version with three parts is refused" ($r.Code -ne 0 -and $r.Log -match "four parts" -and -not (Test-Path $r.Out)) $r.Log

  # A manifest that targets Windows 10 1803: the Store would refuse the package.
  $old = Join-Path $work "old-windows.xml"
  (Get-Content $source -Raw) -replace 'MinVersion="[^"]+"', 'MinVersion="10.0.17134.0"' | Set-Content $old -Encoding UTF8
  $r = Invoke-Stamp $store $old
  Expect "a manifest for Windows 10.0.17134.0 or older is refused" ($r.Code -ne 0 -and $r.Log -match "above 10\.0\.17134\.0" -and -not (Test-Path $r.Out)) $r.Log
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($script:failed -gt 0) { throw "$($script:failed) case(s) of the manifest stamp failed" }
Write-Host "Manifest stamp: all cases OK"
# The last child exited with 1 on purpose; without this the calling step would inherit it.
exit 0
