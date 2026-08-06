Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:RequiredPnpmVersion = "10.33.0"
$script:RequiredNodeVersion = "24.10.0"
$script:BlockNpmRegistry = "https://global.block-artifacts.com/artifactory/api/npm/square-npm/"
$script:WebView2ClientIds = @(
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "{F1E7DD3E-2BBD-4C03-AB8D-0808074AC3E6}"
)

function Test-IsWindowsHost {
    return $env:OS -eq "Windows_NT" -or [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-WindowsHost {
    if (-not (Test-IsWindowsHost)) {
        throw "This command is for native Windows verification. Use the existing Unix just recipes on macOS/Linux."
    }
}

function Get-BerdRepoRoot {
    return $script:RepoRoot
}

function Get-RequiredPnpmVersion {
    return $script:RequiredPnpmVersion
}

function Get-RequiredNodeVersion {
    return $script:RequiredNodeVersion
}

function Get-BlockNpmRegistry {
    return $script:BlockNpmRegistry
}

function Get-BlockRootCertPath {
    return (Join-Path $env:USERPROFILE ".block-certs\root-certs.pem")
}

function Get-RequiredRustVersion {
    $toolchainFile = Join-Path $script:RepoRoot "rust-toolchain.toml"
    $match = Select-String -Path $toolchainFile -Pattern '^\s*channel\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($null -eq $match) {
        throw "Could not read Rust channel from $toolchainFile."
    }
    return $match.Matches[0].Groups[1].Value
}

function Write-WindowsDevSection {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ""
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

function Write-WindowsDevInfo {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[berd-windows] $Message"
}

function Get-CommandSource {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command -and -not [System.IO.Path]::HasExtension($Name)) {
        $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($null -eq $command) {
        return $null
    }
    return $command.Source
}

function Get-NpmCommand {
    $cmd = Get-CommandSource "npm.cmd"
    if (-not [string]::IsNullOrWhiteSpace($cmd)) {
        return $cmd
    }
    return (Get-CommandSource "npm")
}

function Get-PnpmCommand {
    $cmd = Get-CommandSource "pnpm.cmd"
    if (-not [string]::IsNullOrWhiteSpace($cmd)) {
        return $cmd
    }
    return (Get-CommandSource "pnpm")
}

function Get-CorepackCommand {
    $cmd = Get-CommandSource "corepack.cmd"
    if (-not [string]::IsNullOrWhiteSpace($cmd)) {
        return $cmd
    }
    return (Get-CommandSource "corepack")
}

function Find-RunnablePython {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($name in @("python", "py")) {
        $source = Get-CommandSource $name
        if (-not [string]::IsNullOrWhiteSpace($source)) {
            $candidates.Add($source)
        }
    }

    $wherePython = Invoke-CaptureCommand -FilePath "where.exe" -ArgumentList @("python")
    if ($wherePython.ExitCode -eq 0) {
        foreach ($line in ($wherePython.Output -split "`r?`n")) {
            if (-not [string]::IsNullOrWhiteSpace($line)) {
                $candidates.Add($line.Trim())
            }
        }
    }

    $localPythonRoot = Join-Path (Get-LocalAppDataRoot) "Programs\Python"
    if (Test-Path $localPythonRoot -PathType Container) {
        Get-ChildItem $localPythonRoot -Recurse -Filter python.exe -ErrorAction SilentlyContinue |
            ForEach-Object { $candidates.Add($_.FullName) }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-CodexRuntimePath $candidate) {
            continue
        }
        $version = Invoke-CaptureCommand -FilePath $candidate -ArgumentList @("--version")
        if ($version.ExitCode -eq 0 -and $version.Output -match "Python\s+3\.") {
            return [pscustomobject]@{ Path = $candidate; Version = $version.Output.Trim() }
        }
    }

    return $null
}

function Repair-WindowsProcessEnvironment {
    # Managed launchers can provide a partial Windows environment (for
    # example PATHEXT=.CPL with no ComSpec/SystemDrive/ProgramData). Native
    # child processes then fail to resolve ordinary executables or expand
    # shell-folder paths. Repair only missing/invalid process values from
    # authoritative machine state; do not mutate persistent user settings.
    $machinePathExt = [Environment]::GetEnvironmentVariable("PATHEXT", "Machine")
    if (-not [string]::IsNullOrWhiteSpace($machinePathExt)) {
        $processPathExt = [Environment]::GetEnvironmentVariable("PATHEXT", "Process")
        $extensions = @($processPathExt -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        foreach ($requiredExtension in @(".COM", ".EXE", ".BAT", ".CMD")) {
            if ($extensions -inotcontains $requiredExtension) {
                [Environment]::SetEnvironmentVariable("PATHEXT", $machinePathExt, "Process")
                break
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:ComSpec)) {
        $comSpec = [Environment]::GetEnvironmentVariable("ComSpec", "Machine")
        if ([string]::IsNullOrWhiteSpace($comSpec) -and -not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
            $comSpec = Join-Path $env:SystemRoot "System32\cmd.exe"
        }
        if (-not [string]::IsNullOrWhiteSpace($comSpec)) {
            [Environment]::SetEnvironmentVariable("ComSpec", $comSpec, "Process")
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:SystemDrive) -and -not [string]::IsNullOrWhiteSpace($env:SystemRoot)) {
        $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
        if (-not [string]::IsNullOrWhiteSpace($systemDrive)) {
            [Environment]::SetEnvironmentVariable("SystemDrive", $systemDrive.TrimEnd('\'), "Process")
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:ProgramData)) {
        $shellFolders = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" -ErrorAction SilentlyContinue
        $programData = Get-ObjectValue $shellFolders "Common AppData"
        if ([string]::IsNullOrWhiteSpace($programData) -and -not [string]::IsNullOrWhiteSpace($env:SystemDrive)) {
            $programData = Join-Path $env:SystemDrive "ProgramData"
        }
        if (-not [string]::IsNullOrWhiteSpace($programData)) {
            [Environment]::SetEnvironmentVariable("ProgramData", $programData, "Process")
        }
    }
}

function Update-SessionPathFromRegistry {
    Repair-WindowsProcessEnvironment
    $pathParts = New-Object System.Collections.Generic.List[string]
    $processPath = [Environment]::GetEnvironmentVariable("Path", "Process")
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    foreach ($pathValue in @($processPath, $machinePath, $userPath)) {
        if ([string]::IsNullOrWhiteSpace($pathValue)) {
            continue
        }
        foreach ($part in ($pathValue -split ";")) {
            if (-not [string]::IsNullOrWhiteSpace($part) -and -not $pathParts.Contains($part)) {
                $pathParts.Add($part)
            }
        }
    }

    if ($pathParts.Count -gt 0) {
        $env:Path = ($pathParts -join ";")
    }
}

function Test-CodexRuntimePath {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }
    return $Path -match "\\\.cache\\codex-runtimes\\"
}

function Invoke-CaptureCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $stdout = New-TemporaryFile
    $stderr = New-TemporaryFile
    try {
        $arguments = Join-WindowsProcessArguments $ArgumentList
        $process = Start-Process -FilePath $FilePath -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout.FullName -RedirectStandardError $stderr.FullName
        $output = @()
        if (Test-Path $stdout.FullName) {
            $output += @(Get-Content $stdout.FullName -ErrorAction SilentlyContinue)
        }
        if (Test-Path $stderr.FullName) {
            $output += @(Get-Content $stderr.FullName -ErrorAction SilentlyContinue)
        }
    } finally {
        Remove-Item -LiteralPath $stdout.FullName, $stderr.FullName -Force -ErrorAction SilentlyContinue
    }

    $text = (@($output) -join [Environment]::NewLine).Trim()
    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = $text
        Lines = @($output)
    }
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path,
        [string]$Label = $FilePath
    )

    Write-WindowsDevInfo $Label
    $resolved = Get-CommandSource $FilePath
    if (-not [string]::IsNullOrWhiteSpace($resolved)) {
        $FilePath = $resolved
    }

    if ([System.IO.Path]::GetExtension($FilePath) -ieq ".cmd" -or [System.IO.Path]::GetExtension($FilePath) -ieq ".bat") {
        $command = "`"$FilePath`" $(Join-WindowsProcessArguments $ArgumentList)"
        $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/d /s /c `"$command`"" -WorkingDirectory $WorkingDirectory -Wait -PassThru -NoNewWindow
    } else {
        $arguments = Join-WindowsProcessArguments $ArgumentList
        $process = Start-Process -FilePath $FilePath -ArgumentList $arguments -WorkingDirectory $WorkingDirectory -Wait -PassThru -NoNewWindow
    }
    if ($process.ExitCode -ne 0) {
        throw "$Label failed with exit code $($process.ExitCode)."
    }
}

function Join-WindowsProcessArguments {
    param([string[]]$Arguments)
    $quoted = foreach ($argument in $Arguments) {
        if ($argument -match '[\s"]') {
            # MSVCRT quoting: backslashes are literal except when they precede
            # a double quote, so double any run of trailing backslashes before
            # an escaped quote or the closing quote (`C:\path\` stays intact).
            $escaped = $argument -replace '(\\*)"', '$1$1\"'
            $escaped = $escaped -replace '(\\+)$', '$1$1'
            '"' + $escaped + '"'
        } else {
            $argument
        }
    }
    return ($quoted -join " ")
}

# Single source of truth for the cargo feature set of the full dev posture on
# Windows (mirrors `app_features` in the justfile).
function Get-BerdAppFeatures {
    return "berdctl,app-test-driver"
}

function Normalize-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not [System.IO.Path]::IsPathRooted($Path)) {
        # GetFullPath resolves relative paths against the process CWD, which
        # PowerShell's Set-Location does not update; cleanup paths must always
        # be rooted so a stray relative value cannot resolve somewhere else.
        throw "Refusing to normalize relative path '$Path'; cleanup paths must be absolute."
    }
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-SafeCleanupPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )
    $full = Normalize-FullPath $Path
    $root = Normalize-FullPath $AllowedRoot

    # Never allow removal of broad user/system roots, whatever the caller
    # passed as AllowedRoot; a bad env override must not become `rm -rf $HOME`.
    $protected = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP, $env:SystemRoot, $env:ProgramFiles, $HOME, (Get-BerdRepoRoot))) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $protected.Add((Normalize-FullPath $candidate))
        }
    }
    if ([System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/') -eq $full) {
        throw "Refusing to remove drive root $Path."
    }
    foreach ($protectedRoot in $protected) {
        if ($full -ieq $protectedRoot) {
            throw "Refusing to remove protected directory $Path."
        }
    }

    if ($full -ieq $root) {
        return
    }
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    throw "Refusing to remove $Path because it is outside expected cleanup root $AllowedRoot."
}

function Get-LocalAppDataRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        return $env:LOCALAPPDATA
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return (Join-Path $env:USERPROFILE "AppData\Local")
    }
    return (Join-Path $HOME "AppData\Local")
}

function Get-UserProfileRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return $env:USERPROFILE
    }
    return $HOME
}

function Get-RoamingAppDataRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        return $env:APPDATA
    }
    return (Join-Path (Get-UserProfileRoot) "AppData\Roaming")
}

function Get-FnmRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:FNM_DIR)) {
        return $env:FNM_DIR
    }
    return (Join-Path (Get-RoamingAppDataRoot) "fnm")
}

function Resolve-WindowsCleanupPaths {
    $localAppData = Get-LocalAppDataRoot
    $userProfile = Get-UserProfileRoot
    $fnmRoot = Get-FnmRoot
    $blockCertDir = Join-Path $userProfile ".block-certs"
    $nodeVersion = "v$(Get-RequiredNodeVersion)"
    $repoRoot = Get-BerdRepoRoot

    # Honor the same overrides the rest of the lane uses so cleanup targets
    # the state that setup/dev actually created. A BERD_TAURI_CARGO_TARGET_DIR
    # override points directly at a cargo target dir; only that dir is
    # Berd-owned, not its parent.
    $berdTauriRoot = Join-Path $localAppData "berd-tauri"
    if (-not [string]::IsNullOrWhiteSpace($env:BERD_TAURI_CARGO_TARGET_DIR)) {
        $berdTauriRoot = $env:BERD_TAURI_CARGO_TARGET_DIR
    }

    return [pscustomobject]@{
        BerdDevRoot = (Resolve-GooseDevPaths).DevRoot
        BerdTauriRoot = $berdTauriRoot
        BlockCertDir = $blockCertDir
        BlockCertFile = Join-Path $blockCertDir "root-certs.pem"
        CorepackPnpmVersionDir = Join-Path $localAppData "node\corepack\v1\pnpm\$(Get-RequiredPnpmVersion)"
        FnmRoot = $fnmRoot
        FnmNodeVersionDir = Join-Path $fnmRoot "node-versions\$nodeVersion"
        FnmMultishellsDir = Join-Path $localAppData "fnm_multishells"
        RepoNodeModules = Join-Path $repoRoot "node_modules"
        RepoPnpmStore = Join-Path $repoRoot ".pnpm-store"
        RepoDist = Join-Path $repoRoot "dist"
        SdkNodeModules = Join-Path $repoRoot "sdk\node_modules"
        SdkDist = Join-Path $repoRoot "sdk\dist"
        GitHooksDir = Join-Path $repoRoot ".git\hooks"
    }
}

function Get-BlockNpmEnvironmentTargets {
    $paths = Resolve-WindowsCleanupPaths
    return @(
        [pscustomobject]@{ Name = "NPM_CONFIG_REGISTRY"; ExpectedValue = $script:BlockNpmRegistry },
        [pscustomobject]@{ Name = "NPM_CONFIG_CAFILE"; ExpectedValue = $paths.BlockCertFile },
        [pscustomobject]@{ Name = "NODE_EXTRA_CA_CERTS"; ExpectedValue = $paths.BlockCertFile },
        [pscustomobject]@{ Name = "COREPACK_NPM_REGISTRY"; ExpectedValue = $script:BlockNpmRegistry },
        [pscustomobject]@{ Name = "COREPACK_INTEGRITY_KEYS"; ExpectedValue = "0" }
    )
}

function Resolve-GooseDevPaths {
    $devRoot = $env:GOOSE_DEV_ROOT
    if ([string]::IsNullOrWhiteSpace($devRoot)) {
        $devRoot = Join-Path (Get-LocalAppDataRoot) "berd-dev"
    }

    $repo = $env:GOOSE_DEV_REPO
    if ([string]::IsNullOrWhiteSpace($repo)) {
        $repo = Join-Path $devRoot "goose"
    }

    $cargoTarget = $env:GOOSE_DEV_CARGO_TARGET_DIR
    if ([string]::IsNullOrWhiteSpace($cargoTarget)) {
        $cargoTarget = Join-Path $devRoot "cargo-target"
    }

    $stampFile = $env:GOOSE_DEV_STAMP_FILE
    if ([string]::IsNullOrWhiteSpace($stampFile)) {
        $stampFile = Join-Path $devRoot "stamp.json"
    }

    return [pscustomobject]@{
        DevRoot = $devRoot
        Repo = $repo
        CargoTargetDir = $cargoTarget
        StampFile = $stampFile
    }
}

function Get-TauriCargoTargetDir {
    if (-not [string]::IsNullOrWhiteSpace($env:BERD_TAURI_CARGO_TARGET_DIR)) {
        return $env:BERD_TAURI_CARGO_TARGET_DIR
    }
    return (Join-Path (Get-LocalAppDataRoot) "berd-tauri\cargo-target")
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-Content -Raw -Path $Path | ConvertFrom-Json)
}

function Get-ObjectValue {
    param(
        [AllowNull()]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Test-WindowsCommandAvailability {
    param([Parameter(Mandatory = $true)][string]$Name)

    $source = Get-CommandSource $Name
    $usesCodexRuntime = (-not [string]::IsNullOrWhiteSpace($source)) -and (Test-CodexRuntimePath $source)
    return [pscustomobject]@{
        Name = $Name
        Source = $source
        Available = (-not [string]::IsNullOrWhiteSpace($source)) -and (-not $usesCodexRuntime)
        UsesCodexRuntime = $usesCodexRuntime
    }
}

# Availability check from an already-resolved source path (used for tools like
# pnpm/corepack where the shim name varies: pnpm.cmd, pnpm.exe, pnpm.ps1).
function Test-ResolvedCommandAvailability {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][AllowEmptyString()][string]$Source
    )
    $usesCodexRuntime = (-not [string]::IsNullOrWhiteSpace($Source)) -and (Test-CodexRuntimePath $Source)
    return [pscustomobject]@{
        Name = $Name
        Source = $Source
        Available = (-not [string]::IsNullOrWhiteSpace($Source)) -and (-not $usesCodexRuntime)
        UsesCodexRuntime = $usesCodexRuntime
    }
}

function Test-PnpmVersion {
    param([AllowNull()][AllowEmptyString()][string]$Version)

    return (-not [string]::IsNullOrWhiteSpace($Version)) -and ($Version.Trim() -eq (Get-RequiredPnpmVersion))
}

function Get-PnpmReadiness {
    param([AllowNull()][AllowEmptyString()][string]$Source = (Get-PnpmCommand))

    $availability = Test-ResolvedCommandAvailability -Name "pnpm" -Source $Source
    $version = $null
    if ($availability.Available) {
        $result = Invoke-CaptureCommand -FilePath $Source -ArgumentList @("--version")
        if ($result.ExitCode -eq 0) {
            $version = $result.Output.Trim()
        }
    }

    return [pscustomobject]@{
        Name = $availability.Name
        Source = $availability.Source
        Available = $availability.Available
        UsesCodexRuntime = $availability.UsesCodexRuntime
        Version = $version
        Ready = Test-PnpmVersion -Version $version
    }
}

function Get-WindowsPrerequisiteSnapshot {
    $winGet = Test-WindowsCommandAvailability "winget"
    $git = Test-WindowsCommandAvailability "git"
    $rustup = Test-WindowsCommandAvailability "rustup"
    $rustc = Test-WindowsCommandAvailability "rustc"
    $cargo = Test-WindowsCommandAvailability "cargo"
    $fnm = Test-WindowsCommandAvailability "fnm"

    if ($fnm.Available) {
        Initialize-FnmEnvironment | Out-Null
    }

    $node = Test-WindowsCommandAvailability "node"
    $corepack = Test-ResolvedCommandAvailability -Name "corepack" -Source (Get-CorepackCommand)
    $pnpm = Get-PnpmReadiness
    $cmake = Test-WindowsCommandAvailability "cmake"
    $jq = Test-WindowsCommandAvailability "jq"
    $just = Test-WindowsCommandAvailability "just"
    $lefthook = Test-WindowsCommandAvailability "lefthook"

    $gitBash = Get-GitBashPath
    $msvcPath = Get-MsvcInstallPath
    $buildToolsPath = $null
    if ([string]::IsNullOrWhiteSpace($msvcPath)) {
        $buildToolsPath = Get-VisualStudioBuildToolsInstallPath
    }
    $msvcReady = $false
    if (-not [string]::IsNullOrWhiteSpace($msvcPath)) {
        $msvcReady = (Initialize-MsvcEnvironment) -and -not [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))
    }

    $blockNpmReachability = $null
    if ($node.Available) {
        $blockNpmReachability = Test-BlockNpmRegistryReachability
    }

    return [pscustomobject]@{
        WinGet = $winGet
        Git = $git
        GitBash = [pscustomobject]@{ Found = -not [string]::IsNullOrWhiteSpace($gitBash); Path = $gitBash }
        Msvc = [pscustomobject]@{ Ready = $msvcReady; InstallPath = $msvcPath; BuildToolsPath = $buildToolsPath }
        WebView2 = Test-WebView2Runtime
        Rustup = $rustup
        Rustc = $rustc
        Cargo = $cargo
        Fnm = $fnm
        Node = $node
        Corepack = $corepack
        Pnpm = $pnpm
        BlockNpmReachability = $blockNpmReachability
        Cmake = $cmake
        LibClangPath = Get-LibClangPath
        Jq = $jq
        Python = Find-RunnablePython
        Just = $just
        Lefthook = $lefthook
    }
}

function Get-CargoMetadataTargetDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Fallback
    )

    $metadata = Invoke-CaptureCommand -FilePath "cargo" -ArgumentList @("metadata", "--no-deps", "--format-version", "1") -WorkingDirectory $WorkingDirectory
    if ($metadata.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($metadata.Output)) {
        try {
            $parsed = $metadata.Output | ConvertFrom-Json
            $resolvedTarget = Get-ObjectValue $parsed "target_directory"
            if (-not [string]::IsNullOrWhiteSpace($resolvedTarget)) {
                return $resolvedTarget
            }
        } catch {
            return $Fallback
        }
    }

    return $Fallback
}

function Get-GooseBackendSettings {
    $lockFile = $env:GOOSE_BACKEND_LOCK_FILE
    if ([string]::IsNullOrWhiteSpace($lockFile)) {
        $lockFile = Join-Path $script:RepoRoot "goose-backend.lock.json"
    }

    $lock = $null
    if (Test-Path $lockFile -PathType Leaf) {
        $lock = Read-JsonFile $lockFile
    }

    $repo = $env:GOOSE_DEV_CLONE_URL
    if ([string]::IsNullOrWhiteSpace($repo)) {
        $repo = Get-ObjectValue $lock "repo"
    }
    if ([string]::IsNullOrWhiteSpace($repo)) {
        $repo = "https://github.com/aaif-goose/goose.git"
    }

    $ref = $env:GOOSE_DEV_REF
    if ([string]::IsNullOrWhiteSpace($ref)) {
        $ref = $env:GOOSE_DEV_BRANCH
    }
    if ([string]::IsNullOrWhiteSpace($ref)) {
        $ref = Get-ObjectValue $lock "ref"
    }
    if ([string]::IsNullOrWhiteSpace($ref)) {
        $ref = "main"
    }

    $commit = $env:GOOSE_DEV_COMMIT
    if ([string]::IsNullOrWhiteSpace($commit)) {
        $commit = Get-ObjectValue $lock "commit"
    }

    $package = $env:GOOSE_DEV_PACKAGE
    if ([string]::IsNullOrWhiteSpace($package)) {
        $package = Get-ObjectValue $lock "package"
    }
    if ([string]::IsNullOrWhiteSpace($package)) {
        $package = "goose-cli"
    }

    $bin = $env:GOOSE_DEV_BIN
    if ([string]::IsNullOrWhiteSpace($bin)) {
        $bin = Get-ObjectValue $lock "bin"
    }
    if ([string]::IsNullOrWhiteSpace($bin)) {
        $bin = "goose"
    }

    $mode = $env:GOOSE_DEV_MODE
    if ([string]::IsNullOrWhiteSpace($mode)) {
        $mode = "auto"
    }

    $remote = $env:GOOSE_DEV_REMOTE
    if ([string]::IsNullOrWhiteSpace($remote)) {
        $remote = "origin"
    }

    return [pscustomobject]@{
        LockFile = $lockFile
        CloneUrl = $repo
        Ref = $ref
        Commit = $commit
        Package = $package
        Bin = $bin
        Mode = $mode
        Remote = $remote
        AllowDirty = ($env:GOOSE_DEV_ALLOW_DIRTY -eq "1")
    }
}

function Get-WindowsExeName {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Name
    }
    return "$Name.exe"
}

function Resolve-GooseBinaryPath {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings
    )

    $targetDir = $Paths.CargoTargetDir
    if (Test-Path $Paths.Repo -PathType Container) {
        $targetDir = Get-CargoMetadataTargetDirectory -WorkingDirectory $Paths.Repo -Fallback $Paths.CargoTargetDir
    }

    return (Join-Path (Join-Path $targetDir "debug") (Get-WindowsExeName $Settings.Bin))
}

function Test-GooseCheckoutDirtyAllowed {
    param([Parameter(Mandatory = $true)][string]$Repo)

    $dirty = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $Repo, "status", "--porcelain")
    if ($dirty.ExitCode -ne 0) {
        return [pscustomobject]@{ Allowed = $false; Message = "Could not inspect managed Goose checkout at $Repo." }
    }
    if ([string]::IsNullOrWhiteSpace($dirty.Output)) {
        return [pscustomobject]@{ Allowed = $true; Message = "" }
    }

    return [pscustomobject]@{ Allowed = $false; Message = "Managed Goose checkout at $Repo is dirty. Use a dedicated checkout or set GOOSE_DEV_ALLOW_DIRTY=1." }
}

function Read-GooseStamp {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path -PathType Leaf)) {
        return $null
    }
    return Read-JsonFile $Path
}

function Write-GooseStamp {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)][string]$Commit,
        [Parameter(Mandatory = $true)][string]$BinPath
    )

    $parent = Split-Path -Parent $Paths.StampFile
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $stamp = [ordered]@{
        repo = $Paths.Repo
        lockFile = $Settings.LockFile
        ref = $Settings.Ref
        commit = $Commit
        package = $Settings.Package
        binName = $Settings.Bin
        bin = $BinPath
    }
    $stamp | ConvertTo-Json -Depth 4 | Set-Content -Path $Paths.StampFile -Encoding UTF8
}

function Test-GooseStampRecordMatches {
    param(
        [AllowNull()]$Stamp,
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)][string]$BinPath,
        [AllowNull()][string]$LocalHead
    )

    if ($null -eq $Stamp) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "repo") -ne $Paths.Repo) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "ref") -ne $Settings.Ref) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "commit") -ne $Settings.Commit) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "package") -ne $Settings.Package) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "binName") -ne $Settings.Bin) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "bin") -ne $BinPath) {
        return $false
    }
    if (-not (Test-Path $BinPath -PathType Leaf)) {
        return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($LocalHead) -and (Get-ObjectValue $Stamp "commit") -ne $LocalHead) {
        return $false
    }
    return $true
}

function Get-GitHead {
    param([Parameter(Mandatory = $true)][string]$Repo)
    $result = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $Repo, "rev-parse", "HEAD")
    if ($result.ExitCode -ne 0) {
        return $null
    }
    return $result.Output.Trim()
}

function New-GooseResult {
    param(
        [Parameter(Mandatory = $true)][int]$ExitCode,
        [Parameter(Mandatory = $true)][bool]$Ready,
        [AllowNull()][string]$BinPath,
        [Parameter(Mandatory = $true)][string]$Message
    )
    return [pscustomobject]@{
        ExitCode = $ExitCode
        Ready = $Ready
        BinPath = $BinPath
        Message = $Message
    }
}

function Resolve-GooseFailure {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)][string]$Mode
    )
    if ($Mode -eq "required") {
        throw $Message
    }
    Write-WindowsDevInfo $Message
    if ($Action -eq "Check") {
        return (New-GooseResult -ExitCode 2 -Ready $false -BinPath $null -Message $Message)
    }
    return (New-GooseResult -ExitCode 0 -Ready $false -BinPath $null -Message $Message)
}

function Initialize-GooseManagedCheckout {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)][string]$Action
    )

    if (Test-Path (Join-Path $Paths.Repo ".git") -PathType Container) {
        return $null
    }

    if ($Action -eq "Check") {
        return (Resolve-GooseFailure -Message "Managed Goose checkout not found at $($Paths.Repo). Run 'just setup-windows'." -Action $Action -Mode $Settings.Mode)
    }

    Write-WindowsDevInfo "Cloning managed Goose checkout into $($Paths.Repo)."
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Paths.Repo) | Out-Null
    Invoke-CheckedCommand -FilePath "git" -ArgumentList @("clone", $Settings.CloneUrl, $Paths.Repo) -Label "git clone Goose"
    return $null
}

function Resolve-GooseManagedCommit {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)][string]$Action
    )

    if (-not [string]::IsNullOrWhiteSpace($Settings.Commit)) {
        return $null
    }

    $resolved = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $Paths.Repo, "ls-remote", $Settings.Remote, $Settings.Ref)
    if ($resolved.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($resolved.Output)) {
        return (Resolve-GooseFailure -Message "Could not resolve Goose ref $($Settings.Remote)/$($Settings.Ref) for managed checkout at $($Paths.Repo)." -Action $Action -Mode $Settings.Mode)
    }

    $Settings.Commit = ($resolved.Output -split "\s+")[0]
    return $null
}

function Sync-GooseManagedCheckout {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)][string]$Action
    )

    Write-WindowsDevInfo "Fetching pinned Goose ref $($Settings.Ref)."
    $fetch = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $Paths.Repo, "fetch", $Settings.Remote, $Settings.Ref)
    if ($fetch.ExitCode -ne 0) {
        Write-WindowsDevInfo "Direct fetch of $($Settings.Ref) failed; fetching all remote heads and tags."
        $fetchAll = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $Paths.Repo, "fetch", $Settings.Remote, "--tags", "+refs/heads/*:refs/remotes/$($Settings.Remote)/*")
        if ($fetchAll.ExitCode -ne 0) {
            return (Resolve-GooseFailure -Message "Failed to fetch Goose ref $($Settings.Ref) from $($Settings.Remote)." -Action $Action -Mode $Settings.Mode)
        }
    }

    $commitExists = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $Paths.Repo, "cat-file", "-e", "$($Settings.Commit)^{commit}")
    if ($commitExists.ExitCode -ne 0) {
        return (Resolve-GooseFailure -Message "Pinned Goose commit $($Settings.Commit) is not available after fetching $($Settings.Ref)." -Action $Action -Mode $Settings.Mode)
    }

    Invoke-CheckedCommand -FilePath "git" -ArgumentList @("-C", $Paths.Repo, "checkout", "--detach", $Settings.Commit) -Label "checkout pinned Goose commit"
    Invoke-CheckedCommand -FilePath "git" -ArgumentList @("-C", $Paths.Repo, "reset", "--hard", $Settings.Commit) -Label "reset managed Goose checkout"
    return $null
}

function Build-GooseManagedBinary {
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)]$Settings,
        [Parameter(Mandatory = $true)][string]$BinPath
    )

    Write-WindowsDevInfo "Building Goose from $($Paths.Repo) at $($Settings.Commit)."
    # --locked keeps the build on the pinned commit's Cargo.lock; without it
    # cargo may resolve newer deps and the stamp would record a binary that
    # does not match the pin.
    Invoke-CheckedCommand -FilePath "cargo" -ArgumentList @("build", "--locked", "-p", $Settings.Package, "--bin", $Settings.Bin) -WorkingDirectory $Paths.Repo -Label "cargo build Goose"

    if (-not (Test-Path $BinPath -PathType Leaf)) {
        throw "Expected Goose binary at $BinPath, but it was not built."
    }

    $headAfterBuild = Get-GitHead -Repo $Paths.Repo
    Write-GooseStamp -Paths $Paths -Settings $Settings -Commit $headAfterBuild -BinPath $BinPath
    Write-WindowsDevInfo "Local Goose binary ready at $BinPath."
    return (New-GooseResult -ExitCode 0 -Ready $true -BinPath $BinPath -Message "Local Goose binary is ready.")
}

function Invoke-EnsureLocalGoose {
    param(
        [ValidateSet("Build", "Check")][string]$Action = "Build"
    )

    Assert-WindowsHost

    $settings = Get-GooseBackendSettings
    $paths = Resolve-GooseDevPaths
    $env:CARGO_TARGET_DIR = $paths.CargoTargetDir

    $checkoutFailure = Initialize-GooseManagedCheckout -Paths $paths -Settings $settings -Action $Action
    if ($null -ne $checkoutFailure) {
        return $checkoutFailure
    }

    $binPath = Resolve-GooseBinaryPath -Paths $paths -Settings $settings

    if (-not $settings.AllowDirty) {
        $dirty = Test-GooseCheckoutDirtyAllowed -Repo $paths.Repo
        if (-not $dirty.Allowed) {
            return (Resolve-GooseFailure -Message $dirty.Message -Action $Action -Mode $settings.Mode)
        }
    }

    $localHead = Get-GitHead -Repo $paths.Repo
    $stamp = Read-GooseStamp -Path $paths.StampFile

    if ($Action -eq "Check") {
        if (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $binPath -LocalHead $localHead) {
            return (New-GooseResult -ExitCode 0 -Ready $true -BinPath $binPath -Message "Local Goose binary is ready.")
        }
        return (Resolve-GooseFailure -Message "Local Goose binary is not ready for $($settings.Ref) at $($settings.Commit). Run 'just setup-windows'." -Action $Action -Mode $settings.Mode)
    }

    $commitFailure = Resolve-GooseManagedCommit -Paths $paths -Settings $settings -Action $Action
    if ($null -ne $commitFailure) {
        return $commitFailure
    }

    if (Test-GooseStampRecordMatches -Stamp $stamp -Paths $paths -Settings $settings -BinPath $binPath -LocalHead $localHead) {
        Write-WindowsDevInfo "Local Goose binary already matches $($settings.Ref) at $($settings.Commit)."
        return (New-GooseResult -ExitCode 0 -Ready $true -BinPath $binPath -Message "Local Goose binary is ready.")
    }

    Assert-MsvcEnvironment
    Assert-LibClangEnvironment

    $syncFailure = Sync-GooseManagedCheckout -Paths $paths -Settings $settings -Action $Action
    if ($null -ne $syncFailure) {
        return $syncFailure
    }

    return (Build-GooseManagedBinary -Paths $paths -Settings $settings -BinPath $binPath)
}

function Get-GitDescribeVersion {
    $describe = Invoke-CaptureCommand -FilePath "git" -ArgumentList @("-C", $script:RepoRoot, "describe", "--tags", "--long", "--dirty", "--match", "v[0-9]*.[0-9]*.[0-9]*")
    if ($describe.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($describe.Output)) {
        return $null
    }
    $value = $describe.Output.Trim()
    if ($value -match '^v?([0-9]+)\.([0-9]+)\.([0-9]+)-([0-9]+)-g([0-9a-f]+)(-dirty)?$') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        $patch = [int]$Matches[3]
        $commits = [int]$Matches[4]
        $sha = $Matches[5]
        $dirty = $Matches[6]
        if ($commits -eq 0 -and [string]::IsNullOrWhiteSpace($dirty)) {
            $numeric = "$major.$minor.$patch"
            return [pscustomobject]@{ Version = $numeric; RichVersion = $numeric }
        }
        $numeric = "$major.$minor.$($patch + 1)"
        $rich = "$numeric-dev.$commits+g$sha"
        if (-not [string]::IsNullOrWhiteSpace($dirty)) {
            $rich = "$rich.dirty"
        }
        return [pscustomobject]@{ Version = $numeric; RichVersion = $rich }
    }
    return $null
}

function Resolve-AppVersion {
    param([AllowNull()][string]$Override)

    if ([string]::IsNullOrWhiteSpace($Override)) {
        $Override = $env:BERD_APP_VERSION_OVERRIDE
    }
    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        $numeric = ($Override -split "[-+]")[0]
        return [pscustomobject]@{ Version = $numeric; RichVersion = $Override }
    }

    $gitVersion = Get-GitDescribeVersion
    if ($null -ne $gitVersion) {
        return $gitVersion
    }

    $package = Read-JsonFile (Join-Path $script:RepoRoot "package.json")
    $version = Get-ObjectValue $package "version"
    return [pscustomobject]@{ Version = $version; RichVersion = $version }
}

function New-E2eRunContract {
    param(
        [Parameter(Mandatory = $true)][string]$RunRoot,
        [AllowNull()][AllowEmptyString()][string]$RunId,
        [AllowNull()][AllowEmptyString()][string]$DriverToken
    )

    $normalizedRoot = Normalize-FullPath $RunRoot
    $rootRunId = Split-Path -Leaf $normalizedRoot
    if ([string]::IsNullOrWhiteSpace($RunId)) {
        $RunId = $rootRunId
    }
    if ($RunId -notmatch '^[A-Za-z0-9-]{1,64}$') {
        throw "BERD_E2E_RUN_ID must be 1-64 ASCII letters, digits, or '-'."
    }
    if ($rootRunId -cne $RunId) {
        throw "BERD_E2E_RUN_ROOT must end with BERD_E2E_RUN_ID '$RunId'."
    }

    if ([string]::IsNullOrWhiteSpace($DriverToken)) {
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $rng.GetBytes($bytes)
        } finally {
            $rng.Dispose()
        }
        $DriverToken = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    }
    if ($DriverToken -cnotmatch '^[A-Za-z0-9]{32,128}$') {
        throw "APP_TEST_DRIVER_TOKEN must be 32-128 ASCII letters or digits."
    }

    return [pscustomobject]@{
        RunRoot = $normalizedRoot
        RunId = $RunId
        Identifier = "xyz.block.berd.e2e.$RunId"
        DriverToken = $DriverToken
        ConfigPath = Join-Path $normalizedRoot "tauri-dev-windows.config.json"
        DriverReadyPath = Join-Path $normalizedRoot "app-test-driver.json"
    }
}

function Get-StableVitePort {
    $path = (Get-Location).Path
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($path)
    $hash = $sha.ComputeHash($bytes)
    # Match the unix recipe exactly: python's int(hexdigest, 16) reads the
    # digest big-endian; BigInteger wants little-endian with a zero pad byte
    # to stay unsigned.
    [System.Array]::Reverse($hash)
    $unsigned = New-Object byte[] ($hash.Length + 1)
    [System.Array]::Copy($hash, 0, $unsigned, 0, $hash.Length)
    $value = New-Object System.Numerics.BigInteger (, $unsigned)
    return [int](10000 + ($value % 55000))
}

function Get-RustHostTriple {
    $result = Invoke-CaptureCommand -FilePath "rustc" -ArgumentList @("-vV")
    if ($result.ExitCode -ne 0) {
        return $null
    }
    foreach ($line in ($result.Output -split "`r?`n")) {
        if ($line -match '^host:\s*(.+)$') {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Get-GitBashPath {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Git\bin\bash.exe")
    }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "Git\bin\bash.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return (Get-CommandSource "bash")
}

function Get-VsWherePath {
    $candidates = @()
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return (Get-CommandSource "vswhere")
}

function Get-VsInstallerPath {
    $candidates = @()
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\setup.exe")
        $candidates += (Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vs_installer.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\setup.exe")
        $candidates += (Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vs_installer.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
    }
    return (Get-CommandSource "vs_installer")
}

function Get-VisualStudioInstallPathFromInstanceState {
    $programData = $env:ProgramData
    if ([string]::IsNullOrWhiteSpace($programData)) {
        $systemDrive = $env:SystemDrive
        if ([string]::IsNullOrWhiteSpace($systemDrive)) {
            $systemDrive = [System.IO.Path]::GetPathRoot($env:SystemRoot)
        }
        if ([string]::IsNullOrWhiteSpace($systemDrive)) {
            return $null
        }
        $programData = Join-Path $systemDrive "ProgramData"
    }
    $instancesRoot = Join-Path $programData "Microsoft\VisualStudio\Packages\_Instances"
    if (-not (Test-Path $instancesRoot -PathType Container)) {
        return $null
    }

    # Recovery path for hosts where Visual Studio Installer state exists but
    # vswhere returns nothing. Never guess an install path from directory names.
    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($stateFile in Get-ChildItem $instancesRoot -Filter "state.json" -Recurse -File -ErrorAction SilentlyContinue) {
        try {
            $state = Get-Content $stateFile.FullName -Raw | ConvertFrom-Json
            $installPath = Get-ObjectValue $state "installationPath"
            $product = Get-ObjectValue (Get-ObjectValue $state "product") "id"
            $isComplete = Get-ObjectValue $state "isComplete"
            $isLaunchable = Get-ObjectValue $state "isLaunchable"
            $vsDevCmd = if ([string]::IsNullOrWhiteSpace($installPath)) { $null } else { Join-Path $installPath "Common7\Tools\VsDevCmd.bat" }
            if ($product -eq "Microsoft.VisualStudio.Product.BuildTools" -and
                -not [string]::IsNullOrWhiteSpace($installPath) -and
                $isComplete -ne $false -and
                $isLaunchable -ne $false -and
                (Test-Path $vsDevCmd -PathType Leaf)) {
                $candidates.Add([pscustomobject]@{
                    InstallPath = $installPath
                    InstalledAt = $stateFile.LastWriteTimeUtc
                })
            }
        } catch {
            continue
        }
    }

    $selected = $candidates | Sort-Object InstalledAt -Descending | Select-Object -First 1
    if ($null -eq $selected) {
        return $null
    }
    return $selected.InstallPath
}
function Get-VisualStudioBuildToolsInstallPath {
    $vswhere = Get-VsWherePath
    if (-not [string]::IsNullOrWhiteSpace($vswhere)) {
        $result = Invoke-CaptureCommand -FilePath $vswhere -ArgumentList @("-latest", "-products", "Microsoft.VisualStudio.Product.BuildTools", "-property", "installationPath")
        if ($result.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($result.Output)) {
            return ($result.Output -split "`r?`n" | Select-Object -First 1).Trim()
        }
    }
    return (Get-VisualStudioInstallPathFromInstanceState)
}

function Get-MsvcInstallPath {
    $vswhere = Get-VsWherePath
    if (-not [string]::IsNullOrWhiteSpace($vswhere)) {
        $result = Invoke-CaptureCommand -FilePath $vswhere -ArgumentList @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath")
        if ($result.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($result.Output)) {
            return ($result.Output -split "`r?`n" | Select-Object -First 1).Trim()
        }
    }
    return (Get-VisualStudioInstallPathFromInstanceState)
}

function Get-MsvcArch {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
        return "arm64"
    }
    return "x64"
}

function Initialize-MsvcEnvironment {
    $installPath = Get-MsvcInstallPath
    if ([string]::IsNullOrWhiteSpace($installPath)) {
        return $false
    }

    $vsDevCmd = Join-Path $installPath "Common7\Tools\VsDevCmd.bat"
    if (-not (Test-Path $vsDevCmd -PathType Leaf)) {
        return $false
    }

    $arch = Get-MsvcArch
    $environmentFile = New-TemporaryFile
    try {
        # Capturing `cmd.exe` output directly through Windows PowerShell can
        # return no pipeline records for batch files on some hosts. Have cmd
        # write the environment itself, then import the stable file contents.
        $command = "call `"$vsDevCmd`" -no_logo -arch=$arch -host_arch=$arch >nul && set > `"$($environmentFile.FullName)`""
        $arguments = "/d /s /c `"$command`""
        $process = Start-Process cmd.exe -ArgumentList $arguments -Wait -PassThru -NoNewWindow
        if ($process.ExitCode -ne 0) {
            return $false
        }
        $lines = Get-Content $environmentFile.FullName -ErrorAction Stop
    } finally {
        Remove-Item -LiteralPath $environmentFile.FullName -Force -ErrorAction SilentlyContinue
    }

    if ($null -eq $lines) {
        return $false
    }
    foreach ($line in $lines) {
        if ($line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
    Repair-WindowsSdkEnvironment
    return $true
}

function Repair-WindowsSdkEnvironment {
    if (-not [string]::IsNullOrWhiteSpace($env:WindowsSdkDir) -and
        -not [string]::IsNullOrWhiteSpace($env:WindowsSDKVersion) -and
        $env:WindowsSDKVersion -ne "\") {
        return
    }

    $sdk = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SDKs\Windows\v10.0" -ErrorAction SilentlyContinue
    if ($null -eq $sdk -or [string]::IsNullOrWhiteSpace($sdk.InstallationFolder)) {
        return
    }
    $versions = Get-ChildItem (Join-Path $sdk.InstallationFolder "Include") -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName "um\Windows.h") } |
        Sort-Object { [version]$_.Name } -Descending
    $version = $versions | Select-Object -First 1
    if ($null -eq $version) {
        return
    }

    $env:WindowsSdkDir = $sdk.InstallationFolder
    $env:WindowsSDKVersion = "$($version.Name)\"
    $env:UniversalCRTSdkDir = $sdk.InstallationFolder
    $env:UCRTVersion = $version.Name

    $include = @(
        (Join-Path $version.FullName "ucrt"),
        (Join-Path $version.FullName "shared"),
        (Join-Path $version.FullName "um"),
        (Join-Path $version.FullName "winrt"),
        (Join-Path $version.FullName "cppwinrt")
    ) | Where-Object { Test-Path $_ -PathType Container }
    $env:INCLUDE = (@($env:INCLUDE) + $include | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ";"

    $libRoot = Join-Path (Join-Path $sdk.InstallationFolder "Lib") $version.Name
    $lib = @(
        (Join-Path $libRoot "ucrt\x64"),
        (Join-Path $libRoot "um\x64")
    ) | Where-Object { Test-Path $_ -PathType Container }
    $env:LIB = (@($env:LIB) + $lib | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ";"

    $sdkBin = Join-Path (Join-Path (Join-Path $sdk.InstallationFolder "bin") $version.Name) "x64"
    if (Test-Path $sdkBin -PathType Container) {
        $env:Path = "$sdkBin;$env:Path"
    }
}

function Assert-MsvcEnvironment {
    if (-not (Initialize-MsvcEnvironment)) {
        throw "MSVC Build Tools are not ready. Run 'just bootstrap-windows install', then retry from PowerShell."
    }
    if ([string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
        throw "MSVC linker link.exe is not on PATH after loading the Visual Studio environment. Re-run 'just bootstrap-windows install' and ensure the Visual C++ tools workload completed."
    }
}

function Get-LibClangPath {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:LIBCLANG_PATH)) {
        $candidates += $env:LIBCLANG_PATH
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "LLVM\bin")
    }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) {
        $candidates += (Join-Path $programFilesX86 "LLVM\bin")
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path $candidate -PathType Container)) {
            continue
        }
        if ((Test-Path (Join-Path $candidate "libclang.dll") -PathType Leaf) -or (Test-Path (Join-Path $candidate "clang.dll") -PathType Leaf)) {
            return $candidate
        }
    }
    return $null
}

function Initialize-LibClangEnvironment {
    $path = Get-LibClangPath
    if ([string]::IsNullOrWhiteSpace($path)) {
        return $false
    }
    $env:LIBCLANG_PATH = $path
    if (($env:Path -split ";") -notcontains $path) {
        $env:Path = "$path;$env:Path"
    }
    return $true
}

function Assert-LibClangEnvironment {
    if (-not (Initialize-LibClangEnvironment)) {
        throw "libclang was not found. Run 'just bootstrap-windows install' to install LLVM, then retry."
    }
}

function Invoke-MsvcWorkloadInstall {
    $installPath = Get-MsvcInstallPath
    if ([string]::IsNullOrWhiteSpace($installPath)) {
        $installPath = Get-VisualStudioBuildToolsInstallPath
    }
    $installer = Get-VsInstallerPath
    if ([string]::IsNullOrWhiteSpace($installPath) -or [string]::IsNullOrWhiteSpace($installer)) {
        return $false
    }

    Write-WindowsDevInfo "Repairing Visual Studio Build Tools VC workload at $installPath."
    $arguments = @(
        "modify",
        "--installPath",
        $installPath,
        "--add",
        "Microsoft.VisualStudio.Workload.VCTools",
        "--includeRecommended",
        "--passive",
        "--norestart"
    )

    if (-not (Test-IsElevated)) {
        Write-WindowsDevInfo "Requesting administrator approval for Visual Studio Build Tools repair."
        try {
            $process = Start-Process -FilePath $installer -ArgumentList (Join-WindowsProcessArguments -Arguments $arguments) -Verb RunAs -Wait -PassThru
            Update-SessionPathFromRegistry
            if ($process.ExitCode -eq 0 -and (Initialize-MsvcEnvironment) -and -not [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
                return $true
            }
            Write-WindowsDevInfo "Elevated Visual Studio repair exited with code $($process.ExitCode)."
            Write-WindowsDevInfo "Visual Studio repair did not make link.exe available."
            return $false
        } catch {
            Write-WindowsDevInfo "Could not start elevated Visual Studio repair: $($_.Exception.Message)"
            return $false
        }
    }

    $result = Invoke-CaptureCommand -FilePath $installer -ArgumentList $arguments
    Update-SessionPathFromRegistry
    if ($result.ExitCode -eq 0 -and (Initialize-MsvcEnvironment) -and -not [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
        return $true
    }
    if (-not [string]::IsNullOrWhiteSpace($result.Output)) {
        Write-WindowsDevInfo $result.Output
    }
    Write-WindowsDevInfo "Visual Studio repair did not make link.exe available."
    return $false
}

function Invoke-CorepackPreparePnpm {
    $corepack = Get-CorepackCommand
    if ([string]::IsNullOrWhiteSpace($corepack)) {
        return $false
    }
    $oldPrompt = $env:COREPACK_ENABLE_DOWNLOAD_PROMPT
    try {
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
        Invoke-CheckedCommand -FilePath $corepack -ArgumentList @("prepare", "pnpm@$(Get-RequiredPnpmVersion)", "--activate") -Label "corepack prepare pnpm@$(Get-RequiredPnpmVersion)"
        return $true
    } catch {
        Write-WindowsDevInfo "Corepack could not activate pnpm: $($_.Exception.Message)"
        return $false
    } finally {
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = $oldPrompt
    }
}

function Invoke-NpmInstallPnpm {
    $npm = Get-NpmCommand
    if ([string]::IsNullOrWhiteSpace($npm)) {
        return $false
    }
    try {
        Invoke-CheckedCommand -FilePath $npm -ArgumentList @("install", "-g", "pnpm@$(Get-RequiredPnpmVersion)") -Label "npm install -g pnpm@$(Get-RequiredPnpmVersion)"
        return $true
    } catch {
        Write-WindowsDevInfo "npm could not install pnpm: $($_.Exception.Message)"
        return $false
    }
}

function Assert-PnpmReady {
    $pnpm = Get-PnpmCommand
    if ([string]::IsNullOrWhiteSpace($pnpm) -or (Test-CodexRuntimePath $pnpm)) {
        throw "pnpm is not available in the user environment."
    }

    $version = Invoke-CaptureCommand -FilePath $pnpm -ArgumentList @("--version")
    if ($version.ExitCode -eq 0 -and $version.Output.Trim() -eq (Get-RequiredPnpmVersion)) {
        return
    }

    throw "pnpm did not report $(Get-RequiredPnpmVersion). Configure Block npm access as documented, then rerun 'just bootstrap-windows install'."
}

function Test-BlockNpmRegistryReachability {
    Import-BlockNpmUserEnvironment
    if ([string]::IsNullOrWhiteSpace((Get-CommandSource "node"))) {
        return [pscustomobject]@{
            Ready = $false
            Message = "node is unavailable, so Block npm HTTPS reachability could not be checked"
        }
    }

    $script = @'
const https = require("node:https");
const url = process.argv[2];
const req = https.request(url, { method: "HEAD", timeout: 15000 }, (res) => {
  console.log(`HTTP ${res.statusCode}`);
  res.resume();
  // 401/403 mean TLS worked but access is denied (missing/expired
  // Artifactory token); 5xx means the registry is broken. Either way the
  // lane is not ready, so only 2xx/3xx count as reachable.
  process.exitCode = res.statusCode >= 400 ? 1 : 0;
});
req.on("timeout", () => req.destroy(new Error("timed out after 15s")));
req.on("error", (error) => {
  console.error(`${error.code || "ERROR"}: ${error.message}`);
  process.exit(1);
});
req.end();
'@

    $scriptFile = New-TemporaryFile
    try {
        Set-Content -Path $scriptFile -Value $script -Encoding UTF8
        $result = Invoke-CaptureCommand -FilePath "node" -ArgumentList @($scriptFile.FullName, $script:BlockNpmRegistry)
    } finally {
        Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{
        Ready = ($result.ExitCode -eq 0)
        Message = $result.Output
    }
}

function Test-WebView2Runtime {
    $keys = @()
    foreach ($clientId in $script:WebView2ClientIds) {
        $keys += @(
            "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
            "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
            "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId"
        )
    }
    foreach ($key in $keys) {
        if (Test-Path $key) {
            $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
            $version = Get-ObjectValue $props "pv"
            # Microsoft's documented detection: pv must exist and not be
            # 0.0.0.0 (a broken/partial uninstall leaves pv = 0.0.0.0).
            if (-not [string]::IsNullOrWhiteSpace($version) -and $version -ne "0.0.0.0") {
                return [pscustomobject]@{ Found = $true; Version = $version; Path = $key }
            }
        }
    }
    return [pscustomobject]@{ Found = $false; Version = $null; Path = $null }
}

function Initialize-FnmEnvironment {
    $fnm = Get-CommandSource "fnm.exe"
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        $fnm = Get-CommandSource "fnm"
    }
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        return $false
    }

    $stdout = New-TemporaryFile
    $stderr = New-TemporaryFile
    try {
        $process = Start-Process $fnm -ArgumentList "env --shell powershell" -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout.FullName -RedirectStandardError $stderr.FullName
        if ($process.ExitCode -ne 0) {
            return $false
        }
        $envScript = Get-Content $stdout.FullName -Raw -ErrorAction Stop
    } finally {
        Remove-Item -LiteralPath $stdout.FullName, $stderr.FullName -Force -ErrorAction SilentlyContinue
    }
    if ([string]::IsNullOrWhiteSpace($envScript)) {
        return $false
    }
    $envScript | Invoke-Expression
    return $true
}

function Ensure-FnmNode {
    $fnm = Get-CommandSource "fnm"
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        throw "fnm is not installed. Run 'just bootstrap-windows install'."
    }
    Initialize-FnmEnvironment | Out-Null
    Invoke-CheckedCommand -FilePath $fnm -ArgumentList @("install", (Get-RequiredNodeVersion)) -Label "fnm install Node $(Get-RequiredNodeVersion)"
    Invoke-CheckedCommand -FilePath $fnm -ArgumentList @("use", (Get-RequiredNodeVersion)) -Label "fnm use Node $(Get-RequiredNodeVersion)"
    Initialize-FnmEnvironment | Out-Null
}

function Import-BlockNpmUserEnvironment {
    foreach ($target in Get-BlockNpmEnvironmentTargets) {
        $value = [System.Environment]::GetEnvironmentVariable($target.Name, "User")
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            [System.Environment]::SetEnvironmentVariable($target.Name, $value, "Process")
        }
    }
}
