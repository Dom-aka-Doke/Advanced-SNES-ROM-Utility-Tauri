@echo off
rem Richtet die Build-Umgebung ein (Node.js, Rust, C++ Build Tools, npm install)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"
pause
