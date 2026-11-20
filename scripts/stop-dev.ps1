$ErrorActionPreference = 'Stop'

try {
    $root = Split-Path -Parent $PSScriptRoot
    Set-Location -LiteralPath $root
    $portText = & node -e "require('dotenv').config(); process.stdout.write(String(process.env.PORT || 3000));"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the service port using Node and dotenv.' }
    $port = 0
    if (-not [int]::TryParse([string]$portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw 'PORT must be an integer between 1 and 65535.'
    }

    $processes = @(Get-CimInstance Win32_Process)
    $entryPoints = @(
        (Join-Path $root 'node_modules\nodemon\bin\nodemon.js'),
        (Join-Path $root 'src\index.js')
    )
    $targets = @{}
    foreach ($process in $processes) {
        if ($process.Name -ne 'node.exe') { continue }
        $command = ([string]$process.CommandLine).Replace('/', '\')
        foreach ($entry in $entryPoints) {
            if ($command -match ([regex]::Escape($entry) + '(?=["\s]|$)')) {
                $targets[[int]$process.ProcessId] = $true
            }
        }
    }

    # Include nodemon's child shell and server, but never its parent terminal.
    do {
        $added = $false
        foreach ($process in $processes) {
            $processId = [int]$process.ProcessId
            if ($targets.ContainsKey([int]$process.ParentProcessId) -and -not $targets.ContainsKey($processId)) {
                $targets[$processId] = $true
                $added = $true
            }
        }
    } while ($added)

    $listeners = @(Get-NetTCPConnection -State Listen |
        Where-Object { $_.LocalPort -eq $port } |
        Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($listenerId in $listeners) {
        if ($targets.ContainsKey([int]$listenerId)) { continue }
        $owner = $processes | Where-Object { $_.ProcessId -eq $listenerId }
        Write-Host "Port $port is used by PID $listenerId ($($owner.Name))."
        Write-Host $owner.CommandLine
        $answer = Read-Host 'Cannot confirm this belongs to this project. Stop this PID? Type YES to confirm'
        if ($answer -cne 'YES') { throw "Leaving PID $listenerId running." }
        $targets[[int]$listenerId] = $true
    }

    # Stop identified nodemon supervisors before their children to prevent respawning.
    foreach ($process in ($processes | Sort-Object CreationDate)) {
        $processId = [int]$process.ProcessId
        if (-not $targets.ContainsKey($processId)) { continue }
        $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $current) { continue }
        if ($current.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne
            $process.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) {
            throw "PID $processId has been reused; run the launcher again."
        }
        Write-Host "Stopping PID $processId ($($process.Name))..."
        Stop-Process -Id $processId -Force -ErrorAction Stop
        $current.WaitForExit()
    }
    Write-Host "Starting development service on port $port..."
} catch {
    Write-Error $_
    exit 1
}
