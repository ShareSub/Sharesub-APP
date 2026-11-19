param(
    [Parameter(Mandatory)][string]$Xray,
    [Parameter(Mandatory)][string]$Session,
    [Parameter(Mandatory)][int]$Parent
)
$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $Session 'state'
$stopFile = Join-Path $Session 'stop'
$configFile = Join-Path $Session 'config.json'
$logFile = Join-Path $Session 'xray.log'
$stderrFile = Join-Path $Session 'stderr.log'
$memoryFile = Join-Path $Session 'memory'
$exeDir = Split-Path -Parent $Xray
$env:XRAY_LOCATION_ASSET = $exeDir
$process = $null
$failed = $false

function Set-TunnelState($value) {
    [IO.File]::WriteAllText($stateFile, $value)
}

function Test-Parent {
    $owner = Get-Process -Id $Parent -ErrorAction SilentlyContinue
    return $null -ne $owner
}

try {
    if ((Test-Path -LiteralPath $stopFile) -or !(Test-Parent)) { return }
    $process = Start-Process -FilePath $Xray -ArgumentList @('run','-config', ('"{0}"' -f $configFile)) -WorkingDirectory $exeDir -RedirectStandardOutput $logFile -RedirectStandardError $stderrFile -PassThru -WindowStyle Hidden
    $ready = $false
    $nextSample = [DateTime]::MinValue
    while (!$process.HasExited -and (Test-Parent) -and !(Test-Path -LiteralPath $stopFile)) {
        if (!$ready -and (Select-String -LiteralPath $logFile -Pattern 'Xray .+ started' -Quiet -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $configFile -ErrorAction SilentlyContinue
            Set-TunnelState 'ready'
            $ready = $true
        }
        if ([DateTime]::UtcNow -ge $nextSample) {
            [IO.File]::WriteAllText($memoryFile, [string]$process.WorkingSet64)
            $nextSample = [DateTime]::UtcNow.AddSeconds(5)
        }
        Start-Sleep -Milliseconds 220
        $process.Refresh()
    }
    $failed = $process.HasExited -and (Test-Parent) -and !(Test-Path -LiteralPath $stopFile)
} catch {
    $failed = $true
} finally {
    if ($null -ne $process -and !$process.HasExited) { $process.Kill(); $null = $process.WaitForExit(3500) }
    if ($failed) {
        Set-TunnelState 'failed'
        for ($i = 0; $i -lt 50 -and (Test-Parent) -and !(Test-Path -LiteralPath $stopFile); $i++) {
            Start-Sleep -Milliseconds 140
        }
    }
    foreach ($file in @($stateFile, $configFile, $logFile, $stderrFile, $stopFile, $memoryFile)) {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    [IO.Directory]::Delete($Session)
}
