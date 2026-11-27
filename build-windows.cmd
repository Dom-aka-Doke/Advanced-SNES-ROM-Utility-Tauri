@echo off
rem Baut die Windows-Version: Installer (NSIS) + einzelne EXE nach .\dist
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
echo Baue Windows-Anwendung ... (Log: build-windows.log)
call npx --no-install tauri build --bundles nsis > build-windows.log 2>&1
set RESULT=%ERRORLEVEL%
if %RESULT%==0 (
  if not exist dist mkdir dist
  copy /y "src-tauri\target\release\bundle\nsis\*.exe" dist\ >> build-windows.log
  copy /y "src-tauri\target\release\advanced-snes-rom-utility.exe" "dist\Advanced SNES ROM Utility JS-Portable-2.1.0.exe" >> build-windows.log
)
echo EXITCODE=%RESULT%>> build-windows.log
type build-windows.log
pause
