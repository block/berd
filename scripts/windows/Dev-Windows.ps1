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
Initialize-FnmEnvironment | Out-Null
Import-BlockNpmUserEnvironment
Update-SessionPathFromRegistry

if ([string]::IsNullOrWhiteSpace($env:GOOSE_BIN)) {
    & (Join-Path $PSScriptRoot "Setup-Windows.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Setup-Windows.ps1 failed with exit code $LASTEXITCODE."
    }
} else {
    Write-WindowsDevInfo "Using explicitly set GOOSE_BIN: $env:GOOSE_BIN"
    # Mirror unix `just dev`: a GOOSE_BIN override skips the managed Goose
    # build but still needs pnpm deps, the SDK build, and hooks.
    & (Join-Path $PSScriptRoot "Setup-Windows.ps1") -SkipGooseBuild
    if ($LASTEXITCODE -ne 0) {
        throw "Setup-Windows.ps1 -SkipGooseBuild failed with exit code $LASTEXITCODE."
    }
}
$pnpm = Get-PnpmCommand
if ([string]::IsNullOrWhiteSpace($pnpm)) {
    throw "pnpm is not available. Run 'just bootstrap-windows install', open a new PowerShell, then retry."
}

$env:VITE_PORT = [string](Get-StableVitePort)
$env:VITE_DESIGN_SYSTEM_EXPLORER = "1"
if ([string]::IsNullOrWhiteSpace($env:RUST_LOG)) {
    $env:RUST_LOG = "perf=debug,info"
}
$tauriCargoTargetDir = Get-TauriCargoTargetDir
$env:CARGO_TARGET_DIR = $tauriCargoTargetDir
Write-WindowsDevInfo "Using Vite port: $env:VITE_PORT"
Write-WindowsDevInfo "Using Tauri Cargo target dir: $env:CARGO_TARGET_DIR"

$version = Resolve-AppVersion
$env:VITE_APP_VERSION = $version.RichVersion
Write-WindowsDevInfo "Using app version: $($version.Version) ($($version.RichVersion))"

Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "-p", "berdctl") -WorkingDirectory (Join-Path (Get-BerdRepoRoot) "src-tauri") -Label "cargo build berdctl"
$env:BERDCTL_BIN = Join-Path (Join-Path $env:CARGO_TARGET_DIR "debug") "berdctl.exe"
if (-not (Test-Path $env:BERDCTL_BIN -PathType Leaf)) {
    throw "Expected berdctl.exe at $env:BERDCTL_BIN after cargo build."
}
Write-WindowsDevInfo "Using berdctl CLI: $env:BERDCTL_BIN"

if ([string]::IsNullOrWhiteSpace($env:GOOSE_BIN)) {
    $result = Invoke-EnsureLocalGoose -Action Check
    if (-not $result.Ready) {
        throw "Local Goose binary is not ready. Run 'just setup-windows' first."
    }
    $env:GOOSE_BIN = $result.BinPath
    Write-WindowsDevInfo "Using local Goose binary: $env:GOOSE_BIN"
}

$env:CARGO_TARGET_DIR = $tauriCargoTargetDir

# bb.exe is intentionally not staged: the bb CLI resource is only mapped and
# resolved on macOS (tauri.macos.conf.json + commands/cli.rs), so building it
# here would spend minutes producing an artifact the Windows app never reads.

$distroDir = Join-Path (Get-BerdRepoRoot) "distro"
if ([string]::IsNullOrWhiteSpace($env:GOOSE_DISTRO_DIR) -and (Test-Path $distroDir -PathType Container)) {
    $env:GOOSE_DISTRO_DIR = $distroDir
    Write-WindowsDevInfo "Using distro dir: $env:GOOSE_DISTRO_DIR"
}

# Fail fast if a previous run's vite survived: tauri only kills its direct
# child on Windows (cmd -> pnpm.cmd -> node), so an abnormal exit can leave
# vite holding this checkout's deterministic port and --strictPort would die
# mid-startup with a less actionable error.
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $portListener = Get-NetTCPConnection -LocalPort ([int]$env:VITE_PORT) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $portListener) {
        throw "Port $env:VITE_PORT is already in use by PID $($portListener.OwningProcess) (likely an orphaned vite from a previous dev run). Stop it with: Stop-Process -Id $($portListener.OwningProcess)"
    }
}

# Use the resolved shim's bare name (pnpm.cmd / pnpm.exe): it is on PATH by
# construction (Get-PnpmCommand found it there), and a bare name sidesteps
# cmd.exe quote-stripping issues that a full path with spaces would hit inside
# tauri's beforeDevCommand.
$pnpmShimName = Split-Path -Leaf $pnpm
$devConfig = @{
    version = $version.Version
    build = @{
        devUrl = "http://localhost:$env:VITE_PORT"
        beforeDevCommand = @{
            script = "$pnpmShimName exec vite --port $env:VITE_PORT --strictPort"
            cwd = ".."
            wait = $false
        }
    }
}
$devConfigPath = Join-Path (Resolve-GooseDevPaths).DevRoot "tauri-dev-windows.config.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $devConfigPath) | Out-Null
# Write without a BOM: Windows PowerShell's `Set-Content -Encoding UTF8` adds
# one, and Tauri's serde-based --config parsing rejects BOM-prefixed JSON.
$devConfigJson = $devConfig | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($devConfigPath, $devConfigJson, [System.Text.UTF8Encoding]::new($false))
Write-WindowsDevInfo "Using Tauri dev config: $devConfigPath"

Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @(
    "exec", "tauri", "dev",
    "--features", (Get-BerdAppFeatures),
    "--config", "src-tauri/tauri.dev.conf.json",
    "--config", $devConfigPath
) -Label "pnpm exec tauri dev"
