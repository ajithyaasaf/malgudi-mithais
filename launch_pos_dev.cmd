@echo off
set "DEV_DIR=%LOCALAPPDATA%\MalgudiMithaisPOS-Dev"
set "MALGUDI_DB_PATH=%DEV_DIR%\data\malgudi_pos_dev.db"
set "WEBVIEW2_USER_DATA_FOLDER=%DEV_DIR%\EBWebView"

if not exist "%DEV_DIR%\data" mkdir "%DEV_DIR%\data"
if not exist "%DEV_DIR%\EBWebView" mkdir "%DEV_DIR%\EBWebView"

taskkill /F /IM malgudi-pos-native.exe >nul 2>&1

echo Launching Malgudi Mithais POS (Development Mode)...
echo Active Isolated DB: %MALGUDI_DB_PATH%

"%~dp0apps\pos\src-tauri\target\debug\malgudi-pos-native.exe"
