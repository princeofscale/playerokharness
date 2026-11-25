@echo off
chcp 65001 >nul
cd /d "%~dp0.."

if not exist "node_modules" (
  echo Installing dependencies...
  call pnpm install
)

rem Incremental build on every start: a stale dist\ used to run silently after a
rem source change. Set PKH_SKIP_BUILD=1 to skip it.
if not "%PKH_SKIP_BUILD%"=="1" (
  echo Building PlayerOK Harness (pkh)...
  call pnpm build
)

if not exist "bot_settings\config.json" (
  node packages\app\dist\cli.js setup --data-dir "%CD%"
)

node packages\app\dist\cli.js start --data-dir "%CD%"
pause
