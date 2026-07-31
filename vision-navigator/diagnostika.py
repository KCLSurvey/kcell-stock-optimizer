#!/usr/bin/env python3
"""
diagnostika.py — разбирается, почему программа не видит нужные части.

Запуск: двойной клик по DIAGNOSTICS.bat (или python diagnostika.py)
Ничего не устанавливает и не меняет. Только смотрит и объясняет.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "docker"))

OK = "[ЕСТЬ]"
NO = "[НЕТ] "


def main():
    print("=" * 62)
    print("  DIAGNOSTICS")
    print("=" * 62)
    print()
    print(f"Система:  {sys.platform}")
    print(f"Python:   {sys.version.split()[0]}  ({sys.executable})")
    print()

    try:
        import cli_providers as cp
    except Exception as e:
        print(f"[!] Не удалось загрузить docker/cli_providers.py: {e}")
        print("    Похоже, папка распакована неполностью.")
        return

    print("-" * 62)
    print("ТЕРМИНАЛЬНЫЕ ВЕРСИИ МОДЕЛЕЙ")
    print("-" * 62)
    print()
    print("(Node.js не нужен — все три ставятся одним файлом, без него.)")
    print()

    tools = {
        "claude": "Claude Code (подписка Claude Pro/Max)",
        "codex": "Codex (подписка ChatGPT Plus/Pro)",
        "agy": "Antigravity CLI (аккаунт Google, бесплатно)",
    }
    found_any = False
    for binary, label in tools.items():
        path = cp.which(binary)
        print(f"{OK if path else NO} {binary:8} {label}")
        if path:
            found_any = True
            print(f"       {path}")
        print()

    print("=" * 62)
    print("  ЧТО ДЕЛАТЬ")
    print("=" * 62)
    print()

    if not found_any:
        print("НИЧЕГО НЕ НАЙДЕНО.")
        print()
        print("Самый простой способ — щёлкни два раза по файлу 1-INSTALL.bat,")
        print("она поставит нужный инструмент сама, без прав администратора.")
        print()
        print("ВАЖНО: приложения Claude и ChatGPT с окном и кнопками — это")
        print("другое. Нужны их отдельные терминальные версии.")
        print()
        print("Если хочешь установить руками, открой обычный (НЕ от имени")
        print("администратора) PowerShell и набери одну из команд:")
        print()
        print("  Claude Pro/Max:      irm https://claude.ai/install.ps1 | iex")
        print("  ChatGPT Plus/Pro:    irm https://chatgpt.com/codex/install.ps1 | iex")
        print("  Google (бесплатно):  irm https://antigravity.google/cli/install.ps1 | iex")
        print()
        print("Если ни одна команда не проходит — вероятно, корпоративный")
        print("firewall блокирует установку. Тогда используй режим «Через")
        print("браузер» в меню программы — он вообще ничего не устанавливает.")
        print()
        return

    print("ЕСТЬ ХОТЯ БЫ ОДИН ИНСТРУМЕНТ. Можно запускать программу (2-START.bat)")
    print("и выбрать его в меню.")
    print()
    print("Если она всё равно ругается на вход в аккаунт — набери команду")
    print("входа и войди своей обычной почтой:")
    print()
    print("  claude       (для Claude)")
    print("  codex login  (для ChatGPT)")
    print("  agy          (для Google)")
    print()


if __name__ == "__main__":
    main()
