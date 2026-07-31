#!/bin/bash
# Linux / Termux (Android). Запуск:  ./запустить.sh
cd "$(dirname "$0")"

PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

if ! command -v $PY >/dev/null 2>&1; then
    echo "[!] Python не найден."
    echo "Termux:  pkg install python"
    echo "Linux:   sudo apt install python3"
    exit 1
fi

exec $PY start.py
