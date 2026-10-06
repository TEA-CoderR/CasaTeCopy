@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title CasaTeCopy
set PORT=3000
set NODE_ENV=production

rem Already running? just open the browser
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if %errorlevel%==0 (
  echo CasaTeCopy 已在运行，正在打开浏览器...
  start "" http://localhost:%PORT%
  timeout /t 2 >nul
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Node.js，正在尝试自动安装（需要几分钟）...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo 安装完成后请关闭此窗口，再双击一次「启动.bat」。
  echo 如果自动安装失败，请到 https://nodejs.org 下载安装 LTS 版本。
  pause
  exit /b 1
)

echo.
echo ==============================================
echo   CasaTeCopy 正在启动...
echo   浏览器地址: http://localhost:%PORT%
echo   使用期间请不要关闭这个黑色窗口，关闭即停止。
echo ==============================================
echo.
start "" /min cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:%PORT%"
node server.mjs
echo.
echo 服务已停止。
pause
