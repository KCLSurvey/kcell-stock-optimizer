#!/usr/bin/env python3
"""
check-proxy.py — проверяет, не в прокси ли дело.

Windows хранит адрес корпоративного прокси в реестре (та же настройка,
которую использует браузер). Этот скрипт читает её и пробует подключиться
к claude.ai и через неё, и напрямую — чтобы понять, где именно затор.

Результат ОДНОВРЕМЕННО показывается на экране и сохраняется в файл
proxy-check-result.txt рядом с этим скриптом — если окно консоли
закроется раньше, чем ты успеешь прочитать, результат никуда не денется.
"""
import os
import sys
import urllib.request
import urllib.error

# Всё, что обычно печаталось через print(), теперь идёт и на экран, и в файл.
_log_lines = []


def log(text=""):
    print(text)
    _log_lines.append(str(text))


def save_log():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "proxy-check-result.txt")
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(_log_lines))
        print()
        print(f"(Этот же результат сохранён в файл: {path})")
    except Exception as e:
        print(f"(Не удалось сохранить в файл: {e})")


def read_windows_proxy():
    if not sys.platform.startswith("win"):
        return None
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
        if not enabled:
            return None
        server, _ = winreg.QueryValueEx(key, "ProxyServer")
        return server
    except Exception:
        return None


def try_connect(url, proxy=None):
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    try:
        opener.open(url, timeout=8)
        return True, "OK"
    except urllib.error.HTTPError as e:
        return True, f"HTTP {e.code} (сервер ответил — сеть работает)"
    except Exception as e:
        return False, str(e)


def main():
    log("=" * 60)
    log("  ПРОВЕРКА ПРОКСИ")
    log("=" * 60)
    log()

    proxy = read_windows_proxy()
    log(f"Прокси в настройках Windows: {proxy or '(не настроен / не Windows)'}")
    log()

    log("Пробую claude.ai НАПРЯМУЮ (как это делал установщик)...")
    ok, msg = try_connect("https://claude.ai", proxy=None)
    log(f"  {'ПОЛУЧИЛОСЬ' if ok else 'НЕ ПОЛУЧИЛОСЬ'}: {msg}")
    log()

    if proxy:
        log(f"Пробую claude.ai ЧЕРЕЗ ПРОКСИ ({proxy})...")
        ok2, msg2 = try_connect("https://claude.ai", proxy=f"http://{proxy}")
        log(f"  {'ПОЛУЧИЛОСЬ' if ok2 else 'НЕ ПОЛУЧИЛОСЬ'}: {msg2}")
        log()
        if ok2 and not ok:
            log("=" * 60)
            log("  НАЙДЕНО: дело именно в прокси!")
            log("=" * 60)
            log()
            log("Открой PowerShell (обычный, не от администратора) и набери:")
            log()
            log(f'  $env:HTTPS_PROXY = "http://{proxy}"')
            log(f'  irm https://claude.ai/install.ps1 | iex')
            log()
            log("Если сработает — установка пройдёт через тот же прокси, что")
            log("использует браузер, и дальше программа тоже будет работать.")
            return

    if not ok:
        log("Похоже, дело не в прокси (или прокси не настроен в Windows —")
        log("возможно, он задан на уровне сети/роутера, а не в настройках")
        log("аккаунта). В таком случае надёжный путь — режим \"Через браузер\"")
        log("в 2-START.bat (пункт 0 в меню). Он использует ровно то же")
        log("подключение, что и обычный браузер, без исключений.")
    else:
        log("Прямое подключение к claude.ai РАБОТАЕТ без всякого прокси.")
        log("Значит дело не в сети как таковой — возможно, заблокирован")
        log("именно конкретный поддомен установщика. Попробуй установку")
        log("ещё раз (1-INSTALL.bat) — если снова ECONNREFUSED именно на")
        log("install.ps1, покажи мне этот файл и точный текст ошибки.")


if __name__ == "__main__":
    main()
    save_log()
    print()
    try:
        input("Нажми Enter, чтобы закрыть это окно...")
    except EOFError:
        pass
