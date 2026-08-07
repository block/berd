$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

$script:Failures = 0

function Assert-Equal {
    param([string]$Name, [object]$Actual, [object]$Expected)
    if ($Actual -ne $Expected) {
        $script:Failures += 1
        Write-Host "FAIL $Name - expected '$Expected', got '$Actual'" -ForegroundColor Red
    } else {
        Write-Host "PASS $Name" -ForegroundColor Green
    }
}

function Assert-Throws {
    param([string]$Name, [scriptblock]$Action)
    try {
        & $Action | Out-Null
        $script:Failures += 1
        Write-Host "FAIL $Name - expected an exception, none was thrown" -ForegroundColor Red
    } catch {
        Write-Host "PASS $Name" -ForegroundColor Green
    }
}

function Assert-NoThrow {
    param([string]$Name, [scriptblock]$Action)
    try {
        & $Action | Out-Null
        Write-Host "PASS $Name" -ForegroundColor Green
    } catch {
        $script:Failures += 1
        Write-Host "FAIL $Name - unexpected exception: $($_.Exception.Message)" -ForegroundColor Red
    }
}

$oldGooseDevRoot = $env:GOOSE_DEV_ROOT
$oldGooseRepo = $env:GOOSE_DEV_REPO
$oldGooseTarget = $env:GOOSE_DEV_CARGO_TARGET_DIR
$oldGooseStamp = $env:GOOSE_DEV_STAMP_FILE
$oldLocalAppData = $env:LOCALAPPDATA
$oldUserProfile = $env:USERPROFILE
$oldAppData = $env:APPDATA
$oldFnmDir = $env:FNM_DIR

try {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("berd-windowsdev-test-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    $env:GOOSE_DEV_ROOT = Join-Path $temp "root"
    $env:GOOSE_DEV_REPO = ""
    $env:GOOSE_DEV_CARGO_TARGET_DIR = ""
    $env:GOOSE_DEV_STAMP_FILE = ""

    Assert-Equal "process args: plain arg unquoted" (Join-WindowsProcessArguments -Arguments @("--wait")) "--wait"
    Assert-Equal "process args: spaces quoted" (Join-WindowsProcessArguments -Arguments @("C:\Program Files\x")) '"C:\Program Files\x"'
    Assert-Equal "process args: trailing backslash doubled inside quotes" (Join-WindowsProcessArguments -Arguments @("C:\Program Files\")) '"C:\Program Files\\"'
    Assert-Equal "process args: embedded quote escaped" (Join-WindowsProcessArguments -Arguments @('say "hi"')) '"say \"hi\""'

    $justfile = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "justfile")
    Assert-Equal "justfile selects PowerShell for ordinary Windows recipes" ($justfile -match '(?m)^set windows-shell := \["powershell\.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"\]\r?$') $true
    foreach ($recipe in @("_tauri-cargo-windows", "_clean-windows")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe selects PowerShell locally" ($justfile -match "(?m)^${escapedRecipe}[^:]*:\r?\n\s+#!powershell\.exe") $true
    }
    Assert-Equal "stage-sidecar is not advertised on Windows" ($justfile -match '(?m)^\[unix\]\r?\nstage-sidecar:') $true
    Assert-Equal "no Git Bash stage-sidecar bridge remains" ($justfile -notmatch '(?m)^_stage-sidecar-windows:') $true
    foreach ($recipe in @("bundle", "bundle-debug", "dev", "dev-e2e", "artifacts-publish", "reset-migration")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe stays Unix-only" ($justfile -match "(?m)^\[unix\]\r?\n${escapedRecipe}[^:]*:") $true
        Assert-Equal "$recipe keeps an explicit bash shebang" ($justfile -match "(?m)^${escapedRecipe}[^:]*:\r?\n\s+#!/usr/bin/env bash") $true
    }
    foreach ($recipe in @("bootstrap-windows", "doctor-windows", "cleanup-windows", "setup-windows", "dev-windows", "tauri-check-windows", "test-windows-dev")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe is declared in the justfile" ($justfile -match "(?m)^${escapedRecipe}[^:]*:") $true
    }
    $windowsRecipeCommands = @{
        "bootstrap-windows" = "scripts/windows/Bootstrap-Windows.ps1"
        "doctor-windows" = "scripts/windows/Doctor-Windows.ps1"
        "cleanup-windows" = "scripts/windows/Cleanup-Windows.ps1"
        "setup-windows" = "scripts/windows/Setup-Windows.ps1"
        "dev-windows" = "scripts/windows/Dev-Windows.ps1"
        "tauri-check-windows" = "scripts/windows/Tauri-Check-Windows.ps1"
        "test-windows-dev" = "scripts/windows/Test-WindowsDev.ps1"
    }
    foreach ($recipe in $windowsRecipeCommands.Keys) {
        $recipePattern = [regex]::Escape($recipe)
        $scriptPattern = [regex]::Escape($windowsRecipeCommands[$recipe])
        Assert-Equal "$recipe dispatches through its native PowerShell script" ($justfile -match "(?m)^${recipePattern}[^:]*:\r?\n\s+powershell\.exe .* -File ${scriptPattern}") $true
    }
    Assert-Equal "bundle-windows is declared in the justfile" ($justfile -match '(?m)^bundle-windows[^:]*:') $true
    Assert-Equal "bundle-windows uses positional argv transport" ($justfile -match '(?m)^\[positional-arguments\]\r?\n\[script\("powershell\.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"\)\]\r?\nbundle-windows[^:]*:\r?\n\s+& .*Bundle-Windows\.ps1.*\$args\[0\]') $true
    Assert-Equal "bundle-windows does not interpolate bundle into source" ($justfile -notmatch '(?m)^\s+.*Bundle-Windows\.ps1.*\{\{\s*bundle\s*\}\}') $true

    $injectionMarker = Join-Path $temp "just-injection-proof"
    $maliciousBundle = 'bogus"; New-Item -ItemType File -Force -Path "' + $injectionMarker + '" | Out-Null; #'
    $justCommand = (Get-Command just -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($justCommand)) {
        $justCommand = Join-Path $env:USERPROFILE ".local\bin\just.exe"
    }
    Assert-Equal "just is available for injection regression" (Test-Path -LiteralPath $justCommand) $true
    & $justCommand --justfile (Join-Path (Get-BerdRepoRoot) "justfile") bundle-windows $maliciousBundle *> $null
    Assert-Equal "bundle-windows malicious argv is not executed" (Test-Path $injectionMarker) $false

    Assert-Equal "required pnpm version accepted" (Test-PnpmVersion (Get-RequiredPnpmVersion)) $true
    Assert-Equal "wrong pnpm version rejected" (Test-PnpmVersion "9.0.0") $false
    Assert-Equal "whitespace-trimmed pnpm version accepted" (Test-PnpmVersion "  $(Get-RequiredPnpmVersion)`r`n") $true
    Assert-Equal "missing pnpm version rejected" (Test-PnpmVersion $null) $false

    $missingPnpm = Get-PnpmReadiness -Source ""
    Assert-Equal "missing pnpm is unavailable" $missingPnpm.Available $false
    Assert-Equal "missing pnpm is not ready" $missingPnpm.Ready $false

    $port = Get-StableVitePort
    Assert-Equal "vite port within range" ($port -ge 10000 -and $port -lt 65000) $true
    Assert-Equal "vite port is stable per directory" $port (Get-StableVitePort)

    $e2eRoot = Join-Path $temp "run-123"
    $e2e = New-E2eRunContract -RunRoot $e2eRoot
    Assert-Equal "E2E run ID derives from root" $e2e.RunId "run-123"
    Assert-Equal "E2E identifier derives from run ID" $e2e.Identifier "xyz.block.berd.e2e.run-123"
    Assert-Equal "E2E config stays under run root" $e2e.ConfigPath (Join-Path $e2eRoot "tauri-dev-windows.config.json")
    Assert-Equal "E2E driver readiness stays under run root" $e2e.DriverReadyPath (Join-Path $e2eRoot "app-test-driver.json")
    Assert-Equal "E2E generated driver token is strong ASCII" ($e2e.DriverToken -cmatch '^[a-z0-9]{64}$') $true
    Assert-Equal "E2E generated driver tokens are per-run" ((New-E2eRunContract -RunRoot $e2eRoot).DriverToken -ne $e2e.DriverToken) $true
    $explicitToken = "0123456789abcdef0123456789abcdef"
    Assert-Equal "E2E explicit driver token is preserved" (New-E2eRunContract -RunRoot $e2eRoot -DriverToken $explicitToken).DriverToken $explicitToken
    Assert-Throws "E2E relative run root rejected" { New-E2eRunContract -RunRoot "relative\run-123" }
    Assert-Throws "E2E underscore run ID rejected" { New-E2eRunContract -RunRoot (Join-Path $temp "run_123") }
    Assert-Throws "E2E malformed run ID rejected" { New-E2eRunContract -RunRoot (Join-Path $temp "bad.id") }
    Assert-Throws "E2E mismatched run ID rejected" { New-E2eRunContract -RunRoot $e2eRoot -RunId "other" }
    Assert-Throws "E2E weak driver token rejected" { New-E2eRunContract -RunRoot $e2eRoot -DriverToken "weak" }

    $paths = Resolve-GooseDevPaths
    Assert-Equal "default Goose repo path" $paths.Repo (Join-Path $env:GOOSE_DEV_ROOT "goose")
    Assert-Equal "default Goose cargo target path" $paths.CargoTargetDir (Join-Path $env:GOOSE_DEV_ROOT "cargo-target")
    Assert-Equal "default Goose stamp path" $paths.StampFile (Join-Path $env:GOOSE_DEV_ROOT "stamp.json")
    Assert-Equal "Windows exe suffix" (Get-WindowsExeName "goose") "goose.exe"
    Assert-Equal "Existing exe suffix is preserved" (Get-WindowsExeName "goose.exe") "goose.exe"

    $settings = [pscustomobject]@{
        LockFile = Join-Path (Get-BerdRepoRoot) "goose-backend.lock.json"
        Ref = "main"
        Commit = "abc123"
        Package = "goose-cli"
        Bin = "goose"
    }
    $bin = Join-Path $temp "goose.exe"
    Set-Content -Path $bin -Value "fake" -Encoding ASCII
    Write-GooseStamp -Paths $paths -Settings $settings -Commit "abc123" -BinPath $bin
    $stamp = Read-GooseStamp -Path $paths.StampFile
    Assert-Equal "stamp records ref" (Get-ObjectValue $stamp "ref") "main"
    Assert-Equal "stamp records bin path" (Get-ObjectValue $stamp "bin") $bin
    Assert-Equal "stamp match accepts current build" (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $bin -LocalHead "abc123") $true
    Assert-Equal "stamp match rejects changed commit" (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $bin -LocalHead "def456") $false

    # â”€â”€ Cleanup containment rules (Assert-SafeCleanupPath / Normalize-FullPath) â”€â”€
    # These guard Remove-Item -Recurse in Cleanup-Windows.ps1; run them against
    # the real environment before the redirection block below.
    $insideRoot = Join-Path $temp "allowed"
    Assert-NoThrow "safe path: exact allowed root" { Assert-SafeCleanupPath -Path $insideRoot -AllowedRoot $insideRoot }
    Assert-NoThrow "safe path: child of allowed root" { Assert-SafeCleanupPath -Path (Join-Path $insideRoot "sub\dir") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: outside allowed root" { Assert-SafeCleanupPath -Path (Join-Path $temp "elsewhere") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: parent traversal escapes root" { Assert-SafeCleanupPath -Path (Join-Path $insideRoot "..\escape") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: prefix sibling does not match root" { Assert-SafeCleanupPath -Path ($insideRoot + "-sibling") -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: relative path rejected" { Assert-SafeCleanupPath -Path "relative\dir" -AllowedRoot $insideRoot }
    Assert-Throws "unsafe path: user profile protected even as its own root" {
        Assert-SafeCleanupPath -Path (Get-UserProfileRoot) -AllowedRoot (Get-UserProfileRoot)
    }
    Assert-Throws "unsafe path: repo root protected even as its own root" {
        Assert-SafeCleanupPath -Path (Get-BerdRepoRoot) -AllowedRoot (Get-BerdRepoRoot)
    }
    Assert-Throws "unsafe path: drive root rejected" {
        Assert-SafeCleanupPath -Path ([System.IO.Path]::GetPathRoot($temp)) -AllowedRoot ([System.IO.Path]::GetPathRoot($temp))
    }
    Assert-Equal "normalize strips trailing separators" (Normalize-FullPath ($insideRoot + [System.IO.Path]::DirectorySeparatorChar)) $insideRoot

    $env:LOCALAPPDATA = Join-Path $temp "Local"
    $env:USERPROFILE = Join-Path $temp "User"
    $env:APPDATA = Join-Path $temp "Roaming"
    $env:FNM_DIR = ""

    # Cleanup honors the same env overrides setup/dev use.
    $env:BERD_TAURI_CARGO_TARGET_DIR = Join-Path $temp "override-target"
    $overriddenPaths = Resolve-WindowsCleanupPaths
    Assert-Equal "cleanup honors GOOSE_DEV_ROOT override" $overriddenPaths.BerdDevRoot $env:GOOSE_DEV_ROOT
    Assert-Equal "cleanup honors BERD_TAURI_CARGO_TARGET_DIR override" $overriddenPaths.BerdTauriRoot $env:BERD_TAURI_CARGO_TARGET_DIR
    $env:BERD_TAURI_CARGO_TARGET_DIR = ""
    $env:GOOSE_DEV_ROOT = ""

    $cleanupPaths = Resolve-WindowsCleanupPaths
    Assert-Equal "cleanup Berd dev root" $cleanupPaths.BerdDevRoot (Join-Path $env:LOCALAPPDATA "berd-dev")
    Assert-Equal "cleanup Tauri root" $cleanupPaths.BerdTauriRoot (Join-Path $env:LOCALAPPDATA "berd-tauri")
    Assert-Equal "Block npm cert file" $cleanupPaths.BlockCertFile (Join-Path $env:USERPROFILE ".block-certs\root-certs.pem")
    Assert-Equal "cleanup Corepack pnpm dir" $cleanupPaths.CorepackPnpmVersionDir (Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$(Get-RequiredPnpmVersion)")
    Assert-Equal "cleanup fnm Node dir" $cleanupPaths.FnmNodeVersionDir (Join-Path $env:APPDATA "fnm\node-versions\v$(Get-RequiredNodeVersion)")
    Assert-Equal "cleanup fnm multishells dir" $cleanupPaths.FnmMultishellsDir (Join-Path $env:LOCALAPPDATA "fnm_multishells")
    Assert-Equal "cleanup repo node_modules" $cleanupPaths.RepoNodeModules (Join-Path (Get-BerdRepoRoot) "node_modules")
    Assert-Equal "cleanup repo pnpm store" $cleanupPaths.RepoPnpmStore (Join-Path (Get-BerdRepoRoot) ".pnpm-store")
    Assert-Equal "cleanup repo dist" $cleanupPaths.RepoDist (Join-Path (Get-BerdRepoRoot) "dist")
    Assert-Equal "cleanup sdk node_modules" $cleanupPaths.SdkNodeModules (Join-Path (Get-BerdRepoRoot) "sdk\node_modules")
    Assert-Equal "cleanup sdk dist" $cleanupPaths.SdkDist (Join-Path (Get-BerdRepoRoot) "sdk\dist")
    Assert-Equal "cleanup git hooks dir" $cleanupPaths.GitHooksDir (Join-Path (Get-BerdRepoRoot) ".git\hooks")

    $envTargets = Get-BlockNpmEnvironmentTargets
    $registryTarget = $envTargets | Where-Object { $_.Name -eq "NPM_CONFIG_REGISTRY" } | Select-Object -First 1
    $cafileTarget = $envTargets | Where-Object { $_.Name -eq "NPM_CONFIG_CAFILE" } | Select-Object -First 1
    $nodeCertTarget = $envTargets | Where-Object { $_.Name -eq "NODE_EXTRA_CA_CERTS" } | Select-Object -First 1
    $corepackRegistryTarget = $envTargets | Where-Object { $_.Name -eq "COREPACK_NPM_REGISTRY" } | Select-Object -First 1
    $corepackIntegrityTarget = $envTargets | Where-Object { $_.Name -eq "COREPACK_INTEGRITY_KEYS" } | Select-Object -First 1
    Assert-Equal "Block npm env registry target" $registryTarget.ExpectedValue (Get-BlockNpmRegistry)
    Assert-Equal "Block npm env cafile target" $cafileTarget.ExpectedValue $cleanupPaths.BlockCertFile
    Assert-Equal "Block npm env node cert target" $nodeCertTarget.ExpectedValue $cleanupPaths.BlockCertFile
    Assert-Equal "Block npm env Corepack registry target" $corepackRegistryTarget.ExpectedValue (Get-BlockNpmRegistry)
    Assert-Equal "Block npm env Corepack integrity target" $corepackIntegrityTarget.ExpectedValue "0"
} finally {
    $env:GOOSE_DEV_ROOT = $oldGooseDevRoot
    $env:GOOSE_DEV_REPO = $oldGooseRepo
    $env:GOOSE_DEV_CARGO_TARGET_DIR = $oldGooseTarget
    $env:GOOSE_DEV_STAMP_FILE = $oldGooseStamp
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:USERPROFILE = $oldUserProfile
    $env:APPDATA = $oldAppData
    $env:FNM_DIR = $oldFnmDir
    if ($temp -and (Test-Path $temp)) {
        # Best effort: a transiently locked temp file must not fail the run.
        Remove-Item -Recurse -Force -Path $temp -ErrorAction SilentlyContinue
    }
}

if ($script:Failures -gt 0) {
    exit 1
}
