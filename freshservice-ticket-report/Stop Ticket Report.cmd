@echo off
REM Double-click to stop the Freshservice Ticket Report server.
cd /d "%~dp0"
node "stop-app.mjs"
echo.
pause
