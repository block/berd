# Native x64 MSVC CI gate for the managed Node runtime + npm ACP bridge.
#
# Runs the Rust checks that only a real Windows host can exercise: berdctl's
# Job Object / named-pipe authorization tests, the `managed_node` /
# `managed_acp_tools` module tests (including the native gate that downloads and
# executes the real pinned Node ZIP), plus Windows clippy in the default and app
# feature configurations. Invoked through `just ci-windows` for local and release
# validation.
$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Update-SessionPathFromRegistry
Assert-MsvcEnvironment
Set-Location (Join-Path (Get-BerdRepoRoot) "src-tauri")

$env:CARGO_TARGET_DIR = Get-TauriCargoTargetDir
$env:TAURI_CONFIG = '{"bundle":{"externalBin":[],"resources":[]}}'
# Opt the managed-Node native gate in: it downloads and executes the real pinned
# Node ZIP, which only a native Windows host can do. Off this variable it skips.
$env:BERD_WS2_NATIVE_GATE = "1"
Write-WindowsDevInfo "Using Tauri Cargo target dir: $env:CARGO_TARGET_DIR"

# Invoke cargo directly. `Start-Process -Wait` waits for the full descendant
# tree on Windows; the native Node/npm probes can leave inherited process
# handles alive briefly after the Rust test process exits, wedging the lane
# after cargo has already printed its result.
function Invoke-CargoCheck {
    param(
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Write-WindowsDevInfo $Label
    & cargo @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

Invoke-CargoCheck -ArgumentList @("fmt", "--check") -Label "cargo fmt --check"

# Both managed-Node modules share this test-name prefix. Run them in one process
# so the Windows test binary is linked once. The live ACP bridge install has no
# equivalent macOS/Linux CI coverage, so leave it for targeted manual runs.
Invoke-CargoCheck -ArgumentList @(
    "test", "-p", "tauri-plugin-berdctl", "--features", "server"
) -Label "cargo test berdctl plugin"

Invoke-CargoCheck -ArgumentList @(
    "test", "--lib", "services::managed_", "--", "--skip",
    "native_gate_installs_and_launches_a_bridge_by_bare_name"
) -Label "cargo test managed services"

# Clippy compiles both configurations, so separate `cargo check` calls only
# repeat the same compile coverage.
Invoke-CargoCheck -ArgumentList @(
    "clippy", "--", "-D", "warnings"
) -Label "cargo clippy"
Invoke-CargoCheck -ArgumentList @(
    "clippy", "--features", (Get-BerdAppFeatures), "--", "-D", "warnings"
) -Label "cargo clippy app features"

Write-Host ""
Write-Host "Windows native CI gate passed." -ForegroundColor Green
