# Installs the freshly built side-load MSIX, checks it is registered, that the MCP bridge answers
# through the app execution alias and that the app launches, then removes it.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repo "target"
$msix = Get-Content (Join-Path $target "msix-path.txt")
Import-Certificate -FilePath (Join-Path $target "meshkeep-dev.cer") -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
Add-AppxPackage -Path $msix
$pkg = Get-AppxPackage -Name "DevSym.Meshkeep"
if (-not $pkg) { throw "package not registered after Add-AppxPackage" }
Write-Host "Installed $($pkg.PackageFullName) at $($pkg.InstallLocation)"
if (!(Test-Path (Join-Path $pkg.InstallLocation "meshkeep.exe"))) { throw "exe missing in package" }
if (!(Test-Path (Join-Path $pkg.InstallLocation "resources.pri"))) { throw "resources.pri missing in package (icons would fall back to the 100 % files)" }

# The stdio MCP bridge has to be reachable through the app execution alias (ADR-0004): that
# is the command Settings hands to MCP clients in a packaged build. Started the way a client
# does it, with pipes on stdin and stdout, against a port nothing listens on: the bridge must
# answer the request with a JSON-RPC error and exit when stdin closes.
$alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\meshkeep.exe"
$psi = [System.Diagnostics.ProcessStartInfo]::new($alias)
$psi.Arguments = "--mcp http://127.0.0.1:9/mcp no-token"
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$bridge = [System.Diagnostics.Process]::Start($psi)
$bridge.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"ping"}')
$bridge.StandardInput.Close()
$answer = $bridge.StandardOutput.ReadToEndAsync()
if (-not $bridge.WaitForExit(60000)) {
  $bridge.Kill()
  throw "the MCP bridge started through $alias did not exit after stdin closed"
}
$reply = $answer.Result.Trim()
Write-Host "Bridge through the alias answered: $reply"
$json = $reply | ConvertFrom-Json
if ($json.id -ne 1 -or -not $json.error) { throw "unexpected answer from the MCP bridge through the alias: '$reply'" }

$aumid = "$($pkg.PackageFamilyName)!Meshkeep"
Start-Process "explorer.exe" "shell:AppsFolder\$aumid"
Start-Sleep -Seconds 10
$proc = Get-Process -Name "meshkeep" -ErrorAction SilentlyContinue
if (-not $proc) { throw "packaged app did not start (no meshkeep process)" }
Write-Host "Packaged app running: PID $($proc.Id)"
$proc | Stop-Process -Force
Remove-AppxPackage -Package $pkg.PackageFullName
Write-Host "Side-load round trip OK"
