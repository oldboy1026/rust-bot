@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
node scripts\facepunch-status.mjs
pause
