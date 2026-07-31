@echo off
chcp 65001 >nul 2>&1
title Navigator videniya
cd /d "%~dp0"

set PY=
where python >nul 2>&1 && set PY=python
if "%PY%"=="" (where py >nul 2>&1 && set PY=py)

if "%PY%"=="" (
    echo   Python ne nayden. Zapusti snachala fayl USTANOVKA
    pause
    exit /b 1
)

%PY% start.py
echo.
pause
