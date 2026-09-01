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

function New-BerdTemporaryFile {
    # Avoid PowerShell module autoloading here. GitHub-hosted Windows runners can
    # launch nested Windows PowerShell with Microsoft.PowerShell.Utility absent
    # from PSModulePath, which makes the New-TemporaryFile cmdlet unavailable.
    return Get-Item -LiteralPath ([System.IO.Path]::GetTempFileName())
}

function Invoke-CaptureCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory = (Get-Location).Path
    )

    $stdout = New-BerdTemporaryFile
    $stderr = New-BerdTemporaryFile
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

# Invoke a sibling PowerShell script as a native child process and fail on a
# nonzero exit code. Dot-sourcing or `& script.ps1` runs the child in-process,
# where a SUCCESSFUL script leaves $LASTEXITCODE untouched (commonly $null),
# so a following `if ($LASTEXITCODE -ne 0)` guard reads a stale/`$null` value
# and false-fails ($null -ne 0 is $true). Running the script through the same
# host executable that is running this process gives it a real, deliberately
# captured native exit code, so success (0) and failure (nonzero) are both
# detected correctly and control only proceeds past a genuinely successful step.
function Invoke-WindowsChildScript {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [string[]]$ArgumentList = @(),
        [string]$Label = $ScriptPath
    )

    if (-not (Test-Path $ScriptPath -PathType Leaf)) {
        throw "Child script not found: $ScriptPath"
    }

    $shell = (Get-Process -Id $PID).Path
    if ([string]::IsNullOrWhiteSpace($shell)) {
        throw "Could not resolve the current PowerShell host executable to run $ScriptPath."
    }

    # Windows PowerShell (powershell.exe) honours machine execution policy; if it
    # is Restricted/AllSigned the child would refuse to run even though the
    # parent lane started under -ExecutionPolicy Bypass. Pass Bypass to the child
    # too when the host is powershell.exe (pwsh ignores per-invocation policy).
    $shellArgs = @("-NoProfile")
    if ([System.IO.Path]::GetFileNameWithoutExtension($shell) -ieq "powershell") {
        $shellArgs += @("-ExecutionPolicy", "Bypass")
    }
    $shellArgs += @("-File", $ScriptPath)
    $shellArgs += $ArgumentList

    Write-WindowsDevInfo $Label
    $process = Start-Process -FilePath $shell -ArgumentList (Join-WindowsProcessArguments $shellArgs) -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "$Label failed with exit code $($process.ExitCode)."
    }
}

# Build the taskkill argument vector that terminates a process AND its whole
# child tree by PID. Factored out so the tree-kill command shape is a pure,
# deterministically testable value: Windows PowerShell 5.1 has no kill-tree
# process overload, so a timed-out probe must terminate the tree with
# `taskkill /PID <id> /T /F` or a wedged child's grandchildren leak.
function Get-TaskkillTreeArguments {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    return @("/PID", "$ProcessId", "/T", "/F")
}

# Terminate a process and its children in a way that works on both Windows
# PowerShell 5.1 (.NET Framework, which lacks the kill-tree overload) and pwsh 7
# (.NET Core). On Windows prefer taskkill's tree kill; on any host, and if
# taskkill is missing or fails, fall back to the single-process Kill() that
# exists everywhere.
function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)]$Process)

    $processId = $Process.Id
    if (Test-IsWindowsHost) {
        try {
            $arguments = Get-TaskkillTreeArguments -ProcessId $processId
            & taskkill.exe @arguments 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                return
            }
        } catch {
            # Fall through to the portable single-process kill below.
        }
    }
    try { $Process.Kill() } catch { }
}

# Run an external command with a hard wall-clock timeout and capture its exit
# code and combined output. Unlike Invoke-CaptureCommand this bounds a hung or
# non-responsive binary: if it does not exit within TimeoutSeconds it is killed
# and TimedOut is reported so callers never block a build on a wedged probe.
# Kept Windows PowerShell 5.1-safe: arguments are passed via the string
# `Arguments` property (5.1 lacks ProcessStartInfo.ArgumentList) built with the
# existing MSVCRT quoting helper, and the timeout path uses Stop-ProcessTree
# instead of the .NET Core-only kill-tree process overload.
function Invoke-BoundedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSeconds = 15
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (Join-WindowsProcessArguments -Arguments $ArgumentList)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    try {
        [void]$process.Start()
        # Read both streams asynchronously so a full stderr pipe cannot deadlock
        # a process still writing stdout (and vice versa). --version output is
        # tiny, but the async tasks keep this correct regardless of volume.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()

        $exited = $process.WaitForExit($TimeoutSeconds * 1000)
        if (-not $exited) {
            Stop-ProcessTree -Process $process
            [void]$process.WaitForExit(2000)
            return [pscustomobject]@{ ExitCode = $null; Output = ""; TimedOut = $true }
        }
        $combined = (($stdoutTask.GetAwaiter().GetResult()) + ($stderrTask.GetAwaiter().GetResult())).Trim()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $combined; TimedOut = $false }
    } finally {
        $process.Dispose()
    }
}

# Classify bounded Goose identity probes. Current Goose prints bare semver for
# `--version`, so identity cannot be inferred from that output alone. Require a
# successful help banner with Goose-specific commands when accepting bare semver;
# still accept older clap banners that explicitly name the expected binary.
function Test-GooseVersionOutput {
    param(
        [AllowNull()]$ExitCode,
        [AllowNull()][string]$Output,
        [bool]$TimedOut,
        [Parameter(Mandatory = $true)][string]$BinName,
        [AllowNull()]$HelpExitCode,
        [AllowNull()][string]$HelpOutput,
        [bool]$HelpTimedOut
    )

    if ($TimedOut) {
        return [pscustomobject]@{ Ok = $false; Message = "Goose --version probe timed out." }
    }
    if ($ExitCode -ne 0) {
        return [pscustomobject]@{ Ok = $false; Message = "Goose --version exited with code $ExitCode." }
    }
    if ([string]::IsNullOrWhiteSpace($Output)) {
        return [pscustomobject]@{ Ok = $false; Message = "Goose --version produced no output." }
    }

    $escaped = [regex]::Escape($BinName)
    if ($Output -match "(?im)^\s*$escaped\s+v?\d+\.\d+") {
        return [pscustomobject]@{ Ok = $true; Message = $Output.Trim() }
    }
    if ($Output -match '^\s*v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*$') {
        if ($HelpTimedOut -or $HelpExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($HelpOutput)) {
            return [pscustomobject]@{ Ok = $false; Message = "Goose --help identity probe failed." }
        }
        $hasUsage = $HelpOutput -match '(?im)^Usage:\s+goose(?:\.exe)?\s+'
        $hasCommands = $HelpOutput -match '(?im)^\s+configure\s+' -and $HelpOutput -match '(?im)^\s+session\s+' -and $HelpOutput -match '(?im)^\s+serve\s+'
        if ($hasUsage -and $hasCommands) {
            return [pscustomobject]@{ Ok = $true; Message = $Output.Trim() }
        }
    }
    return [pscustomobject]@{ Ok = $false; Message = "Goose identity probes did not identify '$BinName': $Output" }
}

function Assert-GooseBinaryIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BinName,
        [int]$TimeoutSeconds = 15
    )

    if (-not (Test-Path $Path -PathType Leaf)) {
        throw "Goose binary not found for identity probe: $Path"
    }

    $versionProbe = Invoke-BoundedCommand -FilePath $Path -ArgumentList @("--version") -TimeoutSeconds $TimeoutSeconds
    $helpProbe = Invoke-BoundedCommand -FilePath $Path -ArgumentList @("--help") -TimeoutSeconds $TimeoutSeconds
    $verdict = Test-GooseVersionOutput -ExitCode $versionProbe.ExitCode -Output $versionProbe.Output -TimedOut $versionProbe.TimedOut -BinName $BinName -HelpExitCode $helpProbe.ExitCode -HelpOutput $helpProbe.Output -HelpTimedOut $helpProbe.TimedOut
    if (-not $verdict.Ok) {
        throw "Goose identity probe failed for $Path. $($verdict.Message)"
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

# Single source of truth for mapping the renderer build gates onto the
# matching Tauri Cargo feature set. Callers may add posture features (for
# example berdctl/app-test-driver/devtools) without duplicating gate policy.
# Windows cannot call scripts/block-feature-gates.sh (no guaranteed bash in the
# release image), so this table is pinned equal to that mapper by
# scripts/release/tests/release-scripts.test.mjs.
function Get-BerdAppFeatures {
    param([string[]]$BaseFeatures = @("berdctl", "app-test-driver"))

    $features = New-Object System.Collections.Generic.List[string]
    foreach ($feature in $BaseFeatures) {
        if (-not [string]::IsNullOrWhiteSpace($feature)) {
            $features.Add($feature)
        }
    }
    $gates = @(
        @{ Env = "VITE_AGENT_TOOLS"; Feature = "block-agent-tools" },
        @{ Env = "VITE_AUTOMATIONS"; Feature = "block-automations" },
        @{ Env = "VITE_BUILDERBOT"; Feature = "block-builderbot" },
        @{ Env = "VITE_FEEDBACK"; Feature = "block-feedback" },
        @{ Env = "VITE_MANAGED_CONNECTIONS"; Feature = "block-managed-connections" },
        @{ Env = "VITE_SKILL_DISCOVERY"; Feature = "block-skill-discovery" },
        @{ Env = "VITE_TELEMETRY_ENFORCED"; Feature = "block-telemetry-enforced" },
        @{ Env = "VITE_VOICE_DICTATION"; Feature = "block-voice-dictation" }
    )
    foreach ($gate in $gates) {
        $value = [Environment]::GetEnvironmentVariable($gate.Env, "Process")
        if ([string]::IsNullOrWhiteSpace($value)) { $value = "0" }
        if ($value -ne "0" -and $value -ne "1") {
            throw "$($gate.Env) must be 0 or 1 (got: $value)"
        }
        if ($value -eq "1") { $features.Add($gate.Feature) }
    }
    if ([Environment]::GetEnvironmentVariable("VITE_VOICE_DICTATION", "Process") -ne "1") {
        $features.Add("no-voice-dictation")
    }
    return ($features -join ",")
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

    $buildProfile = $env:GOOSE_BUILD_PROFILE
    if ([string]::IsNullOrWhiteSpace($buildProfile)) {
        $buildProfile = "debug"
    }
    if ($buildProfile -notin @("debug", "release")) {
        throw "GOOSE_BUILD_PROFILE must be debug or release, got: $buildProfile"
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
        BuildProfile = $buildProfile
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

# ── Windows sidecar staging ──────────────────────────────────
# Tauri resolves externalBin entries on Windows as `<stem>-<triple>.exe`.
# Unlike the Unix scripts, Windows has no execute bit: "executability" is
# expressed as a valid PE image of the target architecture. These helpers
# parse the PE headers directly so staging can reject non-PE inputs, wrong
# architectures, and truncated files instead of trusting a chmod that does
# nothing on Windows.

# COFF machine identifiers from winnt.h (IMAGE_FILE_MACHINE_*).
$script:PeMachineAmd64 = 0x8664
$script:PeMachineArm64 = 0xAA64
$script:PeMachineI386 = 0x014C
# IMAGE_FILE_EXECUTABLE_IMAGE from the COFF Characteristics field.
$script:PeCharacteristicsExecutableImage = 0x0002

# Return the exact Tauri-resolved sidecar file name for a stem/triple, e.g.
# Get-WindowsSidecarName "goosed" "x86_64-pc-windows-msvc"
#   -> goosed-x86_64-pc-windows-msvc.exe
function Get-WindowsSidecarName {
    param(
        [Parameter(Mandatory = $true)][string]$Stem,
        [Parameter(Mandatory = $true)][string]$Triple
    )
    return (Get-WindowsExeName "$Stem-$Triple")
}

# Map a Windows target triple to the COFF machine value its binaries must
# carry. Returns $null for triples this staging path does not support.
function Get-WindowsTripleMachine {
    param([Parameter(Mandatory = $true)][string]$Triple)
    switch -Regex ($Triple) {
        '^(x86_64|x86_64h)-.*-windows-' { return $script:PeMachineAmd64 }
        '^aarch64-.*-windows-' { return $script:PeMachineArm64 }
        '^(i586|i686)-.*-windows-' { return $script:PeMachineI386 }
        default { return $null }
    }
}

# Parse the PE headers of a file without executing it. Returns an object
# describing whether the file is a PE image, its COFF machine value, and
# whether the executable-image characteristic is set. `IsPe` is $false for
# anything that is not a well-formed PE (missing MZ/PE signatures, truncated
# headers, or a shell script masquerading as a binary).
function Get-PeFileInfo {
    param([Parameter(Mandatory = $true)][string]$Path)

    $result = [pscustomobject]@{
        IsPe = $false
        Machine = $null
        IsExecutableImage = $false
    }

    if (-not (Test-Path $Path -PathType Leaf)) {
        return $result
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    # Need at least the DOS header up to the e_lfanew pointer at 0x3C.
    if ($bytes.Length -lt 64) {
        return $result
    }
    # DOS magic "MZ".
    if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        return $result
    }

    $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
    # PE signature (4) + COFF header (20) must fit within the file.
    if ($peOffset -lt 0 -or ($peOffset + 24) -gt $bytes.Length) {
        return $result
    }
    # PE signature "PE\0\0".
    if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
        $bytes[$peOffset + 2] -ne 0x00 -or $bytes[$peOffset + 3] -ne 0x00) {
        return $result
    }

    # COFF header layout (20 bytes, starting after the 4-byte PE signature):
    #   +0  Machine (u16)          +16 SizeOfOptionalHeader (u16)
    #   +2  NumberOfSections (u16) +18 Characteristics (u16)
    $coffOffset = $peOffset + 4
    $machine = [System.BitConverter]::ToUInt16($bytes, $coffOffset)
    $numberOfSections = [System.BitConverter]::ToUInt16($bytes, $coffOffset + 2)
    $sizeOfOptionalHeader = [System.BitConverter]::ToUInt16($bytes, $coffOffset + 16)
    $characteristics = [System.BitConverter]::ToUInt16($bytes, $coffOffset + 18)

    # A real image must carry an optional header; the section table follows it.
    # Verify both regions fit in the file so a file truncated after the COFF
    # header (or with a bogus header size) is rejected rather than blessed.
    $optionalHeaderOffset = $coffOffset + 20
    # The optional-header magic (first 2 bytes) is needed to know the required
    # minimum size, so the header must at least reach it and fit in the file.
    if ($sizeOfOptionalHeader -lt 2) {
        return $result
    }
    if (($optionalHeaderOffset + [int]$sizeOfOptionalHeader) -gt $bytes.Length) {
        return $result
    }

    # Optional-header magic distinguishes PE32 (0x10B) from PE32+ (0x20B).
    # Anything else is not a loadable image.
    $optionalMagic = [System.BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
    if ($optionalMagic -ne 0x10B -and $optionalMagic -ne 0x20B) {
        return $result
    }

    # Enforce the architecture-appropriate minimum optional-header size. The
    # PE/COFF spec fixes the standard + Windows-specific fields at 96 bytes for
    # PE32 and 112 bytes for PE32+ (before the optional data directories). A
    # SizeOfOptionalHeader smaller than this cannot describe a loadable image,
    # so a file that stops just past the magic (the reachable minimal-file
    # defect) is rejected here rather than blessed.
    $minOptionalHeaderSize = if ($optionalMagic -eq 0x20B) { 112 } else { 96 }
    if ([int]$sizeOfOptionalHeader -lt $minOptionalHeaderSize) {
        return $result
    }

    # A loadable image has at least one section. Reject NumberOfSections = 0 so
    # a header-only file with no section table cannot pass.
    if ($numberOfSections -lt 1) {
        return $result
    }

    # The section table is NumberOfSections * 40 bytes immediately after the
    # optional header; require it to fit as well.
    $sectionTableOffset = $optionalHeaderOffset + [int]$sizeOfOptionalHeader
    $sectionTableBytes = [int]$numberOfSections * 40
    if (($sectionTableOffset + $sectionTableBytes) -gt $bytes.Length) {
        return $result
    }

    $result.IsPe = $true
    $result.Machine = [int]$machine
    $result.IsExecutableImage = (($characteristics -band $script:PeCharacteristicsExecutableImage) -ne 0)
    return $result
}

# Validate that a file is a PE executable image whose architecture matches the
# requested target triple. Throws with an actionable message otherwise. This
# replaces the Unix `chmod +x`/`[[ -x ]]` executability contract, which is a
# no-op on Windows.
function Assert-WindowsSidecarBinary {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Triple
    )

    $expectedMachine = Get-WindowsTripleMachine -Triple $Triple
    if ($null -eq $expectedMachine) {
        throw "Unsupported Windows sidecar target triple: $Triple"
    }

    $info = Get-PeFileInfo -Path $Path
    if (-not $info.IsPe) {
        throw "Sidecar is not a valid Windows PE executable: $Path"
    }
    if (-not $info.IsExecutableImage) {
        throw "Sidecar PE image is not marked executable: $Path"
    }
    if ($info.Machine -ne $expectedMachine) {
        throw ("Sidecar architecture 0x{0:X4} does not match {1} (expected 0x{2:X4}): {3}" -f `
            $info.Machine, $Triple, $expectedMachine, $Path)
    }
}

# Compute the SHA-256 of a file as a lowercase hex string without relying on
# Microsoft.PowerShell.Utility. GitHub-hosted runners can launch nested shells
# with that module absent from PSModulePath.
function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

# Remove stale staged sidecars for a stem before writing the current one so a
# renamed target triple, a leftover extensionless Unix-staged file, or an
# aborted prior run cannot linger in the bundle inputs. Only files matching
# the stem are touched.
function Remove-StaleWindowsSidecars {
    param(
        [Parameter(Mandatory = $true)][string]$BinDir,
        [Parameter(Mandatory = $true)][string]$Stem,
        [Parameter(Mandatory = $true)][string]$KeepName
    )

    if (-not (Test-Path $BinDir -PathType Container)) {
        return
    }

    # `<stem>-<triple>` with or without .exe, plus the bare `<stem>`/`<stem>.exe`
    # the Unix scripts would have produced under Git Bash.
    Get-ChildItem -Path $BinDir -File -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -like "$Stem-*") -or ($_.Name -eq $Stem) -or ($_.Name -eq (Get-WindowsExeName $Stem))
        } |
        Where-Object { $_.Name -ne $KeepName } |
        ForEach-Object { Remove-Item -Path $_.FullName -Force -ErrorAction Stop }
}

# Stage one sidecar for Tauri's Windows externalBin resolution. Validates the
# source PE/architecture, clears stale staged files, copies to the exact
# `<stem>-<triple>.exe` name, then re-validates the staged copy and confirms it
# is a byte-for-byte match of the source. Returns the staged path.
function Stage-WindowsSidecar {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$Triple,
        [Parameter(Mandatory = $true)][string]$Stem,
        [Parameter(Mandatory = $true)][string]$BinDir
    )

    if (-not (Test-Path $SourcePath -PathType Leaf)) {
        throw "Sidecar source binary not found: $SourcePath"
    }
    Assert-WindowsSidecarBinary -Path $SourcePath -Triple $Triple

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $stagedName = Get-WindowsSidecarName -Stem $Stem -Triple $Triple
    $stagedPath = Join-Path $BinDir $stagedName

    Remove-StaleWindowsSidecars -BinDir $BinDir -Stem $Stem -KeepName $stagedName

    $sourceSha = Get-FileSha256 -Path $SourcePath
    Copy-Item -Path $SourcePath -Destination $stagedPath -Force

    $stagedSha = Get-FileSha256 -Path $stagedPath
    if ($stagedSha -ne $sourceSha) {
        throw "Staged sidecar checksum mismatch for $stagedPath (expected $sourceSha, got $stagedSha)."
    }
    Assert-WindowsSidecarBinary -Path $stagedPath -Triple $Triple

    return $stagedPath
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

    return (Join-Path (Join-Path $targetDir $Settings.BuildProfile) (Get-WindowsExeName $Settings.Bin))
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
        buildProfile = $Settings.BuildProfile
        bin = $BinPath
        sha256 = (Get-FileSha256 -Path $BinPath)
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
    if ((Get-ObjectValue $Stamp "buildProfile") -ne $Settings.BuildProfile) {
        return $false
    }
    if ((Get-ObjectValue $Stamp "bin") -ne $BinPath) {
        return $false
    }
    if (-not (Test-Path $BinPath -PathType Leaf)) {
        return $false
    }
    # Bind the readiness record to the binary's content, not just its path. A
    # stamp without a recorded digest predates this gate and cannot be trusted
    # as ready; a recorded digest that no longer matches the on-disk bytes means
    # the binary was replaced or corrupted after it was stamped, so reuse must
    # rebuild rather than stage stale/unknown bytes.
    $recordedSha = Get-ObjectValue $Stamp "sha256"
    if ([string]::IsNullOrWhiteSpace($recordedSha)) {
        return $false
    }
    if ((Get-FileSha256 -Path $BinPath) -ne $recordedSha) {
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
    $cargoArguments = @("build", "--locked")
    if ($Settings.BuildProfile -eq "release") {
        $cargoArguments += "--release"
    }
    $cargoArguments += @("-p", $Settings.Package, "--bin", $Settings.Bin)
    Invoke-CheckedCommand -FilePath "cargo" -ArgumentList $cargoArguments -WorkingDirectory $Paths.Repo -Label "cargo build Goose ($($Settings.BuildProfile))"

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
    $environmentFile = New-BerdTemporaryFile
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

    $scriptFile = New-BerdTemporaryFile
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

    $stdout = New-BerdTemporaryFile
    $stderr = New-BerdTemporaryFile
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
