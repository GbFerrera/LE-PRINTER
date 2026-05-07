@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."
if not exist node_modules (
  npm ci
)
call npm run build:win:all
if %errorlevel% neq 0 (
  exit /b %errorlevel%
)
exit /b 0
