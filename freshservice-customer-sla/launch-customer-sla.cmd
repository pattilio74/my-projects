@echo off
cd /d "%~dp0"
echo Starting Freshservice Customer SLA Dashboard...
echo Open http://127.0.0.1:3200 in your browser. Press Ctrl+C to stop.
node server.mjs
pause
