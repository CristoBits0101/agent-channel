@echo off
rem Opens the agent channel window on Windows. Requires Node.js 22 or later.
cd /d "%~dp0"
node launch.mjs
if errorlevel 1 pause
