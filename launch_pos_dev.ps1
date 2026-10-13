# Stop any stale instances to release WebView2 user data directory lock
Get-Process malgudi-pos-native -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

# Ensure dev directories exist
$devDir = "$env:LOCALAPPDATA\MalgudiMithaisPOS-Dev"
$devDbDir = Join-Path $devDir "data"
$devWebviewDir = Join-Path $devDir "EBWebView"
New-Item -ItemType Directory -Force -Path $devDbDir, $devWebviewDir | Out-Null

$env:MALGUDI_DB_PATH = Join-Path $devDbDir "malgudi_pos_dev.db"
$env:WEBVIEW2_USER_DATA_FOLDER = $devWebviewDir

# Verify frontend dev server on port 5173
$vitePort = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
if (-not $vitePort) {
    Write-Host "Starting Vite frontend server on port 5173..." -ForegroundColor Yellow
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c pnpm --filter @malgudi/pos dev" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        if (Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue) {
            $ready = $true
            break
        }
    }
    if (-not $ready) {
        Write-Error "Vite frontend server failed to start on port 5173. Please run 'pnpm --filter @malgudi/pos dev' manually."
        exit 1
    }
}
Write-Host "Vite dev server is ready on http://localhost:5173" -ForegroundColor Green

$exe = Join-Path $PSScriptRoot "apps\pos\src-tauri\target\debug\malgudi-pos-native.exe"

Write-Host "Launching Malgudi Mithais POS (Development Mode)..." -ForegroundColor Cyan
Write-Host "Active Isolated DB: $env:MALGUDI_DB_PATH" -ForegroundColor Green

if (Test-Path $exe) {
    # Run in foreground so child process is not killed when pnpm/PowerShell wrapper exits
    & $exe
} else {
    Write-Error "Executable not found at $exe. Please build first with cargo build."
}
