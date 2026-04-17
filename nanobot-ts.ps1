param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$packageDir = Join-Path $repoRoot "nanobot-ts"
$distCli = Join-Path $packageDir "dist\cli.js"

function Invoke-PackageScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptName,
        [string[]]$ForwardArgs = @()
    )

    $command = @("--dir", $packageDir, $ScriptName)
    if ($ForwardArgs.Count -gt 0) {
        $command += "--"
        $command += $ForwardArgs
    }

    & pnpm @command
    exit $LASTEXITCODE
}

function Ensure-Build {
    if (Test-Path $distCli) {
        return
    }

    Write-Host "nanobot-ts dist missing, running build first..." -ForegroundColor Cyan
    & pnpm --dir $packageDir build
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if ($Args.Count -eq 0) {
    Ensure-Build
    & node $distCli --help
    exit $LASTEXITCODE
}

$command = $Args[0].ToLowerInvariant()
$rest = if ($Args.Count -gt 1) { $Args[1..($Args.Count - 1)] } else { @() }

switch ($command) {
    "build" {
        Invoke-PackageScript -ScriptName "build" -ForwardArgs $rest
    }
    "dev" {
        Invoke-PackageScript -ScriptName "dev" -ForwardArgs $rest
    }
    "test" {
        Invoke-PackageScript -ScriptName "test" -ForwardArgs $rest
    }
    "check" {
        Invoke-PackageScript -ScriptName "check" -ForwardArgs $rest
    }
    "gateway" {
        Ensure-Build
        & node $distCli gateway @rest
        exit $LASTEXITCODE
    }
    default {
        Ensure-Build
        & node $distCli @Args
        exit $LASTEXITCODE
    }
}
