<#
.SYNOPSIS
  Packs the Store-flavored release build (no updater) into an MSIX. Tauri has no native MSIX
  output; this is the thin layer a Store pipeline needs on top of `tauri build`.

  Side-load (default): signs with a self-signed certificate whose subject equals the
  manifest Publisher. Store (-Store): leaves the package unsigned (the Store signs on
  submission) and stamps the Partner Center identity passed in.

.EXAMPLE
  npm run tauri:build:store
  ./msix/build-msix.ps1 -Version 0.1.0.0
  ./msix/build-msix.ps1 -Store -IdentityName "12345DevSym.Meshkeep" -Publisher "CN=0A1B2C3D-...." -Version 0.1.0.0
#>
param(
  [string]$Version = "",
  [string]$IdentityName = "DevSym.Meshkeep",
  [string]$Publisher = "CN=DevSym Dev",
  [string]$PublisherDisplayName = "DevSym",
  [switch]$Store,
  [string]$CertPassword = "meshkeep-dev"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repo "target"
$exe = Join-Path $target "release\meshkeep.exe"
if (!(Test-Path $exe)) { throw "Release binary not found: $exe. Run 'npm run tauri:build:store' first." }
if (-not $Version) {
  $pkg = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
  $Version = "$($pkg.version).0"
}
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Version must have four parts (got '$Version')" }

function Find-SdkTool([string]$name) {
  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  $tool = Get-ChildItem -Path $kits -Recurse -Filter $name -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $tool) { throw "$name not found under $kits (install the Windows 10/11 SDK)" }
  return $tool.FullName
}
$makeappx = Find-SdkTool "makeappx.exe"
$makepri = Find-SdkTool "makepri.exe"

# 1. Layout
$layout = Join-Path $target "msix-layout"
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Path $layout | Out-Null
Copy-Item $exe $layout
Copy-Item -Recurse (Join-Path $PSScriptRoot "Assets") (Join-Path $layout "Assets")
$manifest = Join-Path $layout "AppxManifest.xml"
# Version and identity go in through stamp-manifest.ps1, which touches nothing else and
# refuses a manifest the Store would not take.
& (Join-Path $PSScriptRoot "stamp-manifest.ps1") -Out $manifest -Version $Version -IdentityName $IdentityName `
  -Publisher $Publisher -PublisherDisplayName $PublisherDisplayName

# 1b. resources.pri. The manifest names `Assets\Square44x44Logo.png`; which file Windows
#     shows for it (scale-200, targetsize-24_altform-unplated, ...) is looked up in this
#     index. Without it only the unqualified 100 % files are ever used: blurry on a scaled
#     display, and the taskbar icon sits on a plate.
$priConfig = Join-Path $target "msix-priconfig.xml"
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed ($LASTEXITCODE)" }
# createconfig plans one resource pack per language and scale (for bundles). This is a
# single package, so everything goes into the one resources.pri.
[xml]$cfg = Get-Content $priConfig -Raw
$packaging = $cfg.SelectSingleNode("//packaging")
if ($packaging) { $packaging.ParentNode.RemoveChild($packaging) | Out-Null }
$cfg.Save($priConfig)
$pri = Join-Path $layout "resources.pri"
& $makepri new /pr $layout /cf $priConfig /mn $manifest /of $pri /o
if ($LASTEXITCODE -ne 0) { throw "makepri new failed ($LASTEXITCODE)" }
$priFiles = @(Get-ChildItem $layout -Filter "*.pri")
if ($priFiles.Count -ne 1) { throw "expected one resources.pri in the layout, found: $($priFiles.Name -join ', ')" }
# The index has to know the qualified variants, or the step above was for nothing.
$priDump = Join-Path $target "msix-pri-dump.xml"
& $makepri dump /if $pri /of $priDump /o
if ($LASTEXITCODE -ne 0) { throw "makepri dump failed ($LASTEXITCODE)" }
$dump = Get-Content $priDump -Raw
foreach ($asset in "Square44x44Logo.scale-200.png", "Square44x44Logo.targetsize-24_altform-unplated.png", "Square44x44Logo.targetsize-24_altform-lightunplated.png", "Square150x150Logo.scale-400.png") {
  if ($dump -notmatch [regex]::Escape($asset)) { throw "resources.pri does not index $asset (see $priDump)" }
}

# 2. Pack
$suffix = if ($Store) { "store" } else { "sideload" }
$msix = Join-Path $target "Meshkeep_${Version}_x64_$suffix.msix"
if (Test-Path $msix) { Remove-Item -Force $msix }
& $makeappx pack /d $layout /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }

if ($Store) {
  Write-Host "MSIX (unsigned, for Partner Center upload): $msix"
  "$msix" | Set-Content (Join-Path $target "msix-path.txt")
  exit 0
}

# 3. Self-signed cert whose subject equals the manifest Publisher (required for side-loading).
$signtool = Find-SdkTool "signtool.exe"
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName "Meshkeep (dev side-load)" `
    -CertStoreLocation "Cert:\CurrentUser\My" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
}
$pfx = Join-Path $target "meshkeep-dev.pfx"
$cer = Join-Path $target "meshkeep-dev.cer"
$pwd = ConvertTo-SecureString -String $CertPassword -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null

# 4. Sign
& $signtool sign /fd SHA256 /f $pfx /p $CertPassword $msix
if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }

Write-Host "MSIX : $msix"
Write-Host "Cert : $cer  (import into Trusted People before Add-AppxPackage on another machine)"
"$msix" | Set-Content (Join-Path $target "msix-path.txt")
