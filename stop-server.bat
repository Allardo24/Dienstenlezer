@echo off
setlocal
set "FOUND="

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8080 .*LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
  set "FOUND=1"
)

if defined FOUND (
  echo DienstenLezer-server is gestopt.
) else (
  echo DienstenLezer-server draaide niet.
)
