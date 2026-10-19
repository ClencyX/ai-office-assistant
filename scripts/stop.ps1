. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $pidPath = Join-Path $DataRoot 'local-process.json'
    if (Test-Path -LiteralPath $pidPath) {
        $record = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.pid) -ErrorAction SilentlyContinue
        if ($process -and $process.CommandLine -and $process.CommandLine.Contains([string]$record.server)) {
            Stop-Process -Id $record.pid -ErrorAction Stop
            Write-Host '本地服务已停止。'
        }
        Remove-Item -LiteralPath $pidPath
    }
    if (Test-DockerEngine) { Invoke-Compose @('stop') }
    Write-Host '平台已停止，任务数据完整保留在 E 盘。' -ForegroundColor Green
} catch {
    Write-Host ('停止失败：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
