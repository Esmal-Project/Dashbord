@echo off
title TSETMC Relay - BourseMag
cd /d "%~dp0"
echo ====================================
echo    BourseMag TSETMC Relay
echo    https://github.com/ BourseMag
echo ====================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js nasb nist!
  echo     Az nodejs.org download va nasb kon, bad in file ra dobare baz kon.
  echo.
  pause
  exit /b 1
)
echo [OK] Relay dar hal-e ejra ast... (in panjere ra naband!)
echo      Port: 8787
echo.
node relay.js
pause
