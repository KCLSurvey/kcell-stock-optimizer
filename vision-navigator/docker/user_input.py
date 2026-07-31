#!/usr/bin/env python3
"""
user_input.py — надёжный ввод длинных ответов.

Проблема, которую решает этот модуль:
обычный input() читает ОДНУ строку — до первого перевода строки. Если человек
вставляет ответ из нескольких абзацев, всё после первого абзаца молча
теряется. Плюс у консоли Windows есть свои ограничения на длину вставки.

Решение: для длинных ответов открываем обычный Блокнот. Человек пишет или
вставляет туда сколько угодно текста, сохраняет (Ctrl+S), закрывает окно —
программа сама читает файл. Ограничений по длине нет, абзацы сохраняются.
"""

import os
import sys
import subprocess
import tempfile

IS_WIN = sys.platform.startswith("win")


def open_in_editor(path):
    """Открывает файл в обычном текстовом редакторе и ЖДЁТ, пока его закроют."""
    try:
        if IS_WIN:
            # notepad блокирует выполнение, пока окно не закроют — это то, что нужно
            subprocess.run(["notepad.exe", path])
            return True
        for editor in (os.environ.get("EDITOR"), "nano", "vi"):
            if editor and _which(editor):
                subprocess.run([editor, path])
                return True
        if sys.platform == "darwin":
            subprocess.run(["open", "-W", "-e", path])
            return True
    except Exception:
        pass
    return False


def _which(name):
    import shutil
    return shutil.which(name)


def drain_stdin():
    """
    Выбрасывает всё, что осталось непрочитанным во входном буфере.

    Зачем: если человек вставил длинный многострочный текст в ответ на вопрос,
    первая строка уходит в ответ, а ВСЁ ОСТАЛЬНОЕ остаётся в буфере — и потом
    молча съедается следующим вопросом. Реальный случай: из 8048 знаков 1815
    ушло в ответ, а 6231 попал туда, где программа ждала ответ модели с сайта.
    Поэтому после чтения ответа буфер надо чистить.
    """
    try:
        if IS_WIN:
            import msvcrt
            while msvcrt.kbhit():
                msvcrt.getwch()
        else:
            import termios
            termios.tcflush(sys.stdin, termios.TCIFLUSH)
    except Exception:
        pass


def _peek_leftover():
    """
    Проверяет, осталось ли что-то непрочитанное во входном буфере.

    Только для настоящего терминала: если ввод идёт из файла или конвейера
    (автотесты, скрипты), там ВСЕГДА есть непрочитанные данные, и без этой
    проверки каждый ответ ошибочно считался бы обрезанным.
    """
    try:
        if not sys.stdin.isatty():
            return False
        if IS_WIN:
            import msvcrt
            return msvcrt.kbhit()
        import select
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        return bool(ready)
    except Exception:
        return False


def read_long_answer(prompt, work_dir, filename="ОТВЕТ.txt"):
    """
    Читает ответ пользователя. Короткий — прямо в окне. Длинный — через Блокнот.

    Возвращает строку (может быть многострочной) или "exit".
    """
    print(prompt)
    print()
    print("  Короткий ответ — пиши прямо здесь и нажми Enter.")
    print("  Длинный ответ или несколько абзацев — набери  файл  и нажми Enter,")
    print("  откроется Блокнот, пиши сколько нужно, сохрани (Ctrl+S) и закрой.")
    print()

    try:
        first = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        return "exit"

    if first.lower() in ("exit", "quit", "выход"):
        return "exit"

    if first.lower() not in ("файл", "file", "ф"):
        # Если во входном буфере осталось ещё что-то — значит человек вставил
        # многострочный текст и мы прочитали только первую строку. Раньше
        # остаток молча утекал в следующий вопрос. Теперь честно об этом
        # говорим и предлагаем переделать через Блокнот.
        leftover = _peek_leftover()
        if leftover:
            drain_stdin()
            print()
            print("!" * 62)
            print("  ВНИМАНИЕ: похоже, ты вставил текст из нескольких абзацев.")
            print(f"  Принята только первая строка ({len(first)} знаков),")
            print("  остальное отброшено — иначе оно попало бы не туда.")
            print()
            print("  Набери  файл  и нажми Enter — тогда откроется Блокнот,")
            print("  и можно вставить весь текст целиком, без потерь.")
            print("!" * 62)
            print()
            return ""
        return first

    # --- режим Блокнота ---
    os.makedirs(work_dir, exist_ok=True)
    path = os.path.join(work_dir, filename)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write("")

    print()
    print("Открываю Блокнот...")
    print("Напиши ответ, потом СОХРАНИ (Ctrl+S) и ЗАКРОЙ окно Блокнота.")
    print("Программа продолжится сама, как только закроешь.")
    print()

    if not open_in_editor(path):
        print("Не удалось открыть редактор автоматически.")
        print(f"Открой этот файл сам, напиши в нём ответ, сохрани и закрой:")
        print(f"   {path}")
        input("Потом вернись сюда и нажми Enter...")

    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
    except Exception as e:
        print(f"Не удалось прочитать файл: {e}")
        return ""

    if not text:
        print("Файл пустой — ответ не записан. Попробуй ещё раз.")
        return ""

    # очищаем на следующий раз, чтобы старый текст не смешался с новым
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write("")
    except Exception:
        pass

    print(f"Принято, {len(text)} знаков.")
    return text


def read_pasted_block(work_dir, filename="ОТВЕТ-МОДЕЛИ.txt"):
    """
    Читает ответ модели, скопированный с сайта. Тот же приём: если текст
    длинный, надёжнее вставить его в Блокнот, чем в окно консоли.
    """
    print("  Вставь ответ прямо сюда (Ctrl+V или правая кнопка мыши),")
    print("  затем на ОТДЕЛЬНОЙ последней строке набери точку  .  и нажми Enter.")
    print()
    print("  Если ответ длинный и вставляется не полностью — набери  файл  и Enter,")
    print("  откроется Блокнот: вставь туда, сохрани (Ctrl+S) и закрой окно.")
    print()

    lines = []
    while True:
        try:
            line = input()
        except (EOFError, KeyboardInterrupt):
            break

        if line.strip() == ".":
            break

        if line.strip().lower() in ("файл", "file", "ф") and not lines:
            os.makedirs(work_dir, exist_ok=True)
            path = os.path.join(work_dir, filename)
            with open(path, "w", encoding="utf-8") as f:
                f.write("")
            print()
            print("Открываю Блокнот. Вставь туда ответ, сохрани (Ctrl+S) и закрой.")
            print()
            if not open_in_editor(path):
                print(f"Открой файл сам: {path}")
                input("Потом нажми Enter...")
            try:
                with open(path, encoding="utf-8") as f:
                    text = f.read().strip()
                print(f"Принято, {len(text)} знаков.")
                return text
            except Exception as e:
                print(f"Не удалось прочитать: {e}")
                return ""

        lines.append(line)

    return "\n".join(lines)


def write_request_file(work_dir, text, filename="ЗАПРОС.txt"):
    """
    Всегда сохраняем текст запроса в файл — на случай, если буфер обмена
    не сработал. Человек может открыть файл Блокнотом и скопировать оттуда.
    Возвращает путь к файлу.
    """
    try:
        os.makedirs(work_dir, exist_ok=True)
        path = os.path.join(work_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path
    except Exception:
        return None
