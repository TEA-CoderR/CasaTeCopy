@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set PORT=3000
rem 打开「产品库」页面；程序没在运行时先启动它
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if %errorlevel%==0 (
  start "" http://localhost:%PORT%/catalog
  exit /b 0
)
set OPEN_PATH=/catalog
call "%~dp0启动.bat"
