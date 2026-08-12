param(
    [ValidateSet("check", "remove")]
    [string]$Mode = "check",
    [switch]$All,
    [switch]$IncludeNodeState,
    [switch]$IncludeSharedTools,
    [switch]$IncludeVisualStudioBuildTools,
    [switch]$IncludeWebView2,
    [switch]$Yes,
    [switch]$YesShared
)

$ErrorActionPreference = "Stop"
trap {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
Import-Module (Join-Path $PSScriptRoot "WindowsDev.psm1") -Force -DisableNameChecking

Assert-WindowsHost
Set-Location (Get-BerdRepoRoot)
Update-SessionPathFromRegistry

if ($Mode -eq "remove" -and -not $Yes) {
    throw "Cleanup remove mode is destructive. Re-run with -Yes after reviewing 'just cleanup-windows'."
}

# -All selects every category except WebView2: the WebView2 Runtime is OS-level
# infrastructure shared by Teams/Outlook/every WebView2 app, so removing it is
# never implied and always needs its own explicit flag.
if ($All) {
    $IncludeNodeState = $true
    $IncludeSharedTools = $true
    $IncludeVisualStudioBuildTools = $true
}

# Categories beyond this line remove machine- or user-shared software that
# other projects may rely on (global Node state, rustup toolchains, CMake,
# LLVM, Python, ...). Selecting them (-Include*/-All) is one decision;
# executing their removal requires the second -YesShared acknowledgment.
$sharedSelected = $IncludeNodeState -or $IncludeSharedTools -or $IncludeVisualStudioBuildTools -or $IncludeWebView2
if ($Mode -eq "remove" -and $sharedSelected -and -not $YesShared) {
    throw ("The selected categories uninstall software shared beyond Berd (Node state, rustup, CMake, LLVM, jq, Python, just, Lefthook, Build Tools" +
        $(if ($IncludeWebView2) { ", WebView2 Runtime" } else { "" }) +
        "). Review the dry run, then re-run with both -Yes and -YesShared, or drop -All/-Include* to remove only Berd-owned state.")
}

$script:Warnings = 0
$script:Actions = 0
$script:Mode = $Mode

function Write-CleanupLine {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )
    Write-Host "$Status $Name - $Message" -ForegroundColor $Color
}

function Add-Warn {
    param([string]$Name, [string]$Message)
    $script:Warnings += 1
    Write-CleanupLine "WARN" $Name $Message Yellow
}

function Add-Skip {
    param([string]$Name, [string]$Message)
    Write-CleanupLine "SKIP" $Name $Message DarkYellow
}

function Add-Absent {
    param([string]$Name, [string]$Message)
    Write-CleanupLine "ABSENT" $Name $Message DarkGray
}

function Add-Plan {
    param([string]$Name, [string]$Message)
    $script:Actions += 1
    Write-CleanupLine "WOULD REMOVE" $Name $Message Cyan
}

function Add-Removed {
    param([string]$Name, [string]$Message)
    $script:Actions += 1
    Write-CleanupLine "REMOVED" $Name $Message Green
}

function Add-Ran {
    param([string]$Name, [string]$Message)
    $script:Actions += 1
    Write-CleanupLine "RAN" $Name $Message Green
}

function Test-RemoveMode {
    return $script:Mode -eq "remove"
}

# Normalize-FullPath / Assert-SafeCleanupPath live in WindowsDev.psm1 so
# Test-WindowsDev.ps1 can cover the containment rules.

function Remove-CleanupPath {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
        Add-Absent $Name $Path
        return
    }

    Assert-SafeCleanupPath -Path $Path -AllowedRoot $AllowedRoot
    if (Test-RemoveMode) {
        $removeErrors = @()
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable removeErrors
        if (-not (Test-Path -LiteralPath $Path)) {
            Add-Removed $Name $Path
            return
        }

        $details = "path still exists after remove"
        if ($removeErrors.Count -gt 0) {
            $messages = $removeErrors |
                Select-Object -First 3 |
                ForEach-Object { $_.Exception.Message }
            $details = ($messages -join "; ")
            if ($removeErrors.Count -gt 3) {
                $details = "$details; ... $($removeErrors.Count - 3) more error(s)"
            }
        }
        Add-Warn $Name "remove did not complete: $details"
    } else {
        Add-Plan $Name $Path
    }
}

function Invoke-CorepackDisable {
    if (-not $IncludeNodeState) {
        Add-Skip "Corepack shims" "pass -IncludeNodeState or -All to disable Corepack shims"
        return
    }
    $corepack = Get-CorepackCommand
    if ([string]::IsNullOrWhiteSpace($corepack)) {
        Add-Absent "Corepack shims" "corepack not found"
        return
    }
    if (Test-RemoveMode) {
        $result = Invoke-CaptureCommand -FilePath $corepack -ArgumentList @("disable")
        if ($result.ExitCode -eq 0) {
            Add-Ran "Corepack shims" "corepack disable"
        } else {
            Add-Warn "Corepack shims" "corepack disable failed: $($result.Output)"
        }
    } else {
        Add-Plan "Corepack shims" "run corepack disable"
    }
}

function Invoke-NpmPnpmUninstall {
    if (-not $IncludeNodeState) {
        Add-Skip "npm global pnpm" "pass -IncludeNodeState or -All to remove pnpm if npm installed it globally"
        return
    }

    if (-not (Test-RemoveMode)) {
        # Keep the dry run read-only: Initialize-FnmEnvironment creates a new
        # fnm_multishells directory (state this cleanup targets), so npm is
        # only resolved when actually removing.
        Add-Plan "npm global pnpm" "npm uninstall -g pnpm if the bootstrap fallback installed it"
        return
    }

    Initialize-FnmEnvironment | Out-Null
    $npm = Get-NpmCommand
    if ([string]::IsNullOrWhiteSpace($npm)) {
        Add-Absent "npm global pnpm" "npm not found"
        return
    }

    $result = Invoke-CaptureCommand -FilePath $npm -ArgumentList @("uninstall", "-g", "pnpm")
    if ($result.ExitCode -eq 0) {
        Add-Ran "npm global pnpm" "npm uninstall -g pnpm"
    } else {
        Add-Warn "npm global pnpm" "npm uninstall -g pnpm failed: $($result.Output)"
    }
}

function Invoke-FnmNodeUninstall {
    param([string]$Version, [string]$VersionDir)
    if (-not $IncludeNodeState) {
        Add-Skip "fnm Node $Version" "pass -IncludeNodeState or -All to uninstall fnm-managed Node"
        return
    }
    if (-not (Test-Path -LiteralPath $VersionDir)) {
        Add-Absent "fnm Node $Version" $VersionDir
        return
    }
    $fnm = Get-CommandSource "fnm"
    if ([string]::IsNullOrWhiteSpace($fnm)) {
        Add-Skip "fnm Node $Version" "fnm is unavailable; remove $VersionDir manually if desired"
        return
    }
    if (Test-RemoveMode) {
        $result = Invoke-CaptureCommand -FilePath $fnm -ArgumentList @("uninstall", $Version)
        if ($result.ExitCode -eq 0 -or -not (Test-Path -LiteralPath $VersionDir)) {
            Add-Removed "fnm Node $Version" $VersionDir
        } else {
            Add-Warn "fnm Node $Version" "fnm uninstall failed: $($result.Output)"
        }
    } else {
        Add-Plan "fnm Node $Version" "run fnm uninstall $Version"
    }
}

function Remove-LefthookGitHook {
    param([Parameter(Mandatory = $true)][string]$HookName)
    $hookPath = Join-Path $paths.GitHooksDir $HookName
    if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) {
        Add-Absent "Git hook $HookName" $hookPath
        return
    }
    $content = Get-Content -Raw -LiteralPath $hookPath -ErrorAction SilentlyContinue
    if ($content -notmatch "(?i)lefthook") {
        Add-Skip "Git hook $HookName" "hook exists but does not look Lefthook-managed"
        return
    }
    Remove-CleanupPath "Git hook $HookName" $hookPath $paths.GitHooksDir
}

function Test-WingetPackageInstalled {
    param([string]$Id)
    $winget = Get-CommandSource "winget"
    if ([string]::IsNullOrWhiteSpace($winget)) {
        return [pscustomobject]@{ Winget = $null; Installed = $false; Message = "winget unavailable" }
    }
    # `winget list --id <id> -e` exits 0 when the package is installed and
    # non-zero ("No installed package found") otherwise. Match on the exit
    # code, not the output: winget truncates ids to console width, so long ids
    # like Microsoft.VisualStudio.2022.BuildTools get ellipsized in the text.
    $result = Invoke-CaptureCommand -FilePath $winget -ArgumentList @("list", "--id", $Id, "-e", "--disable-interactivity", "--accept-source-agreements")
    return [pscustomobject]@{
        Winget = $winget
        Installed = ($result.ExitCode -eq 0)
        Message = $result.Output
    }
}

function Invoke-RustupSelfUninstall {
    # `rustup self uninstall` removes ~/.cargo and ~/.rustup (multi-GB of
    # toolchains); `winget uninstall Rustlang.Rustup` deletes only the
    # installer entry and orphans both directories.
    $rustup = Get-CommandSource "rustup"
    if ([string]::IsNullOrWhiteSpace($rustup)) {
        Add-Absent "rustup" "rustup not found"
        return
    }
    if (Test-RemoveMode) {
        $result = Invoke-CaptureCommand -FilePath $rustup -ArgumentList @("self", "uninstall", "-y")
        if ($result.ExitCode -eq 0) {
            Add-Ran "rustup" "rustup self uninstall -y (removes ~/.cargo and ~/.rustup)"
        } else {
            Add-Warn "rustup" "rustup self uninstall failed: $($result.Output)"
        }
    } else {
        Add-Plan "rustup" "run rustup self uninstall -y (removes ~/.cargo and ~/.rustup)"
    }
}

function Invoke-WingetUninstall {
    param([string]$Name, [string]$Id)
    $state = Test-WingetPackageInstalled -Id $Id
    if ([string]::IsNullOrWhiteSpace($state.Winget)) {
        Add-Skip $Name $state.Message
        return
    }
    if (-not $state.Installed) {
        Add-Absent $Name "WinGet package $Id not installed"
        return
    }
    if (Test-RemoveMode) {
        $result = Invoke-CaptureCommand -FilePath $state.Winget -ArgumentList @("uninstall", "--id", $Id, "-e", "--accept-source-agreements")
        if ($result.ExitCode -eq 0) {
            Add-Ran $Name "winget uninstall --id $Id"
        } else {
            Add-Warn $Name "winget uninstall failed: $($result.Output)"
        }
    } else {
        Add-Plan $Name "winget uninstall --id $Id"
    }
}

Write-WindowsDevSection "Berd Windows cleanup ($Mode)"
if ($Mode -eq "check") {
    Write-WindowsDevInfo "Dry run only. Use 'just cleanup-windows remove -Yes' for default removal."
}

$paths = Resolve-WindowsCleanupPaths
Write-WindowsDevSection "Berd-local caches"
Remove-CleanupPath "Managed Goose cache" $paths.BerdDevRoot $paths.BerdDevRoot
Remove-CleanupPath "Tauri cargo cache" $paths.BerdTauriRoot $paths.BerdTauriRoot

Write-WindowsDevSection "Repo-local generated state"
Remove-CleanupPath "root node_modules" $paths.RepoNodeModules (Get-BerdRepoRoot)
Remove-CleanupPath "root pnpm store" $paths.RepoPnpmStore (Get-BerdRepoRoot)
Remove-CleanupPath "root dist" $paths.RepoDist (Get-BerdRepoRoot)
Remove-CleanupPath "sdk node_modules" $paths.SdkNodeModules (Join-Path (Get-BerdRepoRoot) "sdk")
Remove-CleanupPath "sdk dist" $paths.SdkDist (Join-Path (Get-BerdRepoRoot) "sdk")
Remove-LefthookGitHook "pre-commit"
Remove-LefthookGitHook "pre-push"

Write-WindowsDevSection "Node state"
Invoke-CorepackDisable
if ($IncludeNodeState) {
    Remove-CleanupPath "Corepack pnpm $(Get-RequiredPnpmVersion)" $paths.CorepackPnpmVersionDir $paths.CorepackPnpmVersionDir
    Remove-CleanupPath "fnm multishells" $paths.FnmMultishellsDir $paths.FnmMultishellsDir
} else {
    Add-Skip "Corepack pnpm $(Get-RequiredPnpmVersion)" "pass -IncludeNodeState or -All to remove the Corepack pnpm cache"
    Add-Skip "fnm multishells" "pass -IncludeNodeState or -All to remove fnm transient shell directories"
}
Invoke-NpmPnpmUninstall
Invoke-FnmNodeUninstall -Version (Get-RequiredNodeVersion) -VersionDir $paths.FnmNodeVersionDir

Write-WindowsDevSection "Shared WinGet tools"
if (-not $IncludeSharedTools) {
    Add-Skip "Shared tools" "pass -IncludeSharedTools or -All to uninstall rustup, fnm, CMake, LLVM, jq, Python, just, and Lefthook"
} else {
    Invoke-RustupSelfUninstall
    $sharedPackages = @(
        [pscustomobject]@{ Name = "fnm"; Id = "Schniz.fnm" },
        [pscustomobject]@{ Name = "CMake"; Id = "Kitware.CMake" },
        [pscustomobject]@{ Name = "LLVM"; Id = "LLVM.LLVM" },
        [pscustomobject]@{ Name = "jq"; Id = "jqlang.jq" },
        [pscustomobject]@{ Name = "Python 3.12"; Id = "Python.Python.3.12" },
        [pscustomobject]@{ Name = "just"; Id = "Casey.Just" },
        [pscustomobject]@{ Name = "Lefthook"; Id = "evilmartians.lefthook" }
    )
    foreach ($package in $sharedPackages) {
        Invoke-WingetUninstall -Name $package.Name -Id $package.Id
    }
}

Write-WindowsDevSection "WebView2 Runtime"
if (-not $IncludeWebView2) {
    Add-Skip "WebView2 Runtime" "OS-shared component (Teams/Outlook/all WebView2 apps); pass -IncludeWebView2 explicitly to uninstall (not included in -All)"
} else {
    Invoke-WingetUninstall -Name "WebView2 Runtime" -Id "Microsoft.EdgeWebView2Runtime"
}

Write-WindowsDevSection "Visual Studio Build Tools"
if (-not $IncludeVisualStudioBuildTools) {
    Add-Skip "Visual Studio Build Tools" "pass -IncludeVisualStudioBuildTools or -All to uninstall Microsoft.VisualStudio.2022.BuildTools"
} else {
    Invoke-WingetUninstall -Name "Visual Studio Build Tools" -Id "Microsoft.VisualStudio.2022.BuildTools"
}

Write-Host ""
if ($Mode -eq "check") {
    Write-Host "Cleanup dry run complete. No changes were made." -ForegroundColor Green
    Write-Host "Default removal: just cleanup-windows remove -Yes"
    Write-Host "Full reset: just cleanup-windows remove -All -Yes -YesShared"
} else {
    if ($script:Warnings -gt 0) {
        Write-Host "Cleanup remove mode finished with $script:Warnings warning(s); some state was not removed." -ForegroundColor Red
        Write-Host "Review the WARN lines above (close editors/AV locks, or elevate), then rerun."
        exit 1
    }
    Write-Host "Cleanup remove mode complete." -ForegroundColor Green
    Write-Host "Open a new PowerShell window so PATH and user environment changes refresh."
}
