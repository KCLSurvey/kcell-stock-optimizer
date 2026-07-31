@echo off
chcp 65001 >nul 2>&1
title Diagnostika
cd /d "%~dp0"

set PY=
where python >nul 2>&1 && set PY=python
if "%PY%"=="" (where py >nul 2>&1 && set PY=py)

if "%PY%"=="" (
    echo   Python ne ustanovlen. Zapusti fayl USTANOVKA
    pause
    exit /b 1
)

%PY% diagnostika.py
echo.
pause
