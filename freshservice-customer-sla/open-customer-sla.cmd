@echo off
cd /d "%~dp0"

rem Start the server only if nothing is already listening on port 3200.
netstat -ano | findstr ":3200" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  echo Starting Customer SLA Dashboard...
  start "Customer SLA Server" /min cmd /c "node server.mjs"
  rem Give the server a moment to bind the port before opening the browser.
  timeout /t 3 /nobreak >nul
) else (
  echo Customer SLA Dashboard already running.
)

start "" "http://127.0.0.1:3200"
