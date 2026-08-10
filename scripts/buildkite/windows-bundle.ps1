# Buildkite lane: exercise the native Windows bundle path end to end.
#
# Runs on a Windows agent and proves the Windows externalBin contract the Unix
# lanes cannot: native staging of real *-<triple>.exe sidecars (no Catch stub)
# and a `tauri build --bundles nsis` over the RFC 7386 merged config. Fails the
# build if the NSIS installer or the staged sidecars are missing.
$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Set-Location (Join-Path $PSScriptRoot "..\..")
Import-Module (Join-Path (Get-Location) "scripts/windows/WindowsDev.psm1") -Force -DisableNameChecking

# Focused helper tests first: staging, PE validation, and the merged
# externalBin / bundle-dispatch contract. Each child script runs as a native
# process (Invoke-WindowsChildScript) so its real exit code is captured; an
# in-process `& script.ps1` leaves $LASTEXITCODE unset on success and would
# false-fail this lane before it ever reached setup or the bundle.
Invoke-WindowsChildScript -ScriptPath (Join-Path (Get-Location) "scripts/windows/Test-WindowsDev.ps1") -Label "Test-WindowsDev.ps1"

# Native prerequisites + pinned Goose build, then enter the same public bundle
# recipe developers use. The recipe owns dispatch to Bundle-Windows.ps1; CI must
# not maintain a second direct entry point that can drift from it.
Invoke-WindowsChildScript -ScriptPath (Join-Path (Get-Location) "scripts/windows/Setup-Windows.ps1") -Label "Setup-Windows.ps1"
$just = (Get-Command "just" -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($just)) {
    throw "just is not available after Windows setup."
}
Invoke-CheckedCommand -FilePath $just -ArgumentList @("bundle-windows") -Label "just bundle-windows"

# Verify the merged externalBin sidecars were staged and Catch was not.
$triple = Get-RustHostTriple
$binDir = Join-Path (Join-Path (Get-Location) "src-tauri") "binaries"
foreach ($stem in @("goosed", "berdctl")) {
    $expected = Join-Path $binDir (Get-WindowsSidecarName -Stem $stem -Triple $triple)
    if (-not (Test-Path $expected -PathType Leaf)) {
        throw "Expected staged sidecar not found: $expected"
    }
    Write-Host "Staged sidecar present: $expected"
}
$catch = Join-Path $binDir (Get-WindowsSidecarName -Stem "catch" -Triple $triple)
if (Test-Path $catch -PathType Leaf) {
    throw "Catch sidecar must not be staged on Windows: $catch"
}

# Verify an NSIS installer was produced.
$tauriTargetDir = Get-TauriCargoTargetDir
$nsisDir = Join-Path (Join-Path (Join-Path (Join-Path $tauriTargetDir $triple) "release") "bundle") "nsis"
$installer = Get-ChildItem -Path $nsisDir -Filter "*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $installer) {
    throw "No NSIS installer produced under $nsisDir."
}
Write-Host "NSIS installer produced: $($installer.FullName)"

# The Tauri target dir is outside the checkout, so Buildkite's checkout-relative
# artifact_paths cannot see the installer there. Copy the verified installer
# into a stable in-checkout artifact directory the pipeline exports, and assert
# the exported copy exists so a broken copy fails the lane rather than silently
# uploading nothing.
$artifactDir = Get-WindowsBundleArtifactDir
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$exportedInstaller = Join-Path $artifactDir $installer.Name
Copy-Item -Path $installer.FullName -Destination $exportedInstaller -Force
if (-not (Test-Path $exportedInstaller -PathType Leaf)) {
    throw "Failed to export NSIS installer to the checkout artifact dir: $exportedInstaller"
}
Write-Host "NSIS installer exported for artifact upload: $exportedInstaller"
