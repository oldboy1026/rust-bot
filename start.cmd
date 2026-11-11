@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 (
  echo This project requires Node.js 22 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\steam-user\package.json" (
  call npm.cmd ci --registry=https://registry.npmjs.org --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node src\main.js
pause
