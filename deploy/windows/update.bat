@echo off
cd /d "%~dp0"
title CasaTeCopy update
node "%~dp0update.mjs"
if errorlevel 1 (
  pause
  exit /b 1
)
timeout /t 5 >nul
