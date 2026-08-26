$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
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
$oldGooseBuildProfile = $env:GOOSE_BUILD_PROFILE
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

    Assert-Equal "temporary file helper uses the framework temp-file primitive" `
        ((Get-Command New-BerdTemporaryFile -CommandType Function).Definition -match 'GetTempFileName') $true
    Assert-Equal "checksum helper uses framework cryptography instead of PowerShell.Utility" `
        (((Get-Command Get-FileSha256 -CommandType Function).Definition -match 'System.Security.Cryptography.SHA256') -and `
         ((Get-Command Get-FileSha256 -CommandType Function).Definition -notmatch 'Get-FileHash')) $true
    $checksumFixture = Join-Path $temp "sha256-fixture.txt"
    [System.IO.File]::WriteAllText($checksumFixture, "abc", [System.Text.UTF8Encoding]::new($false))
    Assert-Equal "checksum helper returns canonical lowercase SHA-256" `
        (Get-FileSha256 -Path $checksumFixture) `
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    $temporaryFile = New-BerdTemporaryFile
    try {
        Assert-Equal "temporary file helper creates a filesystem file" `
            (Test-Path -LiteralPath $temporaryFile.FullName -PathType Leaf) $true
    } finally {
        Remove-Item -LiteralPath $temporaryFile.FullName -Force -ErrorAction SilentlyContinue
    }

    Assert-Equal "process args: plain arg unquoted" (Join-WindowsProcessArguments -Arguments @("--wait")) "--wait"
    Assert-Equal "process args: spaces quoted" (Join-WindowsProcessArguments -Arguments @("C:\Program Files\x")) '"C:\Program Files\x"'
    Assert-Equal "process args: trailing backslash doubled inside quotes" (Join-WindowsProcessArguments -Arguments @("C:\Program Files\")) '"C:\Program Files\\"'
    Assert-Equal "process args: embedded quote escaped" (Join-WindowsProcessArguments -Arguments @('say "hi"')) '"say \"hi\""'

    Assert-Equal "public app feature defaults fail closed" (Get-BerdAppFeatures) "berdctl,app-test-driver,no-voice-dictation"
    $featureGateNames = @("VITE_AGENT_TOOLS", "VITE_AUTOMATIONS", "VITE_BUILDERBOT", "VITE_FEEDBACK", "VITE_MANAGED_CONNECTIONS", "VITE_TELEMETRY_ENFORCED", "VITE_VOICE_DICTATION")
    $savedFeatureGates = @{}
    foreach ($name in $featureGateNames) {
        $savedFeatureGates[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
        [Environment]::SetEnvironmentVariable($name, "1", "Process")
    }
    try {
        Assert-Equal "all seven renderer gates map to app Cargo features" `
            (Get-BerdAppFeatures -BaseFeatures @("berdctl")) `
            "berdctl,block-agent-tools,block-automations,block-builderbot,block-feedback,block-managed-connections,block-telemetry-enforced,block-voice-dictation"
    } finally {
        foreach ($name in $featureGateNames) {
            [Environment]::SetEnvironmentVariable($name, $savedFeatureGates[$name], "Process")
        }
    }

    $justfile = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "justfile")
    Assert-Equal "justfile selects PowerShell for ordinary Windows recipes" ($justfile -match '(?m)^set windows-shell := \["powershell\.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"\]\r?$') $true
    foreach ($recipe in @("_tauri-cargo-windows", "_clean-windows")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe selects PowerShell locally" ($justfile -match "(?m)^\[windows\]\r?\n${escapedRecipe}[^:]*:\r?\n\s+#!powershell\.exe") $true
    }
    Assert-Equal "_stage-sidecar-windows dispatches through its native wrapper" `
        ($justfile -match '(?m)^\[windows\]\r?\n_stage\-sidecar\-windows:\r?\n\s+powershell\.exe .* -File scripts/windows/Invoke-Stage-Sidecar-Windows\.ps1\r?$') $true
    foreach ($recipe in @("bundle", "bundle-debug", "stage-sidecar")) {
        $escapedRecipe = [regex]::Escape($recipe)
        Assert-Equal "$recipe dispatches by os_family on Windows and Unix" ($justfile -match "(?m)^${escapedRecipe}[^:]*:\r?\n\s+just _${escapedRecipe}-\{\{ os_family\(\) \}\}") $true
    }
    $just = Get-CommandSource "just"
    foreach ($recipe in @("bundle", "bundle-debug", "stage-sidecar")) {
        $dryRun = Invoke-CaptureCommand -FilePath $just -ArgumentList @("--dry-run", $recipe) -WorkingDirectory (Get-BerdRepoRoot)
        Assert-Equal "$recipe is visible and dry-runs on Windows" $dryRun.ExitCode 0
        Assert-Equal "$recipe dry-run dispatches to its Windows helper" ($dryRun.Output -match "_${recipe}-windows") $true
    }
    foreach ($recipe in @("_bundle-unix", "_bundle-debug-unix", "dev", "dev-e2e", "artifacts-publish", "reset-migration")) {
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

    $bundleScript = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "scripts\windows\Bundle-Windows.ps1")
    Assert-Equal "bundle exports full SemVer to Rust" `
        ($bundleScript -match '\$env:BERD_APP_VERSION\s*=\s*\$resolvedVersion\.RichVersion') $true
    Assert-Equal "enabled release bundles compile the updater renderer on" `
        ($bundleScript -match '(?s)\$releaseUpdaterEnabled\s*=.*?BERD_RELEASE_CHANNEL.*?\$env:VITE_UPDATER_ENABLED\s*=\s*if \(\$releaseUpdaterEnabled\) \{ "true" \} else \{ "false" \}') $true
    Assert-Equal "bundle exports full release SemVer to the renderer" `
        ($bundleScript -match '\$env:VITE_APP_VERSION\s*=\s*\$resolvedVersion\.RichVersion') $true
    Assert-Equal "bundle verifies the application PE version" ($bundleScript -match '\.VersionInfo\.ProductVersion') $true
    Assert-Equal "bundle verifies the full-SemVer installer path" `
        ($bundleScript -match 'Berd_\$\{ExpectedVersion\}_x64-setup\.exe') $true
    Assert-Equal "bundle reports the verified installer path" ($bundleScript -match 'Windows bundle ready: \$bundlePath') $true

    $prereleaseVersion = Resolve-AppVersion "1.2.3-rc.1"
    Assert-Equal "prerelease override uses numeric core for Windows ProductVersion" $prereleaseVersion.Version "1.2.3"
    Assert-Equal "prerelease override preserves full SemVer for updater metadata" $prereleaseVersion.RichVersion "1.2.3-rc.1"
    Assert-Equal "Tauri config uses full SemVer for native updater ordering" `
        ($bundleScript -notmatch 'NotePropertyName version -NotePropertyValue \$resolvedVersion\.Version') $true
    Assert-Equal "Tauri config preserves prerelease package identity" `
        ($bundleScript -match 'NotePropertyName version -NotePropertyValue \$resolvedVersion\.RichVersion') $true
    Assert-Equal "native updater orders rc.2 after rc.1" `
        ([semver]"1.2.3-rc.2" -gt [semver]"1.2.3-rc.1") $true
    Assert-Equal "native updater orders stable after prerelease" `
        ([semver]"1.2.3" -gt [semver]"1.2.3-rc.2") $true

    $buildScript = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "src-tauri\build.rs")
    Assert-Equal "Rust rebuilds when the resolved app version changes" ($buildScript -match 'cargo:rerun-if-env-changed=BERD_APP_VERSION') $true
    Assert-Equal "Rust rebuilds when the Tauri config overlay changes" ($buildScript -match 'cargo:rerun-if-env-changed=TAURI_CONFIG') $true
    Assert-Equal "Rust embeds the resolved diagnostic version" ($buildScript -match 'cargo:rustc-env=BERD_BUILD_VERSION') $true

    $injectionMarker = Join-Path $temp "just-injection-proof"
    $maliciousBundle = 'bogus"; New-Item -ItemType File -Force -Path "' + $injectionMarker + '" | Out-Null; #'
    $justCommand = (Get-Command just -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($justCommand)) {
        $justCommand = Join-Path $env:USERPROFILE ".local\bin\just.exe"
    }
    Assert-Equal "just is available for injection regression" (Test-Path -LiteralPath $justCommand) $true
    $injectionResult = Invoke-CaptureCommand -FilePath $justCommand `
        -ArgumentList @("--justfile", (Join-Path (Get-BerdRepoRoot) "justfile"), "bundle-windows", $maliciousBundle)
    Assert-Equal "bundle-windows rejects the malicious bundle argv" ($injectionResult.ExitCode -ne 0) $true
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

    # E2E disables Tauri's Rust watcher so generated permission/schema writes
    # cannot restart an in-flight native compile. Interactive dev retains hot
    # reload: --no-watch must remain inside the E2eMode-only branch.
    $devWindowsSource = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "scripts/windows/Dev-Windows.ps1")
    $e2eNoWatchPattern = '(?ms)if \(\$E2eMode\) \{(?:(?!\r?\n\}).)*?\$tauriArguments \+= "--no-watch"\r?\n\}'
    Assert-Equal "E2E Tauri launch disables the watcher" `
        ($devWindowsSource -match $e2eNoWatchPattern) $true
    Assert-Equal "ordinary Tauri dev launch retains the watcher" `
        ([regex]::Matches($devWindowsSource, '"--no-watch"').Count) 1

    $gitAttributes = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) ".gitattributes")
    Assert-Equal "Windows Tauri config is pinned to LF" `
        (($gitAttributes -split '\r?\n') -contains "src-tauri/tauri.windows.conf.json text eol=lf") $true
    Assert-Equal "SQL migrations are pinned to LF for stable sqlx checksums" `
        (($gitAttributes -split '\r?\n') -contains "src-tauri/migrations/*.sql text eol=lf") $true
    $migrationFiles = Get-ChildItem -Path (Join-Path (Get-BerdRepoRoot) "src-tauri/migrations") -Filter "*.sql" -File
    Assert-Equal "SQL migration contract covers at least one migration" ($migrationFiles.Count -gt 0) $true
    foreach ($migrationFile in $migrationFiles) {
        $migrationBytes = [System.IO.File]::ReadAllBytes($migrationFile.FullName)
        Assert-Equal "$($migrationFile.Name) contains no CR bytes" ($migrationBytes -notcontains 13) $true
    }

    $paths = Resolve-GooseDevPaths
    Assert-Equal "default Goose repo path" $paths.Repo (Join-Path $env:GOOSE_DEV_ROOT "goose")
    Assert-Equal "default Goose cargo target path" $paths.CargoTargetDir (Join-Path $env:GOOSE_DEV_ROOT "cargo-target")
    Assert-Equal "default Goose stamp path" $paths.StampFile (Join-Path $env:GOOSE_DEV_ROOT "stamp.json")
    Assert-Equal "Windows exe suffix" (Get-WindowsExeName "goose") "goose.exe"
    Assert-Equal "Existing exe suffix is preserved" (Get-WindowsExeName "goose.exe") "goose.exe"
    $gooseRepo = Join-Path $temp "goose-repo"
    $gooseTarget = Join-Path $temp "goose-target"
    New-Item -ItemType Directory -Force -Path $gooseRepo | Out-Null
    $goosePaths = [pscustomobject]@{ Repo = $gooseRepo; CargoTargetDir = $gooseTarget }
    $gooseSettings = [pscustomobject]@{ Bin = "goose"; BuildProfile = "release" }
    Assert-Equal "managed Goose resolves from the selected profile" `
        (Resolve-GooseBinaryPath -Paths $goosePaths -Settings $gooseSettings) `
        (Join-Path (Join-Path $gooseTarget "release") "goose.exe")
    $env:GOOSE_BUILD_PROFILE = ""
    Assert-Equal "managed Goose defaults development to debug" (Get-GooseBackendSettings).BuildProfile "debug"
    $env:GOOSE_BUILD_PROFILE = "release"
    Assert-Equal "managed Goose accepts the release profile" (Get-GooseBackendSettings).BuildProfile "release"
    $env:GOOSE_BUILD_PROFILE = ""
    $windowsDevSource = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "scripts\windows\WindowsDev.psm1")
    Assert-Equal "managed Goose release profile adds cargo --release" `
        ($windowsDevSource -match '(?s)if \(\$Settings\.BuildProfile -eq "release"\).*?\$cargoArguments \+= "--release"') $true

    # ── Windows sidecar staging (Get-WindowsSidecarName / Get-WindowsTripleMachine /
    #    Get-PeFileInfo / Assert-WindowsSidecarBinary / Remove-StaleWindowsSidecars /
    #    Stage-WindowsSidecar) ──────────────────────────────────────────────────
    # These guard the native Windows externalBin staging that replaces the Unix
    # chmod/-x contract. A minimal PE image is synthesized in memory so the
    # validation runs deterministically on any host without a real toolchain.

    Assert-Equal "sidecar name appends triple and exe" `
        (Get-WindowsSidecarName -Stem "goosed" -Triple "x86_64-pc-windows-msvc") `
        "goosed-x86_64-pc-windows-msvc.exe"
    Assert-Equal "x86_64 triple maps to amd64 machine" `
        (Get-WindowsTripleMachine -Triple "x86_64-pc-windows-msvc") 0x8664
    Assert-Equal "aarch64 triple maps to arm64 machine" `
        (Get-WindowsTripleMachine -Triple "aarch64-pc-windows-msvc") 0xAA64
    Assert-Equal "gnu triple is still supported" `
        (Get-WindowsTripleMachine -Triple "x86_64-pc-windows-gnu") 0x8664
    Assert-Equal "non-windows triple is unsupported" `
        (Get-WindowsTripleMachine -Triple "aarch64-apple-darwin") $null

    # Write a minimal but well-formed PE image for a given COFF machine value:
    # DOS header (MZ + e_lfanew at 0x3C), PE signature, a COFF header whose
    # Machine/NumberOfSections/SizeOfOptionalHeader/Characteristics we control,
    # a PE32+ optional header, and one section-table entry. Switches let tests
    # synthesize the truncated/malformed shapes the validator must reject.
    function New-FakePeFile {
        param(
            [Parameter(Mandatory = $true)][string]$Path,
            [Parameter(Mandatory = $true)][int]$Machine,
            [bool]$ExecutableImage = $true,
            # Drop everything after the COFF header (no optional header/sections).
            [switch]$TruncateAfterCoff,
            # Emit an optional-header magic that is neither PE32 nor PE32+.
            [switch]$BadOptionalMagic,
            # Override SizeOfOptionalHeader / NumberOfSections to synthesize
            # structurally-invalid-but-magic-bearing shapes (e.g. an optional
            # header that stops right after the magic, or zero sections). When
            # null, well-formed defaults (0xF0 header + 1 section) are used.
            [Nullable[int]]$OptionalHeaderSize = $null,
            [Nullable[int]]$SectionCount = $null
        )
        $peOffset = 0x40
        $optionalHeaderSize = if ($null -ne $OptionalHeaderSize) { $OptionalHeaderSize } else { 0xF0 }  # typical PE32+ optional header size
        $sectionCount = if ($null -ne $SectionCount) { $SectionCount } else { 1 }
        if ($TruncateAfterCoff) {
            $total = $peOffset + 24
        } else {
            $total = $peOffset + 24 + $optionalHeaderSize + ($sectionCount * 40)
        }
        $bytes = New-Object byte[] $total
        $bytes[0] = 0x4D  # 'M'
        $bytes[1] = 0x5A  # 'Z'
        [System.BitConverter]::GetBytes([int]$peOffset).CopyTo($bytes, 0x3C)
        $bytes[$peOffset] = 0x50      # 'P'
        $bytes[$peOffset + 1] = 0x45  # 'E'
        $bytes[$peOffset + 2] = 0x00
        $bytes[$peOffset + 3] = 0x00
        $coff = $peOffset + 4
        [System.BitConverter]::GetBytes([uint16]$Machine).CopyTo($bytes, $coff)
        $characteristics = if ($ExecutableImage) { [uint16]0x0002 } else { [uint16]0x0000 }
        if (-not $TruncateAfterCoff) {
            [System.BitConverter]::GetBytes([uint16]$sectionCount).CopyTo($bytes, $coff + 2)
            [System.BitConverter]::GetBytes([uint16]$optionalHeaderSize).CopyTo($bytes, $coff + 16)
        }
        [System.BitConverter]::GetBytes($characteristics).CopyTo($bytes, $coff + 18)
        if (-not $TruncateAfterCoff -and $optionalHeaderSize -ge 2) {
            $magic = if ($BadOptionalMagic) { [uint16]0xDEAD } else { [uint16]0x20B }  # PE32+
            [System.BitConverter]::GetBytes($magic).CopyTo($bytes, $coff + 20)
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    }

    $amd64 = 0x8664
    $arm64 = 0xAA64

    # Paths with spaces exercise the same quoting hazards the real bundle dir
    # (e.g. under "C:\Users\First Last\...") would hit.
    $stageRoot = Join-Path $temp "stage root with spaces"
    $srcDir = Join-Path $stageRoot "src"
    $binDir = Join-Path $stageRoot "binaries"

    $goodPe = Join-Path $srcDir "goosed.exe"
    New-FakePeFile -Path $goodPe -Machine $amd64
    $peInfo = Get-PeFileInfo -Path $goodPe
    Assert-Equal "PE info detects amd64 image" $peInfo.IsPe $true
    Assert-Equal "PE info reads machine" $peInfo.Machine $amd64
    Assert-Equal "PE info reads executable bit" $peInfo.IsExecutableImage $true

    # A POSIX shell script (what the old Catch stub emitted) is not a PE.
    $shellStub = Join-Path $srcDir "catch"
    Set-Content -Path $shellStub -Value "#!/usr/bin/env sh`necho no`n" -Encoding ASCII
    Assert-Equal "shell script is not a PE" (Get-PeFileInfo -Path $shellStub).IsPe $false
    Assert-Throws "staging rejects a shell-script fake binary" {
        Stage-WindowsSidecar -SourcePath $shellStub -Triple "x86_64-pc-windows-msvc" -Stem "catch" -BinDir $binDir
    }

    # Truncated image: MZ + PE signature + COFF header but nothing after it (no
    # optional header/section table). Windows cannot load it, so validation must
    # reject it instead of blessing a corrupt/partial artifact.
    $truncated = Join-Path $srcDir "goosed-truncated.exe"
    New-FakePeFile -Path $truncated -Machine $amd64 -TruncateAfterCoff
    Assert-Equal "truncated PE (no optional header) is not a valid PE" (Get-PeFileInfo -Path $truncated).IsPe $false
    Assert-Throws "staging rejects a truncated PE" {
        Stage-WindowsSidecar -SourcePath $truncated -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # Malformed optional-header magic (neither PE32 0x10B nor PE32+ 0x20B).
    $badMagic = Join-Path $srcDir "goosed-badmagic.exe"
    New-FakePeFile -Path $badMagic -Machine $amd64 -BadOptionalMagic
    Assert-Equal "PE with bad optional-header magic is not valid" (Get-PeFileInfo -Path $badMagic).IsPe $false
    Assert-Throws "staging rejects a bad optional-header magic" {
        Stage-WindowsSidecar -SourcePath $badMagic -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # Minimal non-image: MZ + PE + COFF + a 2-byte optional header that carries a
    # valid PE32+ magic but nothing else, and zero sections. This is the reachable
    # ~90-byte defect where the truncation simply moved past the magic. A 2-byte
    # optional header is far below the PE32+ minimum (112 bytes) and the file has
    # no section table, so validation must reject it.
    $magicOnly = Join-Path $srcDir "goosed-magiconly.exe"
    New-FakePeFile -Path $magicOnly -Machine $amd64 -OptionalHeaderSize 2 -SectionCount 0
    Assert-Equal "PE with magic but sub-minimum optional header is not valid" (Get-PeFileInfo -Path $magicOnly).IsPe $false
    Assert-Throws "staging rejects a magic-only sub-minimum PE" {
        Stage-WindowsSidecar -SourcePath $magicOnly -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # A full-size optional header but zero sections is still not a loadable image.
    $noSections = Join-Path $srcDir "goosed-nosections.exe"
    New-FakePeFile -Path $noSections -Machine $amd64 -SectionCount 0
    Assert-Equal "PE with zero sections is not valid" (Get-PeFileInfo -Path $noSections).IsPe $false
    Assert-Throws "staging rejects a zero-section PE" {
        Stage-WindowsSidecar -SourcePath $noSections -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # A PE32+ optional header just under the 112-byte minimum must also be rejected.
    $shortOptional = Join-Path $srcDir "goosed-shortoptional.exe"
    New-FakePeFile -Path $shortOptional -Machine $amd64 -OptionalHeaderSize 111
    Assert-Equal "PE32+ with sub-minimum optional header is not valid" (Get-PeFileInfo -Path $shortOptional).IsPe $false

    Assert-Throws "staging rejects a missing source" {
        Stage-WindowsSidecar -SourcePath (Join-Path $srcDir "does-not-exist.exe") -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # Wrong architecture: an arm64 PE staged for an x86_64 target must fail.
    $wrongArch = Join-Path $srcDir "goosed-arm64.exe"
    New-FakePeFile -Path $wrongArch -Machine $arm64
    Assert-Throws "staging rejects a wrong-architecture PE" {
        Stage-WindowsSidecar -SourcePath $wrongArch -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # A PE without the executable-image characteristic is rejected.
    $notExec = Join-Path $srcDir "goosed-noexec.exe"
    New-FakePeFile -Path $notExec -Machine $amd64 -ExecutableImage $false
    Assert-Throws "staging rejects a non-executable PE image" {
        Stage-WindowsSidecar -SourcePath $notExec -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    }

    # Happy path: valid amd64 PE stages to the exact Tauri name under a spaced dir.
    $stagedPath = Stage-WindowsSidecar -SourcePath $goodPe -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir
    $expectedStaged = Join-Path $binDir "goosed-x86_64-pc-windows-msvc.exe"
    Assert-Equal "staging writes the exact Tauri sidecar name" $stagedPath $expectedStaged
    Assert-Equal "staged sidecar exists" (Test-Path $expectedStaged -PathType Leaf) $true
    Assert-Equal "staged sidecar matches source checksum" (Get-FileSha256 -Path $expectedStaged) (Get-FileSha256 -Path $goodPe)

    # Stale cleanup: a leftover extensionless Unix-staged file and an old-triple
    # file must be removed when the current triple is staged.
    Set-Content -Path (Join-Path $binDir "goosed") -Value "old-unix" -Encoding ASCII
    New-FakePeFile -Path (Join-Path $binDir "goosed-aarch64-pc-windows-msvc.exe") -Machine $arm64
    Stage-WindowsSidecar -SourcePath $goodPe -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir | Out-Null
    Assert-Equal "stale extensionless sidecar removed" (Test-Path (Join-Path $binDir "goosed") -PathType Leaf) $false
    Assert-Equal "stale old-triple sidecar removed" (Test-Path (Join-Path $binDir "goosed-aarch64-pc-windows-msvc.exe") -PathType Leaf) $false
    Assert-Equal "current sidecar retained after cleanup" (Test-Path $expectedStaged -PathType Leaf) $true

    # Cleanup must only touch the requested stem, never a sibling sidecar.
    $berdctlSrc = Join-Path $srcDir "berdctl.exe"
    New-FakePeFile -Path $berdctlSrc -Machine $amd64
    Stage-WindowsSidecar -SourcePath $berdctlSrc -Triple "x86_64-pc-windows-msvc" -Stem "berdctl" -BinDir $binDir | Out-Null
    Stage-WindowsSidecar -SourcePath $goodPe -Triple "x86_64-pc-windows-msvc" -Stem "goosed" -BinDir $binDir | Out-Null
    Assert-Equal "sibling stem sidecar untouched by cleanup" (Test-Path (Join-Path $binDir "berdctl-x86_64-pc-windows-msvc.exe") -PathType Leaf) $true

    # ── Windows externalBin contract (tauri.windows.conf.json) ──
    $windowsConf = Read-JsonFile (Join-Path (Get-BerdRepoRoot) "src-tauri/tauri.windows.conf.json")
    $windowsExternalBin = @(Get-ObjectValue (Get-ObjectValue $windowsConf "bundle") "externalBin")
    Assert-Equal "Windows externalBin stages goosed" ($windowsExternalBin -contains "binaries/goosed") $true
    Assert-Equal "Windows externalBin stages berdctl" ($windowsExternalBin -contains "binaries/berdctl") $true
    Assert-Equal "Windows externalBin stages berd-monitor" ($windowsExternalBin -contains "binaries/berd-monitor") $true
    Assert-Equal "Windows externalBin excludes catch" ($windowsExternalBin -contains "binaries/catch") $false

    # Tauri merges platform overlays into the base config with json_patch (RFC
    # 7386), which REPLACES arrays wholesale rather than concatenating. The base
    # config stages catch; the Windows overlay's array must fully replace it so
    # the effective Windows externalBin contract has no catch entry. Model that
    # array-replacement merge here so a regression that turns the overlay into a
    # partial patch (leaving catch in the merged result) fails locally.
    $baseConf = Read-JsonFile (Join-Path (Get-BerdRepoRoot) "src-tauri/tauri.conf.json")
    $baseExternalBin = @(Get-ObjectValue (Get-ObjectValue $baseConf "bundle") "externalBin")
    Assert-Equal "base externalBin stages catch" ($baseExternalBin -contains "binaries/catch") $true
    # RFC 7386 merge: a present member on the overlay replaces the base member.
    $mergedExternalBin = if ($null -ne $windowsExternalBin) { $windowsExternalBin } else { $baseExternalBin }
    Assert-Equal "merged Windows externalBin stages goosed" ($mergedExternalBin -contains "binaries/goosed") $true
    Assert-Equal "merged Windows externalBin stages berdctl" ($mergedExternalBin -contains "binaries/berdctl") $true
    Assert-Equal "merged Windows externalBin stages berd-monitor" ($mergedExternalBin -contains "binaries/berd-monitor") $true
    Assert-Equal "merged Windows externalBin drops catch" ($mergedExternalBin -contains "binaries/catch") $false

    # ── Windows bundle recipes route through native staging ──────
    # just bundle / bundle-debug must platform-dispatch: Unix keeps the POSIX
    # prepare-*-sidecar.sh flow, Windows drives Bundle-Windows.ps1 (native
    # staging + NSIS). A Windows `just bundle` that ran the Bash recipe would
    # stage extensionless inputs and emit the forbidden Catch stub.
    Assert-Equal "bundle dispatches by os_family" ($justfile -match "(?m)^bundle:\r?\n\s+just _bundle-\{\{ os_family\(\) \}\}") $true
    Assert-Equal "bundle-debug dispatches by os_family" ($justfile -match "(?m)^bundle-debug:\r?\n\s+just _bundle-debug-\{\{ os_family\(\) \}\}") $true
    Assert-Equal "_bundle-windows runs Bundle-Windows.ps1" ($justfile -match "(?m)^_bundle-windows:\r?\n\s+powershell\.exe.*Bundle-Windows\.ps1") $true
    Assert-Equal "_bundle-debug-windows runs Bundle-Windows.ps1 -Debug" ($justfile -match "(?m)^_bundle-debug-windows:\r?\n\s+powershell\.exe.*Bundle-Windows\.ps1 -Debug") $true
    Assert-Equal "_bundle-unix keeps POSIX goose preparer" ($justfile -match "(?ms)^_bundle-unix:.*prepare-goose-sidecar\.sh") $true

    $settings = [pscustomobject]@{
        LockFile = Join-Path (Get-BerdRepoRoot) "goose-backend.lock.json"
        Ref = "main"
        Commit = "abc123"
        Package = "goose-cli"
        Bin = "goose"
        BuildProfile = "debug"
    }
    $bin = Join-Path $temp "goose.exe"
    Set-Content -Path $bin -Value "fake" -Encoding ASCII
    Write-GooseStamp -Paths $paths -Settings $settings -Commit "abc123" -BinPath $bin
    $stamp = Read-GooseStamp -Path $paths.StampFile
    Assert-Equal "stamp records ref" (Get-ObjectValue $stamp "ref") "main"
    Assert-Equal "stamp records bin path" (Get-ObjectValue $stamp "bin") $bin
    Assert-Equal "stamp records build profile" (Get-ObjectValue $stamp "buildProfile") "debug"
    Assert-Equal "stamp match accepts current build" (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $bin -LocalHead "abc123") $true
    Assert-Equal "stamp match rejects changed commit" (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $bin -LocalHead "def456") $false
    $releaseSettings = $settings.PSObject.Copy()
    $releaseSettings.BuildProfile = "release"
    Assert-Equal "stamp match rejects a different build profile" (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $releaseSettings -BinPath $bin -LocalHead "abc123") $false

    # ── Goose readiness is bound to the binary's SHA-256, not just its path ──
    # The stamp records the digest of the built binary; reuse must re-verify it
    # so replacing the binary bytes after stamping (a tampered/rebuilt/corrupted
    # file at the same path) is detected and forces a rebuild instead of staging
    # unknown bytes as "ready".
    Assert-Equal "stamp records binary sha256" `
        (Get-ObjectValue $stamp "sha256") (Get-FileSha256 -Path $bin)
    Set-Content -Path $bin -Value "tampered-bytes" -Encoding ASCII
    Assert-Equal "stamp match rejects replaced binary bytes" `
        (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $bin -LocalHead "abc123") $false
    # A stamp with no recorded digest predates this gate and must not be trusted.
    $legacyStamp = [pscustomobject]@{
        repo = $paths.Repo; ref = "main"; commit = "abc123"
        package = "goose-cli"; binName = "goose"; bin = $bin
    }
    Assert-Equal "stamp match rejects a digest-less legacy stamp" `
        (Test-GooseStampRecordMatches -Stamp $legacyStamp -Paths $paths -Settings $settings -BinPath $bin -LocalHead "abc123") $false

    # ── Goose --version identity classification (Test-GooseVersionOutput) ──
    # Pure classifier: distinguishes a real Goose CLI banner from an arbitrary
    # binary, a failing probe, and a hung/timed-out probe. This is the accept/
    # reject core of the bounded identity gate, tested without launching Goose.
    Assert-Equal "identity accepts a Goose version banner" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "goose 1.7.0" -TimedOut $false -BinName "goose").Ok $true
    Assert-Equal "identity accepts a v-prefixed version banner" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "goose v1.7.0-dev" -TimedOut $false -BinName "goose").Ok $true
    $gooseHelp = "An AI agent`n`nUsage: goose.exe [COMMAND]`n`nCommands:`n  configure  Configure goose settings`n  serve      Start server`n  session    Start a session`n"
    Assert-Equal "identity accepts current Goose bare semver with Goose help" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "1.45.0" -TimedOut $false -BinName "goose" -HelpExitCode 0 -HelpOutput $gooseHelp -HelpTimedOut $false).Ok $true
    Assert-Equal "identity rejects arbitrary bare semver without Goose help" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "1.45.0" -TimedOut $false -BinName "goose" -HelpExitCode 0 -HelpOutput "Usage: other.exe" -HelpTimedOut $false).Ok $false
    Assert-Equal "identity rejects a non-Goose banner" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "some-other-tool 9.9" -TimedOut $false -BinName "goose").Ok $false
    Assert-Equal "identity rejects a name-without-version banner" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "goose" -TimedOut $false -BinName "goose").Ok $false
    Assert-Equal "identity rejects empty output" `
        (Test-GooseVersionOutput -ExitCode 0 -Output "" -TimedOut $false -BinName "goose").Ok $false
    Assert-Equal "identity rejects a nonzero exit code" `
        (Test-GooseVersionOutput -ExitCode 3 -Output "goose 1.7.0" -TimedOut $false -BinName "goose").Ok $false
    Assert-Equal "identity rejects a timed-out probe" `
        (Test-GooseVersionOutput -ExitCode $null -Output "" -TimedOut $true -BinName "goose").Ok $false

    # ── Bounded process probe (Invoke-BoundedCommand) end-to-end ──
    # Drives a real child process cross-platform so the timeout, exit-code, and
    # output capture the identity gate depends on are exercised deterministically.
    # On Windows the shell is cmd.exe; elsewhere /bin/sh — both echo and sleep.
    if (Test-IsWindowsHost) {
        $probeValid = Invoke-BoundedCommand -FilePath "cmd.exe" -ArgumentList @("/c", "echo goose 1.7.0") -TimeoutSeconds 10
        $probeFail = Invoke-BoundedCommand -FilePath "cmd.exe" -ArgumentList @("/c", "exit 3") -TimeoutSeconds 10
        $probeTimeout = Invoke-BoundedCommand -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 5") -TimeoutSeconds 1
    } else {
        $probeValid = Invoke-BoundedCommand -FilePath "/bin/sh" -ArgumentList @("-c", "echo goose 1.7.0") -TimeoutSeconds 10
        $probeFail = Invoke-BoundedCommand -FilePath "/bin/sh" -ArgumentList @("-c", "exit 3") -TimeoutSeconds 10
        $probeTimeout = Invoke-BoundedCommand -FilePath "/bin/sh" -ArgumentList @("-c", "sleep 3") -TimeoutSeconds 1
    }
    Assert-Equal "bounded probe captures valid output" `
        (Test-GooseVersionOutput -ExitCode $probeValid.ExitCode -Output $probeValid.Output -TimedOut $probeValid.TimedOut -BinName "goose").Ok $true
    Assert-Equal "bounded probe reports nonzero exit" $probeFail.ExitCode 3
    Assert-Equal "bounded probe reports a timeout" $probeTimeout.TimedOut $true

    # Assert-GooseBinaryIdentity throws when the source is not Goose and passes
    # for a Goose-identifying source, for both managed and GOOSE_BIN paths.
    $identityDir = Join-Path $temp "goose-identity"
    New-Item -ItemType Directory -Force -Path $identityDir | Out-Null
    if (Test-IsWindowsHost) {
        $gooseShim = Join-Path $identityDir "goose.cmd"
        Set-Content -Path $gooseShim -Value "@echo goose 1.7.0" -Encoding ASCII
        $notGooseShim = Join-Path $identityDir "not-goose.cmd"
        Set-Content -Path $notGooseShim -Value "@echo some-tool 2.0" -Encoding ASCII
    } else {
        $gooseShim = Join-Path $identityDir "goose"
        Set-Content -Path $gooseShim -Value "#!/bin/sh`necho goose 1.7.0`n" -Encoding ASCII
        $notGooseShim = Join-Path $identityDir "not-goose"
        Set-Content -Path $notGooseShim -Value "#!/bin/sh`necho some-tool 2.0`n" -Encoding ASCII
        & chmod +x $gooseShim $notGooseShim
    }
    Assert-NoThrow "identity probe accepts a Goose-identifying source" {
        Assert-GooseBinaryIdentity -Path $gooseShim -BinName "goose"
    }
    Assert-Throws "identity probe rejects a non-Goose source" {
        Assert-GooseBinaryIdentity -Path $notGooseShim -BinName "goose"
    }
    Assert-Throws "identity probe rejects a missing source" {
        Assert-GooseBinaryIdentity -Path (Join-Path $identityDir "absent") -BinName "goose"
    }

    # ── Bundle and stage-sidecar call sites invoke native child processes ──
    # A successful in-process `& script.ps1` leaves $LASTEXITCODE unset, so the
    # old stale guard false-failed before the next step. Pin both public call
    # paths to Invoke-WindowsChildScript and reject stale LASTEXITCODE guards.
    $bundleScript = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "scripts/windows/Bundle-Windows.ps1")
    Assert-Equal "bundle runs staging via native child process" `
        ($bundleScript -match "Invoke-WindowsChildScript[^\r\n]*Stage-Sidecar-Windows\.ps1") $true
    Assert-Equal "bundle has no stale LASTEXITCODE guard" `
        ($bundleScript -match '\$LASTEXITCODE -ne 0') $false

    $stageWrapperPath = Join-Path (Get-BerdRepoRoot) "scripts/windows/Invoke-Stage-Sidecar-Windows.ps1"
    $stageWrapper = Get-Content -Raw $stageWrapperPath
    Assert-Equal "stage-sidecar wrapper runs staging via native child process" `
        ($stageWrapper -match "Invoke-WindowsChildScript[^\r\n]*StageScriptPath") $true
    Assert-Equal "stage-sidecar wrapper has no stale LASTEXITCODE guard" `
        ($stageWrapper -match '\$LASTEXITCODE -ne 0') $false

    # Invoke-WindowsChildScript reaches past a successful child and throws on a
    # failing one, using the current PowerShell host to run each child natively.
    $childDir = Join-Path $temp "child-scripts"
    New-Item -ItemType Directory -Force -Path $childDir | Out-Null
    $reachedMarker = Join-Path $childDir "reached.txt"
    $okChild = Join-Path $childDir "ok-child.ps1"
    Set-Content -Path $okChild -Value 'Write-Host "child ran"' -Encoding UTF8
    $failChild = Join-Path $childDir "fail-child.ps1"
    Set-Content -Path $failChild -Value 'exit 7' -Encoding UTF8
    Assert-NoThrow "child script driver reaches bundle step after a successful helper" {
        Invoke-WindowsChildScript -ScriptPath $okChild -Label "ok-child"
        Set-Content -Path $reachedMarker -Value "reached" -Encoding ASCII
    }
    Assert-Equal "driver executed the step after the successful child" (Test-Path $reachedMarker -PathType Leaf) $true
    Assert-Throws "child script driver throws on a failing helper" {
        Invoke-WindowsChildScript -ScriptPath $failChild -Label "fail-child"
    }
    Assert-NoThrow "stage-sidecar call site propagates successful staging child" {
        Invoke-WindowsChildScript -ScriptPath $stageWrapperPath `
            -ArgumentList @("-StageScriptPath", $okChild) -Label "stage-wrapper-success"
    }
    Assert-Throws "stage-sidecar call site propagates failing staging child" {
        Invoke-WindowsChildScript -ScriptPath $stageWrapperPath `
            -ArgumentList @("-StageScriptPath", $failChild) -Label "stage-wrapper-failure"
    }

    # ── PowerShell 5.1 compatibility of the bounded probe + child driver ──
    # The Windows lane runs under powershell.exe (5.1 / .NET Framework), where
    # ProcessStartInfo.ArgumentList and Process.Kill($true) do not exist. Guard
    # against a regression that reintroduces those APIs, and pin the 5.1-safe
    # shapes the fixes rely on.
    $moduleSource = Get-Content -Raw (Join-Path (Get-BerdRepoRoot) "scripts/windows/WindowsDev.psm1")
    Assert-Equal "bounded probe avoids .NET Core-only ArgumentList" `
        ($moduleSource -match '\$psi\.ArgumentList') $false
    Assert-Equal "bounded probe builds Arguments via the quoting helper" `
        ($moduleSource -match '\$psi\.Arguments\s*=\s*\(Join-WindowsProcessArguments') $true
    Assert-Equal "bounded probe avoids .NET Core-only Kill(bool) tree overload" `
        ($moduleSource -match '\.Kill\(\$true\)') $false

    # taskkill tree-kill command shape is a pure value: /PID <id> /T /F.
    $taskkillArgs = Get-TaskkillTreeArguments -ProcessId 4321
    Assert-Equal "taskkill targets the pid" ($taskkillArgs -join " ") "/PID 4321 /T /F"
    Assert-Equal "taskkill failure falls through to Process.Kill" `
        ($moduleSource -match '(?s)& taskkill\.exe @arguments 2>&1 \| Out-Null\s+if \(\$LASTEXITCODE -eq 0\) \{\s+return\s+\}.*?\$Process\.Kill\(\)') $true

    # Spaced/quoted arguments survive the 5.1 string Arguments round-trip: run a
    # child that echoes an argument containing spaces and confirm it comes back
    # intact through the quoting helper the bounded probe now uses.
    if (Test-IsWindowsHost) {
        $spaced = Invoke-BoundedCommand -FilePath "cmd.exe" -ArgumentList @("/c", "echo goose 1.7.0 (build x)") -TimeoutSeconds 10
    } else {
        $spaced = Invoke-BoundedCommand -FilePath "/bin/echo" -ArgumentList @("goose 1.7.0 (build x)") -TimeoutSeconds 10
    }
    Assert-Equal "bounded probe preserves spaced arguments" `
        ($spaced.Output -match "goose 1\.7\.0 \(build x\)") $true

    # ── Child driver passes -ExecutionPolicy Bypass for powershell.exe ──
    # Restricted/AllSigned machine policy would otherwise block the child even
    # though the parent lane started under Bypass. pwsh ignores per-invocation
    # policy, so the flag is conditioned on the powershell.exe host name.
    Assert-Equal "child driver conditions ExecutionPolicy Bypass on powershell.exe host" `
        ($moduleSource -match "(?s)GetFileNameWithoutExtension\(\`$shell\)\s*-ieq\s*`"powershell`".*?-ExecutionPolicy`",\s*`"Bypass`"") $true

    # ── Cleanup containment rules (Assert-SafeCleanupPath / Normalize-FullPath) ──
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
    $env:GOOSE_BUILD_PROFILE = $oldGooseBuildProfile
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
exit 0
