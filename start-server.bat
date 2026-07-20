@echo off
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"

if exist "dist\index.html" if exist "src-tauri\target\release\dienstenlezer-server.exe" goto start

echo DienstenLezer wordt eenmalig gebouwd...
call npm run deploy:build
if errorlevel 1 exit /b 1

:start
netstat -ano | findstr /R /C:":8080 .*LISTENING" >nul
if not errorlevel 1 (
  echo Poort 8080 is al in gebruik. Sluit eerst een eerder DienstenLezer-venster.
  exit /b 1
)

set "DIENSTENLEZER_BIND=0.0.0.0:8080"
set "DIENSTENLEZER_DATA_DIR=%CD%\server-data"
set "DIENSTENLEZER_WEB_DIR=%CD%\dist"
echo.
echo DienstenLezer is bereikbaar op http://localhost:8080
echo Sluit dit venster om de server uit te zetten.
echo.
"%CD%\src-tauri\target\release\dienstenlezer-server.exe"
