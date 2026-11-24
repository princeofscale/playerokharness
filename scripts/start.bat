@echo off
chcp 65001 >nul
cd /d "%~dp0.."

if not exist "node_modules" (
  echo Installing dependencies...
  call pnpm install
)

if not exist "packages\app\dist\cli.js" (
  echo Building PlayerOK Universal v2...
  call pnpm build
)

if not exist "bot_settings\config.json" (
  node packages\app\dist\cli.js setup --data-dir "%CD%"
)

node packages\app\dist\cli.js start --data-dir "%CD%"
pause
