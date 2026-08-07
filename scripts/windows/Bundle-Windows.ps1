param(
    [ValidateSet("nsis", "msi")][string]$Bundle = "nsis",
    [AllowNull()][AllowEmptyString()][string]$Version,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Update-SessionPathFromRegistry
Assert-MsvcEnvironment
Assert-LibClangEnvironment
Initialize-FnmEnvironment | Out-Null
Import-BlockNpmUserEnvironment
Update-SessionPathFromRegistry

$pnpm = Get-PnpmCommand
if ([string]::IsNullOrWhiteSpace($pnpm)) {
    throw "pnpm is not available. Run 'just bootstrap-windows install', open a new PowerShell, then retry."
}
Assert-PnpmReady

$repoRoot = Get-BerdRepoRoot
Set-Location $repoRoot
$targetTriple = "x86_64-pc-windows-msvc"
$targetDir = Get-TauriCargoTargetDir
$binaryDir = Join-Path $repoRoot "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $binaryDir | Out-Null
$env:CARGO_TARGET_DIR = $targetDir

if (-not $SkipDependencyInstall) {
    Write-WindowsDevInfo "Installing locked JavaScript dependencies."
    Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("install", "--frozen-lockfile") -Label "pnpm install --frozen-lockfile"
}

# The workspace SDK exports generated files from dist/. A clean checkout has no
# dist directory, so build it before the application's beforeBuildCommand runs.
Write-WindowsDevInfo "Building the workspace Goose SDK."
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("--filter", "@aaif/goose-sdk", "build") -Label "Goose SDK build"

# Stage the exact pinned Goose checkout used by Windows development. Building
# rather than accepting an arbitrary PATH binary keeps the bundle reproducible.
$oldGooseMode = $env:GOOSE_DEV_MODE
try {
    $env:GOOSE_DEV_MODE = "required"
    $goose = Invoke-EnsureLocalGoose -Action Build
} finally {
    $env:GOOSE_DEV_MODE = $oldGooseMode
}
if (-not $goose.Ready -or [string]::IsNullOrWhiteSpace($goose.BinPath)) {
    throw "Pinned Goose sidecar is not ready: $($goose.Message)"
}
# Invoke-EnsureLocalGoose points CARGO_TARGET_DIR at the managed Goose cache.
# Restore the app target before building berdctl and invoking Tauri.
$env:CARGO_TARGET_DIR = $targetDir
$gooseOut = Join-Path $binaryDir "goosed-$targetTriple.exe"
Copy-Item -Force $goose.BinPath $gooseOut
Write-WindowsDevInfo "Staged Goose sidecar: $gooseOut"

Write-WindowsDevInfo "Building and staging berdctl."
Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "--manifest-path", "src-tauri\Cargo.toml", "-p", "berdctl", "--release", "--target", $targetTriple) -Label "cargo build berdctl"
$berdctlBuilt = Join-Path $targetDir "$targetTriple\release\berdctl.exe"
$berdctlOut = Join-Path $binaryDir "berdctl-$targetTriple.exe"
Copy-Item -Force $berdctlBuilt $berdctlOut

# Catch is macOS-only, but Tauri resolves every configured externalBin on every
# target. Stage a real Windows executable that fails explicitly if invoked.
$stubSource = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-catch-stub-" + [Guid]::NewGuid().ToString("N") + ".rs")
try {
    Set-Content -Path $stubSource -Encoding UTF8 -Value @'
fn main() {
    eprintln!("The Catch sidecar is only supported on macOS.");
    std::process::exit(1);
}
'@
    $catchOut = Join-Path $binaryDir "catch-$targetTriple.exe"
    & rustc --edition 2021 -C opt-level=z -C strip=symbols $stubSource -o $catchOut
    if ($LASTEXITCODE -ne 0) {
        throw "Catch Windows stub build failed with exit code $LASTEXITCODE."
    }
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $stubSource
}

Write-WindowsDevInfo "Resolving application version from Git metadata."
$appVersion = Resolve-AppVersion $Version
Write-WindowsDevInfo "Building Berd $($appVersion.Version) ($($appVersion.RichVersion))."
$configPath = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-tauri-windows-" + [Guid]::NewGuid().ToString("N") + ".json")
$schemaPath = Join-Path $repoRoot "src-tauri\gen\schemas\windows-schema.json"
$schemaBackup = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-windows-schema-" + [Guid]::NewGuid().ToString("N") + ".json")
$schemaExisted = Test-Path -LiteralPath $schemaPath
if ($schemaExisted) {
    Copy-Item -LiteralPath $schemaPath -Destination $schemaBackup
}
try {
    @{
        version = $appVersion.Version
        bundle = @{ targets = @($Bundle) }
        plugins = @{ updater = @{ active = $false } }
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8

    $env:VITE_AUTH_GATE = "0"
    $env:VITE_APP_VERSION = $appVersion.RichVersion
    Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("exec", "tauri", "build", "--features", "berdctl", "--target", $targetTriple, "--bundles", $Bundle, "--config", $configPath) -Label "Windows $Bundle bundle"
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $configPath
    if ($schemaExisted) {
        Copy-Item -Force -LiteralPath $schemaBackup -Destination $schemaPath
    } else {
        Remove-Item -Force -ErrorAction SilentlyContinue $schemaPath
    }
    Remove-Item -Force -ErrorAction SilentlyContinue $schemaBackup
}

$bundleDir = Join-Path $targetDir "$targetTriple\release\bundle\$Bundle"
Write-Host ""
Write-Host "Windows bundle ready: $bundleDir" -ForegroundColor Green
