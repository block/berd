param(
    [ValidateSet("check", "install")]
    [string]$Mode = "check"
)

$ErrorActionPreference = "Stop"
$global:LASTEXITCODE = 0
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-BerdRepoRoot)
Update-SessionPathFromRegistry

$script:Failures = 0
$script:MissingInstallIds = New-Object System.Collections.ArrayList
$script:InstallFailures = New-Object System.Collections.ArrayList

function Add-InstallFailure {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Message
    )
    [void]$script:InstallFailures.Add([pscustomobject]@{ Name = $Name; Message = $Message })
    Write-Host "FAIL $Name - $Message" -ForegroundColor Red
}

function Add-Failure {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Message,
        [AllowNull()][AllowEmptyString()][string]$WingetId = $null
    )
    $script:Failures += 1
    Write-Host "FAIL $Name - $Message" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($WingetId)) {
        [void]$script:MissingInstallIds.Add([pscustomobject]@{ Name = $Name; Id = $WingetId })
    }
}

function Add-Pass {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Message
    )
    Write-Host "PASS $Name - $Message" -ForegroundColor Green
}

function Add-Warn {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Message
    )
    Write-Host "WARN $Name - $Message" -ForegroundColor Yellow
}

function Test-RequiredCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$WingetId,
        [string]$DisplayName = $Name,
        [AllowNull()]$Check = $null
    )
    if ($null -eq $Check) {
        $Check = Test-WindowsCommandAvailability $Name
    }
    $source = $Check.Source
    if ([string]::IsNullOrWhiteSpace($source)) {
        Add-Failure $DisplayName "missing from PATH" $WingetId
        return $false
    }
    if ($Check.UsesCodexRuntime) {
        Add-Failure $DisplayName "PATH resolves to Codex runtime ($source), not a user install" $WingetId
        return $false
    }
    Add-Pass $DisplayName $source
    return $true
}

function Test-PythonCommand {
    param([AllowNull()]$Python = $null)
    $python = $Python
    if ($null -eq $python) {
        $python = Find-RunnablePython
    }
    if ($null -eq $python) {
        Add-Failure "Python" "no runnable Python 3 interpreter found. Install Python with WinGet or disable the Microsoft Store app execution alias." "Python.Python.3.12"
        return
    }
    Add-Pass "Python" "$($python.Path) ($($python.Version))"
}

# WinGet return codes that mean "nothing to do" rather than "install failed".
# 0x8A15002B: no applicable update (package already installed at this version).
# 0x8A15010B: found an existing package already installed.
$script:BenignWingetExitCodes = @(0, -1978335189, -1978334965)

function Invoke-WingetInstall {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$ExtraArgs = @()
    )
    $winget = Get-CommandSource "winget"
    if ([string]::IsNullOrWhiteSpace($winget)) {
        throw "winget is not available. Install prerequisites manually, then rerun 'just bootstrap-windows'."
    }

    Write-WindowsDevInfo "Installing $Name with winget package $Id."
    $args = @("install", "--source", "winget", "--id", $Id, "-e", "--accept-package-agreements", "--accept-source-agreements")
    $args += $ExtraArgs
    & $winget @args
    $exitCode = $LASTEXITCODE
    if ($script:BenignWingetExitCodes -contains $exitCode) {
        return $true
    }
    $hex = "0x{0:X8}" -f $exitCode
    Add-InstallFailure $Name "winget install --id $Id failed with $exitCode ($hex). If this is a machine-scope package, retry from an elevated PowerShell."
    return $false
}

Write-WindowsDevSection "Windows bootstrap ($Mode)"

# Evaluates one prerequisite snapshot, resetting the failure tally so install
# mode can re-run it after installing and gate its exit code on the re-check.
function Invoke-PrerequisiteEvaluation {
    param([Parameter(Mandatory = $true)]$Prereqs)
    $script:Failures = 0
    $script:MissingInstallIds = New-Object System.Collections.ArrayList
    $prereqs = $Prereqs

    Test-RequiredCommand -Name "winget" -WingetId "" -DisplayName "WinGet" -Check $prereqs.WinGet | Out-Null
    Test-RequiredCommand -Name "git" -WingetId "Git.Git" -DisplayName "Git" -Check $prereqs.Git | Out-Null

    $gitBash = $prereqs.GitBash.Path
    if (-not $prereqs.GitBash.Found) {
        Add-Failure "Git Bash" "bash.exe was not found under Program Files\Git" "Git.Git"
    } else {
        Add-Pass "Git Bash" $gitBash
    }

    $msvcPath = $prereqs.Msvc.InstallPath
    if ([string]::IsNullOrWhiteSpace($msvcPath)) {
        $buildToolsPath = $prereqs.Msvc.BuildToolsPath
        if ([string]::IsNullOrWhiteSpace($buildToolsPath)) {
            Add-Failure "MSVC Build Tools" "Visual Studio Build Tools with VC tools were not found" "Microsoft.VisualStudio.2022.BuildTools"
        } else {
            Add-Failure "MSVC Build Tools" "found at $buildToolsPath, but the Visual C++ tools workload is missing" "Microsoft.VisualStudio.2022.BuildTools"
        }
    } else {
        if ($prereqs.Msvc.Ready) {
            Add-Pass "MSVC Build Tools" "$msvcPath (link.exe available)"
        } else {
            Add-Failure "MSVC Build Tools" "found at $msvcPath, but VsDevCmd.bat did not expose link.exe" "Microsoft.VisualStudio.2022.BuildTools"
        }
    }

    $webview2 = $prereqs.WebView2
    if ($webview2.Found) {
        Add-Pass "WebView2 Runtime" "$($webview2.Version) at $($webview2.Path)"
    } else {
        Add-Failure "WebView2 Runtime" "Microsoft Edge WebView2 Runtime was not found" "Microsoft.EdgeWebView2Runtime"
    }

    Test-RequiredCommand -Name "rustup" -WingetId "Rustlang.Rustup" -DisplayName "rustup" -Check $prereqs.Rustup | Out-Null
    Test-RequiredCommand -Name "rustc" -WingetId "Rustlang.Rustup" -DisplayName "rustc" -Check $prereqs.Rustc | Out-Null
    Test-RequiredCommand -Name "cargo" -WingetId "Rustlang.Rustup" -DisplayName "cargo" -Check $prereqs.Cargo | Out-Null
    Test-RequiredCommand -Name "fnm" -WingetId "Schniz.fnm" -DisplayName "fnm" -Check $prereqs.Fnm | Out-Null
    Test-RequiredCommand -Name "node" -WingetId "Schniz.fnm" -DisplayName "Node" -Check $prereqs.Node | Out-Null
    Test-RequiredCommand -Name "corepack" -WingetId "Schniz.fnm" -DisplayName "Corepack" -Check $prereqs.Corepack | Out-Null
    if (Test-RequiredCommand -Name "pnpm" -WingetId "Schniz.fnm" -DisplayName "pnpm" -Check $prereqs.Pnpm) {
        if ($prereqs.Pnpm.Ready) {
            Add-Pass "pnpm version" $prereqs.Pnpm.Version
        } else {
            $actualVersion = if ([string]::IsNullOrWhiteSpace($prereqs.Pnpm.Version)) { "unreadable" } else { $prereqs.Pnpm.Version }
            Add-Failure "pnpm version" "expected $(Get-RequiredPnpmVersion), got '$actualVersion'. Run: corepack prepare pnpm@$(Get-RequiredPnpmVersion) --activate" "Schniz.fnm"
        }
    }
    if ($null -ne $prereqs.BlockNpmReachability) {
        $blockNpmReachability = $prereqs.BlockNpmReachability
        if ($blockNpmReachability.Ready) {
            Add-Pass "Block npm HTTPS" $blockNpmReachability.Message
        } else {
            Add-Warn "Block npm HTTPS" "could not reach $(Get-BlockNpmRegistry) with Node/npm TLS settings. Configure Block npm access from docs/windows-onboarding.md, then rerun. Details: $($blockNpmReachability.Message)"
        }
    }
    Test-RequiredCommand -Name "cmake" -WingetId "Kitware.CMake" -DisplayName "CMake" -Check $prereqs.Cmake | Out-Null
    $libClangPath = $prereqs.LibClangPath
    if ([string]::IsNullOrWhiteSpace($libClangPath)) {
        Add-Failure "libclang" "libclang.dll was not found" "LLVM.LLVM"
    } else {
        Add-Pass "libclang" $libClangPath
    }
    Test-RequiredCommand -Name "jq" -WingetId "jqlang.jq" -DisplayName "jq" -Check $prereqs.Jq | Out-Null
    Test-PythonCommand -Python $prereqs.Python
    Test-RequiredCommand -Name "just" -WingetId "Casey.Just" -DisplayName "just" -Check $prereqs.Just | Out-Null
    Test-RequiredCommand -Name "lefthook" -WingetId "evilmartians.lefthook" -DisplayName "Lefthook" -Check $prereqs.Lefthook | Out-Null
}

$prereqs = Get-WindowsPrerequisiteSnapshot
Invoke-PrerequisiteEvaluation -Prereqs $prereqs

if ($Mode -eq "install") {
    Write-WindowsDevSection "Installing missing prerequisites"
    $ids = @{}
    foreach ($item in $script:MissingInstallIds) {
        if (-not [string]::IsNullOrWhiteSpace($item.Id)) {
            $ids[$item.Id] = $item.Name
        }
    }

    # Git, WebView2, and VS Build Tools default to machine-scope installs;
    # from a non-elevated shell winget either UAC-prompts or fails outright.
    $machineScopeIds = @("Git.Git", "Microsoft.EdgeWebView2Runtime", "Microsoft.VisualStudio.2022.BuildTools")
    $needsElevation = @($ids.Keys | Where-Object { $machineScopeIds -contains $_ })
    if ($needsElevation.Count -gt 0 -and -not (Test-IsElevated)) {
        Write-WindowsDevInfo "Machine-scope packages queued ($($needsElevation -join ', ')) from a non-elevated shell; expect UAC prompts. If installs fail, rerun 'just bootstrap-windows install' from an elevated PowerShell."
    }

    foreach ($id in $ids.Keys) {
        if ($id -eq "Microsoft.VisualStudio.2022.BuildTools") {
            Invoke-WingetInstall -Id $id -Name $ids[$id] -ExtraArgs @("--override", "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended") | Out-Null
        } else {
            Invoke-WingetInstall -Id $id -Name $ids[$id] | Out-Null
        }
    }

    Update-SessionPathFromRegistry
    if (-not (Initialize-MsvcEnvironment) -or [string]::IsNullOrWhiteSpace((Get-CommandSource "link.exe"))) {
        if (Invoke-MsvcWorkloadInstall) {
            Update-SessionPathFromRegistry
            Initialize-MsvcEnvironment | Out-Null
        } else {
            Add-Warn "MSVC Build Tools" "Could not repair the VC workload automatically; open Visual Studio Installer and add Desktop development with C++."
        }
    }

    if (-not [string]::IsNullOrWhiteSpace((Get-CommandSource "rustup"))) {
        Invoke-CheckedCommand -FilePath "rustup" -ArgumentList @("toolchain", "install", (Get-RequiredRustVersion)) -Label "rustup toolchain install $(Get-RequiredRustVersion)"
    }

    Initialize-MsvcEnvironment | Out-Null

    if (-not [string]::IsNullOrWhiteSpace((Get-CommandSource "fnm"))) {
        Ensure-FnmNode
        Import-BlockNpmUserEnvironment
        Invoke-CheckedCommand -FilePath (Get-CorepackCommand) -ArgumentList @("enable") -Label "corepack enable"
        # pnpm activation source is a deliberate two-path decision:
        # - Block npm env configured: corepack fetches pnpm from the Block
        #   registry (COREPACK_NPM_REGISTRY) with COREPACK_INTEGRITY_KEYS=0,
        #   because Artifactory does not mirror npm's signing keys.
        # - Fresh machine, no Block env: corepack falls back to public npmjs
        #   for the version-pinned pnpm with integrity verification enabled.
        if (-not (Invoke-CorepackPreparePnpm)) {
            Invoke-NpmInstallPnpm | Out-Null
        }
        try {
            Assert-PnpmReady
        } catch {
            Add-Warn "pnpm" "$($_.Exception.Message) If this is a fresh machine, configure Block npm access from docs/windows-onboarding.md and rerun 'just bootstrap-windows install'."
        }
        $blockNpmReachability = Test-BlockNpmRegistryReachability
        if (-not $blockNpmReachability.Ready) {
            Add-Warn "Block npm HTTPS" "Could not reach $(Get-BlockNpmRegistry) with Node/npm TLS settings. Configure Block npm access from docs/windows-onboarding.md, then rerun. Details: $($blockNpmReachability.Message)"
        }
    }

    # Re-verify the full prerequisite set so the exit code reflects reality:
    # a failed or declined install must not end in "Install mode complete".
    # The re-check is authoritative (every winget id above maps to a snapshot
    # check); install failures are replayed as context for the FAIL lines.
    Write-WindowsDevSection "Re-verifying prerequisites after install"
    Update-SessionPathFromRegistry
    Invoke-PrerequisiteEvaluation -Prereqs (Get-WindowsPrerequisiteSnapshot)

    if ($script:Failures -gt 0) {
        Write-Host ""
        foreach ($failure in $script:InstallFailures) {
            Write-Host "During install: $($failure.Name) - $($failure.Message)" -ForegroundColor Yellow
        }
        Write-Host "Install mode finished with $script:Failures remaining prerequisite failure(s). Fix the FAIL lines above (an elevated PowerShell resolves most machine-scope installs), then rerun 'just bootstrap-windows install'." -ForegroundColor Red
        exit 1
    }

    Write-WindowsDevInfo "Install mode complete. Open a new PowerShell window if PATH changes are not visible, then run 'just doctor-windows'."
    exit 0
}

if ($script:Failures -gt 0) {
    Write-Host ""
    Write-Host "Bootstrap check found $script:Failures missing prerequisite(s)." -ForegroundColor Red
    Write-Host "Run 'just bootstrap-windows install' to install missing WinGet tools. For network or trust failures, follow the remediation above."
    exit 1
}

Write-Host ""
Write-Host "Bootstrap check passed." -ForegroundColor Green
