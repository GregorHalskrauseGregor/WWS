@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WWS Browser-Dienst
:schleife
echo.
echo [%date% %time%] Browser-Dienst startet...
node --env-file=.env server.js
echo [%date% %time%] Browser-Dienst beendet (Code %errorlevel%). Neustart in 5 s...
timeout /t 5 >nul
goto schleife
