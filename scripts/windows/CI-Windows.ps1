# Native x64 MSVC CI gate for the managed Node runtime + npm ACP bridge.
#
# Runs the Rust checks that only a real Windows host can exercise: the
# `managed_node` / `managed_acp_tools` module tests (which include the
# `BERD_WS2_NATIVE_GATE` gates that download and execute the real pinned Node
# ZIP and launch a managed bridge by bare name), plus `just tauri-check-windows`
# and Windows clippy. Invoked through `just ci-windows` for local and release
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
# Opt the managed-Node native gates in: they download and execute the real
# pinned Node ZIP and launch a managed bridge, which only a native Windows host
# can do. Off this variable the gates skip.
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

# The two managed-Node modules, including the native gates. Run them as the
# primary crate so a compile break on Windows fails here rather than silently.
Invoke-CargoCheck -ArgumentList @(
    "test", "--lib", "services::managed_node"
) -Label "cargo test managed_node (native gate)"
Invoke-CargoCheck -ArgumentList @(
    "test", "--lib", "services::managed_acp_tools"
) -Label "cargo test managed_acp_tools (native gate)"

# Feature-off check plus Windows clippy, mirroring the justfile Windows gates.
Invoke-CargoCheck -ArgumentList @("check") -Label "cargo check"
Invoke-CargoCheck -ArgumentList @(
    "check", "--features", (Get-BerdAppFeatures)
) -Label "cargo check app features"
Invoke-CargoCheck -ArgumentList @(
    "clippy", "--", "-D", "warnings"
) -Label "cargo clippy"
Invoke-CargoCheck -ArgumentList @(
    "clippy", "--features", (Get-BerdAppFeatures), "--", "-D", "warnings"
) -Label "cargo clippy app features"

Write-Host ""
Write-Host "Windows native CI gate passed." -ForegroundColor Green
