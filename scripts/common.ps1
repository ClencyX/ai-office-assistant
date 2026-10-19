$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot 'data'
$PlatformUrl = 'http://127.0.0.1:3080'

function Initialize-Platform {
    New-Item -ItemType Directory -Path $DataRoot,(Join-Path $DataRoot 'n8n'),(Join-Path $DataRoot 'logs'),(Join-Path $ProjectRoot 'backups') -Force | Out-Null
    $envPath = Join-Path $ProjectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $a = New-Object byte[] 32
            $b = New-Object byte[] 32
            $rng.GetBytes($a)
            $rng.GetBytes($b)
            $automation = -join ($a | ForEach-Object { $_.ToString('x2') })
            $encryption = -join ($b | ForEach-Object { $_.ToString('x2') })
            $lines = @("AUTOMATION_KEY=$automation", "N8N_ENCRYPTION_KEY=$encryption", 'SEED_DEMO=1')
            [IO.File]::WriteAllLines($envPath, $lines, (New-Object Text.UTF8Encoding($false)))
        } finally { $rng.Dispose() }
    }
}

function Read-PlatformEnvironment {
    $values = @{}
    foreach ($line in (Get-Content -LiteralPath (Join-Path $ProjectRoot '.env'))) {
        if ($line -match '^([A-Z_][A-Z0-9_]*)=([A-Za-z0-9_-]+)$') { $values[$matches[1]] = $matches[2] }
    }
    if ($env:SERVERCHAN_SENDKEY) { $values.SERVERCHAN_SENDKEY = $env:SERVERCHAN_SENDKEY }
    if (-not $values.AUTOMATION_KEY -or -not $values.N8N_ENCRYPTION_KEY) { throw '本地 .env 缺少调度密钥，请检查文件；已有数据时请勿直接删除原密钥。' }
    return $values
}

function Test-Platform {
    try { return (Invoke-RestMethod -Uri "$PlatformUrl/api/health" -TimeoutSec 2).ok -eq $true } catch { return $false }
}

function Find-Node {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $candidates = @()
    if ($nodeCommand) { $candidates += $nodeCommand.Source }
    $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    $candidates += 'C:\Program Files\nodejs\node.exe'
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $candidate) {
            $version = & $candidate --version
            if ([int]$version.TrimStart('v').Split('.')[0] -ge 24) { return $candidate }
        }
    }
    throw '需要 Node.js 24 或以上版本。请安装 Node.js 24 LTS，或先启动 Docker Desktop 后再运行。'
}

function Test-DockerEngine {
    $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $dockerCommand) { return $false }
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $dockerCommand.Source
    $startInfo.Arguments = 'info --format "{{.ServerVersion}}"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $probe = [Diagnostics.Process]::Start($startInfo)
    try {
        if (-not $probe.WaitForExit(5000)) { $probe.Kill(); return $false }
        return $probe.ExitCode -eq 0
    } finally { $probe.Dispose() }
}

function Invoke-Compose {
    param([string[]]$ComposeArguments)
    & docker compose --project-directory $ProjectRoot --file (Join-Path $ProjectRoot 'compose.yaml') @ComposeArguments
    if ($LASTEXITCODE -ne 0) { throw ('容器命令未完成，退出码：' + $LASTEXITCODE) }
}
