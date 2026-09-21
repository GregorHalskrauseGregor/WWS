@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WWS Agent
:schleife
echo.
echo [%date% %time%] Agent startet...
node --env-file=.env agent.js
echo [%date% %time%] Agent beendet (Code %errorlevel%). Neustart in 5 s...
timeout /t 5 >nul
goto schleife
