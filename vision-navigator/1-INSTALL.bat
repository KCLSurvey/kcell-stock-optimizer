@echo off
chcp 65001 >nul 2>&1
title Ustanovka
cd /d "%~dp0"

set PY=
where python >nul 2>&1 && set PY=python
if "%PY%"=="" (where py >nul 2>&1 && set PY=py)

if "%PY%"=="" (
    echo.
    echo   Python ne nayden. Probuyu ustanovit avtomaticheski...
    echo.
    where winget >nul 2>&1
    if errorlevel 1 goto NOWINGET
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent
    echo.
    echo   ==================================================
    echo     Python ustanovlen.
    echo     ZAKROY eto okno i zapusti USTANOVKA snova.
    echo   ==================================================
    echo.
    pause
    exit /b 0
    :NOWINGET
    echo   Otkryvayu sayt python.org
    echo   Skachay i ustanovi Python, potom zapusti USTANOVKA snova.
    echo   VAZHNO: postav galochku "Add Python to PATH"
    start https://www.python.org/downloads/
    pause
    exit /b 1
)

%PY% ustanovka.py
echo.
pause
