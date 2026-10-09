# Development helper: install this checkout through the official DSH CLI.
# Desktop: pass its bundled dsh.cmd with -DshCommand and -Profile desktop.
# GitHub distribution: use the Desktop plugin page instead of this helper.
param(
    [ValidateNotNullOrEmpty()]
    [string]$Profile = "web",
    [ValidateNotNullOrEmpty()]
    [string]$DshCommand = "dsh",
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$command = Get-Command $DshCommand -ErrorAction Stop
$previousDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")

try {
    if ($DshHome -ne "") {
        if ($DshHome.Trim() -eq "") {
            throw "DshHome must be a directory path, not whitespace."
        }
        [Environment]::SetEnvironmentVariable("DSH_HOME", $DshHome, "Process")
    }

    & $command.Source plugin --profile $Profile add "link:$repoRoot"
    if ($LASTEXITCODE -ne 0) {
        throw "Official DSH plugin installation failed with exit code $LASTEXITCODE."
    }
} finally {
    [Environment]::SetEnvironmentVariable("DSH_HOME", $previousDshHome, "Process")
}

if ($Profile -eq "desktop") {
    Write-Host "Done. Fully quit Desktop (including its tray process), then reopen it."
} else {
    Write-Host "Done. Restart the DSH host using profile '$Profile'."
}
