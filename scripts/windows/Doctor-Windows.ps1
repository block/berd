$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-BerdRepoRoot)
Update-SessionPathFromRegistry

$script:Failures = 0
$script:Warnings = 0

function Pass {
    param([string]$Name, [string]$Message)
    Write-Host "PASS $Name - $Message" -ForegroundColor Green
}

function Fail {
    param([string]$Name, [string]$Message)
    $script:Failures += 1
    Write-Host "FAIL $Name - $Message" -ForegroundColor Red
}

function Warn {
    param([string]$Name, [string]$Message)
    $script:Warnings += 1
    Write-Host "WARN $Name - $Message" -ForegroundColor Yellow
}

function Check-Command {
    param([string]$Name, [string]$Remediation, [AllowNull()]$Check = $null, [string]$DisplayName = $Name)
    if ($null -eq $Check) {
        $Check = Test-WindowsCommandAvailability $Name
    }
    $source = $Check.Source
    if ([string]::IsNullOrWhiteSpace($source)) {
        Fail $DisplayName "missing from PATH. $Remediation"
        return $null
    }
    if ($Check.UsesCodexRuntime) {
        Fail $DisplayName "PATH resolves to Codex runtime ($source). Install it for the user environment, then open a new shell."
        return $null
    }
    Pass $DisplayName $source
    return $source
}

function Check-Python {
    param([AllowNull()]$Python = $null)
    $python = $Python
    if ($null -eq $python) {
        $python = Find-RunnablePython
    }
    if ($null -eq $python) {
        Fail "python" "no runnable Python 3 interpreter found. Run: winget install --id Python.Python.3.12 -e, or disable the Microsoft Store app execution alias."
        return
    }
    Pass "python" "$($python.Path) ($($python.Version))"
}

Write-WindowsDevSection "Berd Windows doctor"

$prereqs = Get-WindowsPrerequisiteSnapshot

Check-Command "just" "Install once with: winget install --id Casey.Just -e" $prereqs.Just | Out-Null
Check-Command "git" "Run: just bootstrap-windows install" $prereqs.Git | Out-Null

$gitBash = $prereqs.GitBash.Path
if (-not $prereqs.GitBash.Found) {
    Fail "Git Bash" "bash.exe not found. Install Git for Windows with: winget install --id Git.Git -e"
} else {
    Pass "Git Bash" $gitBash
}

$msvcPath = $prereqs.Msvc.InstallPath
if ([string]::IsNullOrWhiteSpace($msvcPath)) {
    $buildToolsPath = $prereqs.Msvc.BuildToolsPath
    if ([string]::IsNullOrWhiteSpace($buildToolsPath)) {
        Fail "MSVC Build Tools" "Visual Studio Build Tools with VC tools not found. Run: just bootstrap-windows install"
    } else {
        Fail "MSVC Build Tools" "found at $buildToolsPath, but the Visual C++ tools workload is missing. Run: just bootstrap-windows install"
    }
} else {
    if ($prereqs.Msvc.Ready) {
        Pass "MSVC Build Tools" "$msvcPath (link.exe available)"
    } else {
        Fail "MSVC Build Tools" "found at $msvcPath, but VsDevCmd.bat did not expose link.exe. Re-run: just bootstrap-windows install"
    }
}

$webview2 = $prereqs.WebView2
if ($webview2.Found) {
    Pass "WebView2 Runtime" "$($webview2.Version) at $($webview2.Path)"
} else {
    Fail "WebView2 Runtime" "missing. Run: winget install --id Microsoft.EdgeWebView2Runtime -e"
}

Check-Command "rustup" "Run: just bootstrap-windows install" $prereqs.Rustup | Out-Null
$rustc = Check-Command "rustc" "Run: rustup toolchain install $(Get-RequiredRustVersion)" $prereqs.Rustc
Check-Command "cargo" "Run: rustup toolchain install $(Get-RequiredRustVersion)" $prereqs.Cargo | Out-Null
if ($null -ne $rustc) {
    $version = Invoke-CaptureCommand -FilePath "rustc" -ArgumentList @("--version")
    if ($version.ExitCode -eq 0 -and $version.Output -match [regex]::Escape((Get-RequiredRustVersion))) {
        Pass "Rust version" $version.Output
    } else {
        Fail "Rust version" "expected $(Get-RequiredRustVersion), got '$($version.Output)'. Run: rustup toolchain install $(Get-RequiredRustVersion)"
    }
    $hostTriple = Get-RustHostTriple
    if ($hostTriple -match "windows-msvc$") {
        Pass "Rust host target" $hostTriple
    } else {
        Fail "Rust host target" "expected x86_64-pc-windows-msvc or aarch64-pc-windows-msvc, got '$hostTriple'"
    }
}

Check-Command "fnm" "Run: just bootstrap-windows install" $prereqs.Fnm | Out-Null
Import-BlockNpmUserEnvironment
$node = Check-Command "node" "Run: fnm install $(Get-RequiredNodeVersion); fnm use $(Get-RequiredNodeVersion)" $prereqs.Node
if ($null -ne $node) {
    $nodeVersion = Invoke-CaptureCommand -FilePath "node" -ArgumentList @("--version")
    if ($nodeVersion.ExitCode -eq 0 -and $nodeVersion.Output.TrimStart("v") -eq (Get-RequiredNodeVersion)) {
        Pass "Node version" $nodeVersion.Output
    } else {
        Fail "Node version" "expected $(Get-RequiredNodeVersion), got '$($nodeVersion.Output)'. A stray system Node may be shadowing fnm. Run: fnm install $(Get-RequiredNodeVersion); fnm use $(Get-RequiredNodeVersion)"
    }
}

Check-Command "corepack" "Run: corepack enable" $prereqs.Corepack | Out-Null
$certPath = Get-BlockRootCertPath
if (Test-Path $certPath -PathType Leaf) {
    Pass "Block npm cert" $certPath
} else {
    Fail "Block npm cert" "missing. Configure Block npm access from docs/windows-onboarding.md"
}
$npm = Get-NpmCommand
if ([string]::IsNullOrWhiteSpace($npm)) {
    Fail "npm registry" "npm is unavailable. Run: just bootstrap-windows install"
} else {
    $configuredRegistry = Invoke-CaptureCommand -FilePath $npm -ArgumentList @("config", "get", "registry")
    if ($configuredRegistry.ExitCode -eq 0 -and $configuredRegistry.Output.Trim() -eq (Get-BlockNpmRegistry)) {
        Pass "npm registry" $configuredRegistry.Output.Trim()
    } else {
        Fail "npm registry" "expected $(Get-BlockNpmRegistry), got '$($configuredRegistry.Output.Trim())'. Configure Block npm access from docs/windows-onboarding.md"
    }
    # Functional probe through npm's own TLS/cafile/auth config: catches
    # expired or missing Artifactory tokens that a raw HTTPS check misses.
    $npmPing = Invoke-CaptureCommand -FilePath $npm -ArgumentList @("ping", "--registry", (Get-BlockNpmRegistry))
    if ($npmPing.ExitCode -eq 0) {
        Pass "npm ping" (Get-BlockNpmRegistry)
    } else {
        Fail "npm ping" "npm cannot authenticate to $(Get-BlockNpmRegistry). Refresh Block npm credentials from docs/windows-onboarding.md. Details: $($npmPing.Output)"
    }
}
$pnpm = Check-Command "pnpm" "Run: corepack prepare pnpm@$(Get-RequiredPnpmVersion) --activate" $prereqs.Pnpm
if ($null -ne $pnpm) {
    if ($prereqs.Pnpm.Ready) {
        Pass "pnpm version" $prereqs.Pnpm.Version
    } else {
        $actualVersion = if ([string]::IsNullOrWhiteSpace($prereqs.Pnpm.Version)) { "unreadable" } else { $prereqs.Pnpm.Version }
        Fail "pnpm version" "expected $(Get-RequiredPnpmVersion), got '$actualVersion'. Run: corepack prepare pnpm@$(Get-RequiredPnpmVersion) --activate"
    }
}

$blockNpmReachability = $prereqs.BlockNpmReachability
if ($null -eq $blockNpmReachability) {
    $blockNpmReachability = Test-BlockNpmRegistryReachability
}
if ($blockNpmReachability.Ready) {
    Pass "Block npm HTTPS" $blockNpmReachability.Message
} else {
    Fail "Block npm HTTPS" "could not reach $(Get-BlockNpmRegistry) with Node/npm TLS settings. Configure Block npm access from docs/windows-onboarding.md, connect to the Block VPN/proxy, or fix local trust, then rerun. Details: $($blockNpmReachability.Message)"
}

Check-Command "cmake" "Run: winget install --id Kitware.CMake -e" $prereqs.Cmake | Out-Null
$libClangPath = $prereqs.LibClangPath
if ([string]::IsNullOrWhiteSpace($libClangPath)) {
    Fail "libclang" "libclang.dll not found. Run: winget install --id LLVM.LLVM -e"
} else {
    Initialize-LibClangEnvironment | Out-Null
    Pass "libclang" $libClangPath
}
Check-Command "jq" "Run: winget install --id jqlang.jq -e" $prereqs.Jq | Out-Null
Check-Python -Python $prereqs.Python
Check-Command "lefthook" "Install Lefthook, then rerun 'just setup-windows' to install hooks." $prereqs.Lefthook | Out-Null

$paths = Resolve-GooseDevPaths
Write-WindowsDevInfo "Managed Goose repo: $($paths.Repo)"
Write-WindowsDevInfo "Managed Goose cargo target: $($paths.CargoTargetDir)"
try {
    $result = Invoke-EnsureLocalGoose -Action Check
    if ($result.Ready) {
        Pass "Managed Goose" $result.BinPath
    } else {
        Fail "Managed Goose" "$($result.Message)"
    }
} catch {
    Fail "Managed Goose" "$($_.Exception.Message). Run: just setup-windows"
}

Warn "Native sign-in" "Berd native provider sign-in is not supported on Windows yet. Sign in on macOS or use explicit local credential/file storage for Windows verification."

Write-Host ""
if ($script:Failures -gt 0) {
    Write-Host "Doctor found $script:Failures failure(s) and $script:Warnings warning(s)." -ForegroundColor Red
    exit 1
}

Write-Host "Doctor passed with $script:Warnings warning(s)." -ForegroundColor Green
