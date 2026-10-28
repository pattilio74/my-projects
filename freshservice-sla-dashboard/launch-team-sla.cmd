@echo off
setlocal
set "APP_DIR=%~dp0"
set "PORT=3101"

powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3101/api/health' -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch { exit 1 }"
if errorlevel 1 (
  start "Team SLA Server" /min /D "%APP_DIR%" node.exe server.mjs
  timeout /t 2 /nobreak >nul
)

start "" "http://127.0.0.1:3101"
endlocal
