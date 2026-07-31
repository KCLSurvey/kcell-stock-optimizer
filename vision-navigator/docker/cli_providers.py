#!/usr/bin/env python3
"""
cli_providers.py — доступ к моделям через ПОДПИСКУ, а не через API-ключ.

С начала 2026 года у Claude Code и Codex CLI есть НАТИВНЫЕ установщики:
один исполняемый файл, без Node.js, без npm, без прав администратора —
ставится прямо в папку пользователя. Gemini CLI (который требовал npm)
Google прекратил для обычных аккаунтов в июне 2026 и заменил на
Antigravity CLI (agy) — тоже нативный, без Node.js.

    claude   ->  claude -p --output-format json     (подписка Claude Pro/Max)
    codex    ->  codex exec                          (подписка ChatGPT Plus/Pro)
    agy      ->  agy -p                               (аккаунт Google)

Установка — одна команда PowerShell/curl, без Node.js:
    Claude:       irm https://claude.ai/install.ps1 | iex
    Codex:        irm https://chatgpt.com/codex/install.ps1 | iex
    Antigravity:  irm https://antigravity.google/cli/install.ps1 | iex

Авторизация делается ОДИН РАЗ и вручную, в обычном интерактивном режиме
(откроется браузер, входишь своим аккаунтом) — командой без аргументов:
claude / codex login / agy. После этого токен лежит на диске.

Честные оговорки:
- У подписок есть лимиты обращений. Совет из 7 ролей — это 13 вызовов за
  прогон. Роль, упёршаяся в лимит, помечается ошибкой, остальные продолжают.
- Личное использование в своих целях — для этого подписки и существуют.
- Ответ от CLI иногда приходит с лишним текстом вокруг JSON, поэтому ниже
  есть устойчивое извлечение JSON-объекта из шума.
"""

import os
import re
import sys
import json
import shutil
import subprocess
from pathlib import Path

TIMEOUT = int(os.environ.get("CLI_TIMEOUT", "300"))
IS_WIN = sys.platform.startswith("win")


class CLINotFound(RuntimeError):
    pass


class NotLoggedIn(RuntimeError):
    """Программа установлена, но вход в аккаунт не выполнен."""
    pass


def _candidate_dirs():
    """
    Места, куда нативные установщики реально кладут бинарники, помимо PATH.
    После установки Windows видит новые пути только в НОВЫХ окнах терминала,
    поэтому ищем и напрямую по известным путям каждого инструмента.
    """
    home = Path.home()
    dirs = [
        home / ".local" / "bin",                      # claude, codex, agy — Unix и общий паттерн
        Path("/usr/local/bin"),
        Path("/opt/homebrew/bin"),
    ]
    localapp = os.environ.get("LOCALAPPDATA")
    if localapp:
        dirs += [
            Path(localapp) / "Programs" / "OpenAI" / "Codex" / "bin",  # codex, Windows
            Path(localapp) / "agy" / "bin",                             # antigravity, Windows (вариант 1)
            Path(localapp) / "Antigravity",                             # antigravity, Windows (вариант 2)
            Path(localapp) / "Claude",                                  # claude, Windows (запасной путь)
        ]
    return [d for d in dirs if d.exists()]


def which(binary):
    """Ищет программу в PATH, а если там нет — в местах, куда её кладут нативные установщики."""
    for suffix in ("", ".exe", ".cmd", ".bat"):
        found = shutil.which(binary + suffix)
        if found:
            return found
    for d in _candidate_dirs():
        for suffix in ("", ".exe", ".cmd", ".bat"):
            p = d / (binary + suffix)
            if p.exists():
                return str(p)
    return None


def available():
    """Какие CLI реально установлены на этой машине (claude / codex / agy)."""
    return {name: which(name) for name in ("claude", "codex", "agy")}


AUTH_MARKERS = (
    "not logged in", "please run /login", "authentication required",
    "not authenticated", "please sign in", "unauthorized", "invalid api key",
)
LOGIN_HINT = {"claude": "claude", "codex": "codex login", "agy": "agy"}


def _raise_if_unauthorized(output, binary_name):
    low = (output or "").lower()
    if not any(m in low for m in AUTH_MARKERS):
        return
    hint = LOGIN_HINT.get(binary_name, binary_name)
    raise NotLoggedIn(
        f"Программа «{binary_name}» установлена, но вход в аккаунт не выполнен.\n"
        f"Набери в терминале:  {hint}\n"
        f"войди своей обычной почтой, затем запусти программу снова."
    )


def _run(cmd, stdin_text=None):
    try:
        # input="" вместо None принципиально: без явного stdin CLI ждёт данные
        # из потока по несколько секунд на КАЖДОМ вызове. Проверено на живом
        # claude 2.1.220: без этого 0.74 с превращались в 3+ с на вызов.
        res = subprocess.run(
            cmd,
            input=stdin_text if stdin_text is not None else "",
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError:
        raise CLINotFound(f"Программа не найдена: {cmd[0]}")
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{cmd[0]}: превышено время ожидания {TIMEOUT} с")

    binary_name = Path(cmd[0]).stem.split(".")[0]

    if res.returncode != 0:
        err = (res.stderr or res.stdout or "").strip()
        # Проверяем авторизацию ДО общей ошибки: при невыполненном входе CLI
        # часто выходит с кодом 1 и печатает служебный JSON — без этой ветки
        # пользователь увидел бы простыню технических полей вместо причины.
        _raise_if_unauthorized(err, binary_name)
        raise RuntimeError(f"{cmd[0]} завершился с ошибкой {res.returncode}: {err[:400]}")

    _raise_if_unauthorized(res.stdout, binary_name)
    return res.stdout


# Допустимые значения поля action. Нужны, чтобы отличить НАСТОЯЩИЙ ответ
# модели от ПРИМЕРА СХЕМЫ из AGENTS.md, который тоже является валидным JSON.
# В примере схемы стоит "ask_followup | complete_stage | revisit" — строка с
# перечислением через палку, а не одно конкретное значение. Реальный баг:
# разборщик брал первый попавшийся объект, подхватывал схему, и в качестве
# вопроса человеку показывался текст "следующий вопрос или null".
_VALID_ACTIONS = {"ask_followup", "complete_stage", "revisit"}


def _iter_json_objects(text):
    """Находит ВСЕ сбалансированные JSON-объекты в тексте, по порядку."""
    depth = 0
    start = None
    in_str = False
    escape = False
    for i, ch in enumerate(text):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start is not None:
                    yield text[start:i + 1]


def _looks_like_schema(obj):
    """Признак примера схемы, а не настоящего ответа."""
    action = obj.get("action")
    if isinstance(action, str) and "|" in action:
        return True
    for key in ("next_question", "stage_summary", "conflict_note"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip().endswith("или null"):
            return True
    return False


def _extract_json_object(text):
    """
    Достаёт настоящий ответ модели из шумного текста.

    Берём НЕ первый попавшийся объект: сначала пробуем те, что внутри
    markdown-ограждения (модель обычно кладёт ответ именно туда), затем все
    остальные — и среди них выбираем ПОСЛЕДНИЙ, который похож на настоящий
    ответ, а не на пример схемы.
    """
    if not text:
        raise ValueError("пустой ответ")

    candidates = []
    for fenced in re.findall(r"```(?:json)?\s*(.+?)```", text, re.S):
        candidates.extend(_iter_json_objects(fenced))
    candidates.extend(_iter_json_objects(text))

    good = []
    fallback = None
    for raw in candidates:
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        if fallback is None:
            fallback = raw
        if _looks_like_schema(obj):
            continue
        if obj.get("action") in _VALID_ACTIONS or "final_vision" in obj or "verdict" in obj:
            good.append(raw)

    if good:
        return good[-1]
    if fallback:
        return fallback
    raise ValueError("JSON-объект в ответе не найден")


# ---------------------------------------------------------------- провайдеры

def call_claude_cli(system_prompt, user_message, model=None):
    exe = which("claude")
    if not exe:
        raise CLINotFound("Не найдена программа «claude». См. INSTRUCTIONS.md.")
    cmd = [exe, "-p", "--output-format", "json", "--bare",
           "--append-system-prompt", system_prompt]
    if model:
        cmd += ["--model", model]
    cmd.append(user_message)
    out = _run(cmd)
    try:
        payload = json.loads(out)
        result = payload.get("result") or payload.get("text") or out
        if payload.get("is_error") or "not logged in" in str(result).lower():
            raise NotLoggedIn("Claude Code не авторизован. Набери в терминале `claude` и войди в аккаунт.")
        return result
    except json.JSONDecodeError:
        return out


def call_codex_cli(system_prompt, user_message, model=None):
    exe = which("codex")
    if not exe:
        raise CLINotFound("Не найдена программа «codex». См. INSTRUCTIONS.md.")
    cmd = [exe, "exec"]
    if model:
        cmd += ["--model", model]
    cmd.append(f"{system_prompt}\n\n---\n\n{user_message}")
    return _run(cmd)


def call_agy_cli(system_prompt, user_message, model=None):
    """Antigravity CLI (agy) — замена Gemini CLI с июня 2026, нативный Go-бинарник."""
    exe = which("agy")
    if not exe:
        raise CLINotFound("Не найдена программа «agy». См. INSTRUCTIONS.md.")
    cmd = [exe]
    if model:
        cmd += ["-m", model]
    cmd += ["-p", f"{system_prompt}\n\n---\n\n{user_message}"]
    return _run(cmd)


# ------------------------------------------------------------- режим браузера
#
# Ни один CLI не нужен вообще. Работает через обычный сайт claude.ai /
# chatgpt.com / antigravity.google в браузере, где человек уже вошёл.
# Программа копирует запрос в буфер обмена, человек вставляет его в чат
# сайта и копирует ответ обратно. Медленнее, зато работает буквально везде.

def _copy_to_clipboard(text):
    """
    Кладёт текст в буфер обмена.

    ВАЖНО: раньше здесь был tkinter — и это не работало на Windows. Буфер
    обмена в Windows принадлежит той программе, которая его заполнила: как
    только процесс Python завершался, содержимое пропадало, и пользователь
    получал пустой буфер. Поэтому на Windows используем встроенный
    Set-Clipboard из PowerShell — он кладёт текст в систему по-настоящему,
    независимо от жизни нашего процесса. Через временный файл в UTF-8,
    иначе кириллица превращается в мусор.
    """
    if IS_WIN:
        tmp = None
        try:
            import tempfile
            with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                             encoding="utf-8") as f:
                f.write(text)
                tmp = f.name
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"Get-Content -LiteralPath '{tmp}' -Raw -Encoding UTF8 | Set-Clipboard"],
                capture_output=True, timeout=30)
            return res.returncode == 0
        except Exception:
            return False
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except Exception:
                    pass

    # macOS / Linux
    for cmd in (["pbcopy"], ["xclip", "-selection", "clipboard"], ["wl-copy"]):
        if shutil.which(cmd[0]):
            try:
                subprocess.run(cmd, input=text, text=True, timeout=30,
                               encoding="utf-8")
                return True
            except Exception:
                continue
    return False


def call_browser(system_prompt, user_message, model=None):
    import user_input as ui

    full_text = f"{system_prompt}\n\n---\n\n{user_message}"
    copied = _copy_to_clipboard(full_text)

    # Запрос ВСЕГДА сохраняется в файл, даже если буфер сработал. Это запасной
    # путь: если в буфере почему-то пусто, человек просто открывает файл
    # Блокнотом и копирует оттуда, вместо того чтобы выделять мышкой простыню
    # текста в окне консоли.
    work_dir = os.environ.get("_VISION_TASK_DIR_ABS") or os.getcwd()
    req_path = ui.write_request_file(work_dir, full_text)

    print()
    print("=" * 62)
    if copied:
        print("  Текст запроса СКОПИРОВАН В БУФЕР — можно сразу вставлять (Ctrl+V)")
    else:
        print("  Скопировать автоматически не вышло — но текст сохранён в файл.")
    if req_path:
        print(f"  Файл с запросом: {req_path}")
        print("  (открой его Блокнотом и скопируй оттуда, если в буфере пусто)")
    print("=" * 62)
    print("Дальше:")
    print("  1. Открой в браузере claude.ai (или chatgpt.com)")
    print("  2. Вставь текст (Ctrl+V) в чат и отправь")
    print("  3. Выдели ПОЛНОСТЬЮ ответ модели и скопируй (Ctrl+C)")
    print("  4. Вернись сюда и вставь его")
    print()

    return ui.read_pasted_block(work_dir)


CLI_DISPATCH = {
    "claude-cli": call_claude_cli,
    "codex-cli": call_codex_cli,
    "antigravity-cli": call_agy_cli,
    "browser": call_browser,
}

BINARY_OF = {"claude-cli": "claude", "codex-cli": "codex", "antigravity-cli": "agy"}


def is_cli_provider(provider):
    return provider in CLI_DISPATCH


def call_cli(provider, system_prompt, user_message, model=None):
    fn = CLI_DISPATCH[provider]
    return fn(system_prompt, user_message, model)


# --------------------------------------------------------- нативная установка
#
# Одна команда, без Node.js, без прав администратора. Ставит бинарник прямо
# в папку пользователя.

NATIVE_INSTALL = {
    "claude": {
        "win": ["powershell", "-ExecutionPolicy", "ByPass", "-Command",
                "irm https://claude.ai/install.ps1 | iex"],
        "unix": ["bash", "-c",
                 "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"],
        "login": ["claude"],
        "label": "Claude Code",
    },
    "codex": {
        "win": ["powershell", "-ExecutionPolicy", "ByPass", "-Command",
                "irm https://chatgpt.com/codex/install.ps1 | iex"],
        "unix": ["bash", "-c",
                 "set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
        "login": ["codex", "login"],
        "label": "Codex",
    },
    "agy": {
        "win": ["powershell", "-ExecutionPolicy", "ByPass", "-Command",
                "irm https://antigravity.google/cli/install.ps1 | iex"],
        "unix": ["bash", "-c",
                 "set -o pipefail; curl -fsSL https://antigravity.google/cli/install.sh | bash"],
        "login": ["agy"],
        "label": "Antigravity CLI",
    },
}


def install_native(binary, is_windows, proxy=None):
    """
    Запускает официальный однострочный установщик. Возвращает (успех, вывод).

    proxy: например "http://proxy.company.local:8080" — если корпоративная
    сеть требует прокси (см. check-proxy.py), передаётся через переменные
    окружения HTTPS_PROXY/HTTP_PROXY дочернему процессу.

    ВАЖНО: код завершения `curl ... | bash` — это код завершения bash, а не
    curl. Если сеть недоступна или сервер вернул ошибку, curl молча выдаёт
    пустой вывод, bash выполняет "ничего" и всё равно завершается кодом 0 —
    то есть returncode==0 сам по себе НЕ доказывает успех (поймано на
    реальном запуске: сеть песочницы вернула 403, а код был 0). Поэтому
    единственная надёжная проверка — действительно ли бинарник появился.
    """
    spec = NATIVE_INSTALL[binary]
    cmd = spec["win"] if is_windows else spec["unix"]

    env = os.environ.copy()
    if proxy:
        env["HTTPS_PROXY"] = proxy
        env["HTTP_PROXY"] = proxy
        env["https_proxy"] = proxy
        env["http_proxy"] = proxy

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=180,
                             encoding="utf-8", errors="replace", env=env)
        output = (res.stdout or "") + (res.stderr or "")
    except FileNotFoundError:
        return False, f"Не найдена программа {cmd[0]} (PowerShell/bash)."
    except subprocess.TimeoutExpired:
        return False, "Превышено время ожидания установки."

    really_installed = which(binary) is not None
    if not really_installed:
        note = ("\n\n(Команда завершилась без явной ошибки, но программа так и не "
                "появилась — вероятно, не было сети до сайта установщика.)"
                if res.returncode == 0 else "")
        return False, output + note
    return True, output
