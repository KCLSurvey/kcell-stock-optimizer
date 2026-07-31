#!/usr/bin/env python3
"""
ustanovka.py — ставит всё необходимое само.

Запускается двойным щелчком по 1-INSTALL.bat (Windows).
Пользователю не нужно ничего набирать руками.

Node.js НЕ используется вообще: Claude Code, Codex и Antigravity CLI
с начала 2026 ставятся официальными "нативными" установщиками — один
исполняемый файл, без npm, без прав администратора.
"""

import os
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "docker"))
IS_WIN = sys.platform.startswith("win")


def say(text=""):
    print(text)
    sys.stdout.flush()


def line(ch="="):
    say(ch * 62)


def main():
    line()
    say("  1-INSTALL (bat)")
    line()
    say()
    say("Эта программа сама поставит нужный терминальный ИИ-инструмент.")
    say("Права администратора не нужны — всё ставится в твою личную папку.")
    say()
    say(f"Python: есть, версия {sys.version.split()[0]}")
    say()

    import cli_providers as cp

    line("-")
    say("Выбери, каким искусственным интеллектом пользоваться.")
    line("-")
    say()

    options = {
        "1": ("claude", "Claude Code", "если платишь за Claude Pro или Max"),
        "2": ("codex", "Codex", "если платишь за ChatGPT Plus или Pro"),
        "3": ("agy", "Antigravity CLI", "бесплатно, нужна только почта Gmail"),
    }
    for k, (binary, label, hint) in options.items():
        mark = "уже установлен" if cp.which(binary) else "будет установлен"
        say(f"  {k}. {label:16} — {hint}   [{mark}]")
    say()

    choice = input("Набери цифру 1, 2 или 3 и нажми Enter: ").strip()
    if choice not in options:
        say("Такого пункта нет. Запусти 1-INSTALL.bat заново.")
        return

    binary, label, _ = options[choice]
    say()

    proxy = None
    proxy_file = os.path.join(ROOT, "proxy.txt")
    if os.path.exists(proxy_file):
        proxy = open(proxy_file, encoding="utf-8").read().strip() or None

    if not cp.which(binary):
        line("-")
        if proxy is None:
            say("Если check-proxy.py показал адрес корпоративного прокси —")
            say("вставь его сейчас (например http://proxy.company.local:8080).")
            say("Если не показал или не запускал — просто нажми Enter.")
            entered = input("Прокси (или Enter, чтобы пропустить): ").strip()
            if entered:
                proxy = entered
                with open(proxy_file, "w", encoding="utf-8") as f:
                    f.write(proxy)
                say(f"Сохранено в proxy.txt — пригодится и при следующих запусках.")
            say()
        say(f"Устанавливаю {label}. Это займёт минуту, жди...")
        say()
        ok, output = cp.install_native(binary, IS_WIN, proxy=proxy)
        if not ok:
            say("Не получилось установить автоматически. Подробности:")
            say(output[-500:])
            say()
            say("Проверь интернет-соединение и попробуй ещё раз.")
            say("Если корпоративный firewall блокирует установку — покажи")
            say("это сообщение тому, кто настраивает сеть.")
            return
        say(f"{label} установлен.")
        say()

    # ---------- вход в аккаунт ----------
    line()
    say("  ОСТАЛСЯ ПОСЛЕДНИЙ ШАГ — ВХОД В АККАУНТ")
    line()
    say()
    say("Сейчас откроется вход в твой аккаунт. Делается один раз.")
    say()
    say("Что произойдёт:")
    say("  - откроется браузер")
    say("  - войди своей обычной почтой, той же, что на сайте")
    say("  - разреши доступ")
    say("  - вернись в это окно")
    say()
    input("Нажми Enter, когда будешь готов...")
    say()

    exe = cp.which(binary)
    login_cmd = cp.NATIVE_INSTALL[binary]["login"]
    cmd = [exe] + login_cmd[1:]
    say("Открываю вход...")
    say()
    time.sleep(1)
    try:
        import subprocess
        subprocess.run(cmd)
    except Exception as e:
        say(f"Не удалось открыть автоматически: {e}")
        say(f"Набери руками:  {' '.join(login_cmd)}")
        return

    say()
    line()
    say("  ГОТОВО")
    line()
    say()
    say("Теперь закрой это окно и запускай программу двойным щелчком")
    say("по файлу  2-START.bat")
    say()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("\nПрервано.")
    except Exception as e:
        say(f"\nНеожиданная ошибка: {e}")
        say("Сделай снимок экрана и покажи тому, кто помогает.")
