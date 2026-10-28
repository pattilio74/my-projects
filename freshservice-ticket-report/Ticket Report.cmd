@echo off
REM Double-click launcher for the Freshservice Ticket Report app.
REM Starts the local server (if needed) and opens it in an app window.
cd /d "%~dp0"
node "launch-app.mjs"
