# Stage native Windows sidecars for Tauri's externalBin bundling.
#
# Mirrors the Unix scripts/prepare-*-sidecar.sh flow, but stages real
# `<stem>-<triple>.exe` files and validates each as a PE image of the target
# architecture instead of relying on chmod/-x (a no-op on Windows). Catch is
# intentionally absent: it is macOS-only and is excluded from the Windows
# externalBin contract via src-tauri/tauri.windows.conf.json, so staging a
# fake shell-script "binary" here is forbidden and unnecessary.
#
# The same script is invoked by dev and release. -Triple makes the target an
# explicit shared input: the caller passes the exact triple it hands Tauri via
# --target so the staged `<stem>-<triple>.exe` names cannot diverge from what
# Tauri resolves. When omitted it defaults to the Rust host triple, matching a
# hostless `tauri build`.
param(
    [string]$Triple
)

$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-BerdRepoRoot)
Update-SessionPathFromRegistry
Assert-MsvcEnvironment

# Tauri resolves externalBin against the build's target triple. Prefer the
# explicit -Triple the caller hands `tauri build --target`; fall back to the
# Rust host triple for a hostless build.
if ([string]::IsNullOrWhiteSpace($Triple)) {
    $Triple = Get-RustHostTriple
}
if ([string]::IsNullOrWhiteSpace($Triple)) {
    throw "Could not determine the Rust target triple for sidecar staging."
}
if ($null -eq (Get-WindowsTripleMachine -Triple $Triple)) {
    throw "Triple '$Triple' is not a supported Windows sidecar target."
}
Write-WindowsDevInfo "Staging Windows sidecars for target: $Triple"

$binDir = Join-Path (Join-Path (Get-BerdRepoRoot) "src-tauri") "binaries"

# ── goosed ───────────────────────────────────────────────────
# Reuse the same pinned managed Goose binary dev/release already build; a
# GOOSE_BIN override takes precedence exactly as the Unix script honours it.
# Either source is identity-probed (`goose --version`) before staging so a
# binary that is not actually Goose — a wrong or tampered file that still
# happens to be a loadable PE — is rejected rather than shipped.
$gooseBinName = (Get-GooseBackendSettings).Bin
$gooseSource = $env:GOOSE_BIN
if ([string]::IsNullOrWhiteSpace($gooseSource)) {
    $goose = Invoke-EnsureLocalGoose -Action Check
    if (-not $goose.Ready) {
        throw "Pinned Goose binary is not ready. Run 'just setup-windows' first. $($goose.Message)"
    }
    $gooseSource = $goose.BinPath
}
Assert-GooseBinaryIdentity -Path $gooseSource -BinName $gooseBinName
$staged = Stage-WindowsSidecar -SourcePath $gooseSource -Triple $Triple -Stem "goosed" -BinDir $binDir
Write-WindowsDevInfo "Staged Goose sidecar: $staged"

# ── berdctl ──────────────────────────────────────────────────
# Build the workspace crate for the target triple, then stage its .exe. Cargo
# writes to the Tauri target dir the rest of the build shares. Passing --target
# nests the output under the triple, matching the Unix script's behaviour when
# an explicit triple is supplied.
$tauriTargetDir = Get-TauriCargoTargetDir
$env:CARGO_TARGET_DIR = $tauriTargetDir
$hostTriple = Get-RustHostTriple
$cargoArgs = @("build", "-p", "berdctl", "-p", "berd-monitor", "--release")
if ($env:VITE_FEEDBACK -eq "1") {
    $cargoArgs += @("--features", "berdctl/block-feedback")
}
if (-not [string]::IsNullOrWhiteSpace($hostTriple) -and $Triple -ne $hostTriple) {
    $cargoArgs += @("--target", $Triple)
    $berdctlReleaseDir = Join-Path (Join-Path $tauriTargetDir $Triple) "release"
} else {
    $berdctlReleaseDir = Join-Path $tauriTargetDir "release"
}
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList $cargoArgs `
    -WorkingDirectory (Join-Path (Get-BerdRepoRoot) "src-tauri") -Label "cargo build -p berdctl -p berd-monitor --release"
$berdctlSource = Join-Path $berdctlReleaseDir (Get-WindowsExeName "berdctl")
$staged = Stage-WindowsSidecar -SourcePath $berdctlSource -Triple $Triple -Stem "berdctl" -BinDir $binDir
Write-WindowsDevInfo "Staged berdctl sidecar: $staged"

# ── berd-monitor ─────────────────────────────────────────────
$monitorSource = Join-Path $berdctlReleaseDir (Get-WindowsExeName "berd-monitor")
$staged = Stage-WindowsSidecar -SourcePath $monitorSource -Triple $Triple -Stem "berd-monitor" -BinDir $binDir
Write-WindowsDevInfo "Staged berd-monitor sidecar: $staged"

# Catch is deliberately not staged on Windows (see header).
Write-WindowsDevInfo "Skipping Catch sidecar: unsupported on Windows (excluded from externalBin)."
