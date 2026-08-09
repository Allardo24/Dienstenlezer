@echo off
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"

echo DienstenLezer-build wordt gecontroleerd...
call npm run deploy:build
if errorlevel 1 (
  echo.
  echo De build is mislukt. Bekijk de melding hierboven.
  pause
  exit /b 1
)

:start
netstat -ano | findstr /R /C:":8080 .*LISTENING" >nul
if not errorlevel 1 (
  echo.
  echo Poort 8080 is al in gebruik. Sluit eerst een eerder DienstenLezer-venster.
  echo Er draait waarschijnlijk al een werkende DienstenLezer-server.
  pause
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
echo.
echo DienstenLezer-server is gestopt. Bekijk een eventuele foutmelding hierboven.
pause
