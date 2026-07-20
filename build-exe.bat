@echo off
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
npm run desktop:build
