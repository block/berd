# Build a native Windows Berd bundle with real sidecars staged.
#
# This is the Windows counterpart to the Unix `just bundle` / `bundle-debug`
# recipes. Those recipes run the POSIX prepare-*-sidecar.sh scripts directly,
# which on Windows would look for an extensionless berdctl, stage goosed
# without the .exe suffix, and emit the forbidden Catch shell stub — none of
# which match the tauri.windows.conf.json externalBin contract. This driver
# instead stages through Stage-Sidecar-Windows.ps1 (real *-<triple>.exe files,
# PE-validated, no Catch) and hands Tauri the same explicit target triple so
# the staged names and Tauri's externalBin resolution cannot diverge.
param(
    [ValidateSet("nsis", "msi")][string]$Bundle = "nsis",
    [AllowNull()][AllowEmptyString()][string]$Version,
    [switch]$SkipDependencyInstall,
    [switch]$Debug
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
$env:CARGO_TARGET_DIR = $targetDir

if (-not $SkipDependencyInstall) {
    Write-WindowsDevInfo "Installing locked JavaScript dependencies."
    Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("install", "--frozen-lockfile") -Label "pnpm install --frozen-lockfile"
}

# The workspace SDK exports generated files from dist/. A clean checkout has no
# dist directory, so build it before the application's beforeBuildCommand runs.
Write-WindowsDevInfo "Building the workspace Goose SDK."
Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @("--filter", "@aaif/goose-sdk", "build") -Label "Goose SDK build"

$gooseBuildProfile = if ($Debug) { "debug" } else { "release" }
# Production bundles use optimized Goose; explicit debug bundles retain the
# development profile for iteration speed.
$oldGooseMode = $env:GOOSE_DEV_MODE
$oldGooseBuildProfile = $env:GOOSE_BUILD_PROFILE
try {
    $env:GOOSE_DEV_MODE = "required"
    $env:GOOSE_BUILD_PROFILE = $gooseBuildProfile
    $goose = Invoke-EnsureLocalGoose -Action Build
} finally {
    $env:GOOSE_DEV_MODE = $oldGooseMode
    $env:GOOSE_BUILD_PROFILE = $oldGooseBuildProfile
}
if (-not $goose.Ready -or [string]::IsNullOrWhiteSpace($goose.BinPath)) {
    throw "Pinned Goose sidecar is not ready: $($goose.Message)"
}
# Invoke-EnsureLocalGoose points CARGO_TARGET_DIR at the managed Goose cache.
# Restore the app target before staging berdctl and invoking Tauri.
$env:CARGO_TARGET_DIR = $targetDir

# Stage goosed/berdctl as validated *-<triple>.exe. Catch is macOS-only and is
# excluded from the Windows externalBin overlay rather than replaced by a stub.
$oldGooseBuildProfile = $env:GOOSE_BUILD_PROFILE
try {
    $env:GOOSE_BUILD_PROFILE = $gooseBuildProfile
    Invoke-WindowsChildScript -ScriptPath (Join-Path $PSScriptRoot "Stage-Sidecar-Windows.ps1") `
        -ArgumentList @("-Triple", $targetTriple) -Label "Stage Windows sidecars"
} finally {
    $env:GOOSE_BUILD_PROFILE = $oldGooseBuildProfile
}

Write-WindowsDevInfo "Resolving application version from Git metadata."
$resolvedVersion = Resolve-AppVersion $Version
Write-WindowsDevInfo "Building Berd $($resolvedVersion.Version) ($($resolvedVersion.RichVersion))."

$env:CARGO_TARGET_DIR = $targetDir
$env:BERD_APP_VERSION = $resolvedVersion.RichVersion
$releaseUpdaterEnabled = -not $Debug -and `
    -not [string]::IsNullOrWhiteSpace($env:BERD_RELEASE_CHANNEL) -and `
    $env:BERD_RELEASE_CHANNEL -ne "disabled"
# The native updater config and renderer gate are independent contracts. Keep
# them driven by the same release-channel decision so a packaged updater cannot
# compile a renderer that permanently reports updates unavailable.
$env:VITE_UPDATER_ENABLED = if ($releaseUpdaterEnabled) { "true" } else { "false" }
if ([string]::IsNullOrWhiteSpace($env:VITE_AUTH_GATE)) {
    $env:VITE_AUTH_GATE = "0"
}
if ([string]::IsNullOrWhiteSpace($env:VITE_BYO_KEY_PROVIDERS)) {
    $env:VITE_BYO_KEY_PROVIDERS = "1"
}
$env:VITE_APP_VERSION = $resolvedVersion.RichVersion

$baseFeatures = @("berdctl")
if ($Debug) {
    $baseFeatures += "devtools"
}
$features = Get-BerdAppFeatures -BaseFeatures $baseFeatures

# Build the config overlay. Keep main's bundle target and updater controls;
# debug bundles also fold in the base config with devtools enabled. Write
# without a BOM: Tauri's serde --config parsing rejects BOM-prefixed JSON.
$configPath = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-tauri-{0}.{1}.json" -f ($(if ($Debug) { "debug" } else { "version" }), [System.IO.Path]::GetRandomFileName()))
if ($Debug) {
    if ($Bundle -ne "nsis") {
        throw "Debug Windows bundles currently support only NSIS."
    }
    # Tauri merges overlays with json_patch (RFC 7386), which REPLACES arrays
    # wholesale. Setting devtools on app.windows[0] therefore requires carrying
    # the full base app.windows array (as the Unix recipe does), or the other
    # window props would be dropped. But carrying the full base config also
    # carries its bundle.externalBin (which includes catch) and would REPLACE
    # the Windows overlay's catch-free array — re-breaking the Windows contract.
    # So pin externalBin to the Windows contract in the same overlay.
    $baseConfig = Read-JsonFile (Join-Path (Join-Path (Get-BerdRepoRoot) "src-tauri") "tauri.conf.json")
    $baseConfig.version = $resolvedVersion.RichVersion
    $baseConfig.app.windows[0] | Add-Member -NotePropertyName devtools -NotePropertyValue $true -Force
    $windowsConf = Read-JsonFile (Join-Path (Join-Path (Get-BerdRepoRoot) "src-tauri") "tauri.windows.conf.json")
    $baseConfig.bundle.externalBin = (Get-ObjectValue (Get-ObjectValue $windowsConf "bundle") "externalBin")
    $configJson = $baseConfig | ConvertTo-Json -Depth 32
} else {
    if (-not [string]::IsNullOrWhiteSpace($env:BERD_RELEASE_CHANNEL) -and $env:BERD_RELEASE_CHANNEL -ne "disabled") {
        $releaseConfigPath = Join-Path $repoRoot "src-tauri/tauri.release.conf.json"
        if (-not (Test-Path -LiteralPath $releaseConfigPath -PathType Leaf)) {
            throw "Enabled release builds require $releaseConfigPath. Run pnpm tauri:release:config first."
        }
        $releaseConfig = Read-JsonFile $releaseConfigPath
        $releaseConfig | Add-Member -NotePropertyName version -NotePropertyValue $resolvedVersion.RichVersion -Force
        $releaseConfig.bundle | Add-Member -NotePropertyName targets -NotePropertyValue @($Bundle) -Force
        $configJson = $releaseConfig | ConvertTo-Json -Depth 32
    } else {
        $configJson = ([pscustomobject]@{
            version = $resolvedVersion.RichVersion
            bundle = @{ targets = @($Bundle) }
            plugins = @{ updater = @{ active = $false } }
        } | ConvertTo-Json -Depth 5)
    }
}
[System.IO.File]::WriteAllText($configPath, $configJson, [System.Text.UTF8Encoding]::new($false))

$schemaPath = Join-Path $repoRoot "src-tauri\gen\schemas\windows-schema.json"
$schemaBackup = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-windows-schema-" + [Guid]::NewGuid().ToString("N") + ".json")
$schemaExisted = Test-Path -LiteralPath $schemaPath
if ($schemaExisted) {
    Copy-Item -LiteralPath $schemaPath -Destination $schemaBackup
}
try {
    Invoke-CheckedCommand -FilePath $pnpm -ArgumentList @(
        "exec", "tauri", "build",
        "--target", $targetTriple,
        "--features", $features,
        "--bundles", $Bundle,
        "--config", $configPath
    ) -Label "pnpm exec tauri build --bundles $Bundle"
} finally {
    Remove-Item -Path $configPath -Force -ErrorAction SilentlyContinue
    if ($schemaExisted) {
        Copy-Item -Force -LiteralPath $schemaBackup -Destination $schemaPath
    } else {
        Remove-Item -Force -ErrorAction SilentlyContinue $schemaPath
    }
    Remove-Item -Force -ErrorAction SilentlyContinue $schemaBackup
}

function Assert-WindowsBundleVersion {
    param(
        [Parameter(Mandatory = $true)][string]$BundleDir,
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [Parameter(Mandatory = $true)][string]$TargetTriple,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][string]$BundleType
    )

    $appPath = Join-Path $TargetDir "$TargetTriple\release\Berd.exe"
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
        throw "Built application executable not found: $appPath"
    }
    $actualVersion = (Get-Item -LiteralPath $appPath).VersionInfo.ProductVersion
    if ($actualVersion -ne $ExpectedVersion) {
        throw "Built application version mismatch: expected '$ExpectedVersion', got '$actualVersion' at $appPath."
    }

    $bundlePattern = if ($BundleType -eq "nsis") {
        "Berd_${ExpectedVersion}_x64-setup.exe"
    } else {
        "Berd_${ExpectedVersion}_x64_en-US.msi"
    }
    $bundlePath = Join-Path $BundleDir $bundlePattern
    if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
        throw "Expected $BundleType bundle not found: $bundlePath"
    }

    return $bundlePath
}

$bundleDir = Join-Path $targetDir "$targetTriple\release\bundle\$Bundle"
$bundlePath = Assert-WindowsBundleVersion `
    -BundleDir $bundleDir `
    -TargetDir $targetDir `
    -TargetTriple $targetTriple `
    -ExpectedVersion $resolvedVersion.RichVersion `
    -BundleType $Bundle
Write-Host ""
Write-Host "Windows bundle ready: $bundlePath" -ForegroundColor Green
