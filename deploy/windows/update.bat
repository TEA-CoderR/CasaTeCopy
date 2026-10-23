@echo off
chcp 65001 >nul
setlocal
title CasaTeCopy 更新
cd /d "%~dp0"
rem ------------------------------------------------------------------
rem  一键更新：下载最新程序 -> 打包 -> 停止旧程序 -> 备份 -> 替换 -> 启动
rem  只替换 server.mjs、dist 和几个脚本；catalog / saved_images / publish /
rem  browser_profile（采集好的数据和登录状态）一律不动。
rem  源代码放在旁边的「<本文件夹>-src」文件夹里（例如 D:\CasaTeCopy-src），
rem  每次更新都会被重置成 GitHub 上 main 的最新版本，不要在那里手动改东西。
rem ------------------------------------------------------------------
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
set "SRC=%APP%-src"
set "REPO=https://github.com/TEA-CoderR/CasaTeCopy.git"
set "BRANCH=main"
set "PORT=3000"
set "BK="

echo ==============================================
echo   CasaTeCopy 一键更新
echo   采集好的数据和登录状态不会被改动
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js：请先双击「启动.bat」，它会自动安装。
  goto fail
)
set "GIT=git"
where git >nul 2>nul
if errorlevel 1 set "GIT="
if not defined GIT if exist "D:\Git\cmd\git.exe" set "GIT=D:\Git\cmd\git.exe"
if not defined GIT if exist "C:\Program Files\Git\cmd\git.exe" set "GIT=C:\Program Files\Git\cmd\git.exe"
if not defined GIT (
  echo 没有找到 Git：请到 https://git-scm.com 下载安装后再双击本文件。
  goto fail
)

echo [1/5] 下载最新程序...
if exist "%SRC%\.git" (
  "%GIT%" -C "%SRC%" fetch --depth 1 origin %BRANCH%
  if errorlevel 1 goto fail
  "%GIT%" -C "%SRC%" reset --hard FETCH_HEAD
  if errorlevel 1 goto fail
) else (
  "%GIT%" clone --depth 1 -b %BRANCH% %REPO% "%SRC%"
  if errorlevel 1 goto fail
)
echo.

echo [2/5] 安装依赖并打包（第一次要几分钟，请耐心等）...
pushd "%SRC%"
call npm install --no-audit --no-fund
if errorlevel 1 (
  popd
  goto fail
)
call node scripts\package-local.mjs
if errorlevel 1 (
  popd
  goto fail
)
popd
if not exist "%SRC%\release\CasaTeCopy\server.mjs" goto fail
if not exist "%SRC%\release\CasaTeCopy\dist\catalog.html" goto fail
echo.

echo [3/5] 停止正在运行的程序...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>nul
timeout /t 2 /nobreak >nul

echo [4/5] 备份旧版本并替换...
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%t"
set "BK=%APP%\_backup\%TS%"
mkdir "%BK%" >nul 2>nul
if exist "%APP%\server.mjs" copy /y "%APP%\server.mjs" "%BK%\server.mjs" >nul
if exist "%APP%\dist" robocopy "%APP%\dist" "%BK%\dist" /E /NFL /NDL /NJH /NJS /NP >nul
copy /y "%SRC%\release\CasaTeCopy\server.mjs" "%APP%\server.mjs" >nul
if errorlevel 1 goto restore
robocopy "%SRC%\release\CasaTeCopy\dist" "%APP%\dist" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto restore
for %%f in ("启动.bat" "产品库.bat" "使用说明.txt" "Viscio复制脚本.js" "Viscio采集对上的商品.js") do (
  if exist "%SRC%\release\CasaTeCopy\%%~f" copy /y "%SRC%\release\CasaTeCopy\%%~f" "%APP%\%%~f" >nul
)
rem 本文件自己的新版本放在旁边，下次更新前替换（正在运行的 .bat 不能覆盖）
if exist "%SRC%\release\CasaTeCopy\更新.bat" copy /y "%SRC%\release\CasaTeCopy\更新.bat" "%APP%\_backup\更新.new.bat" >nul
echo     旧版本已备份到 %BK%
echo.

echo [5/5] 启动...
start "" "%APP%\产品库.bat"
echo.
echo 更新完成，产品库页面马上会打开。这个窗口 10 秒后自动关闭。
timeout /t 10 >nul
exit /b 0

:restore
echo 替换时出错，正在恢复旧版本...
if exist "%BK%\server.mjs" copy /y "%BK%\server.mjs" "%APP%\server.mjs" >nul
if exist "%BK%\dist" robocopy "%BK%\dist" "%APP%\dist" /MIR /NFL /NDL /NJH /NJS /NP >nul
start "" "%APP%\产品库.bat"

:fail
echo.
echo ==============================================
echo   更新没有完成。正在使用的程序没有被替换，
echo   数据也没有被改动。请把这个窗口截图发给开发人员。
echo ==============================================
pause
exit /b 1
