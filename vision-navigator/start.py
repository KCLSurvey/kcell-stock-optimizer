#!/usr/bin/env python3
"""
start.py — простой запуск без Docker и без переменных окружения.

    python3 start.py

Спрашивает провайдера и ключ один раз, сохраняет в config.json рядом с собой
(этот файл в .gitignore — в репозиторий не попадёт), дальше показывает меню.

Работает везде, где есть Python 3.8+: Windows, macOS, Linux, Android (Termux),
iOS (a-Shell). Никаких зависимостей — только стандартная библиотека.
"""

import os
import sys
import json

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(ROOT, "config.json")
sys.path.insert(0, os.path.join(ROOT, "docker"))
IS_WIN = sys.platform.startswith("win")

# Режим подписки — ключ не нужен, используется уже установленный CLI.
# Все три — нативные бинарники, БЕЗ Node.js и без прав администратора.
SUB_PROVIDERS = {
    "1": ("claude-cli", "Claude — по подписке Claude Pro/Max", "claude"),
    "2": ("codex-cli", "ChatGPT — по подписке Plus/Pro", "codex"),
    "3": ("antigravity-cli", "Google Antigravity — по аккаунту Google", "agy"),
}

# Режим API-ключа — платится отдельно, по токенам.
KEY_PROVIDERS = {
    "5": ("anthropic", "Claude", "ANTHROPIC_API_KEY", "console.anthropic.com"),
    "6": ("openai", "ChatGPT", "OPENAI_API_KEY", "platform.openai.com"),
    "7": ("gemini", "Gemini", "GEMINI_API_KEY", "aistudio.google.com"),
    "8": ("moonshot", "Kimi K3", "MOONSHOT_API_KEY", "platform.moonshot.ai"),
}


def load_config():
    if os.path.exists(CONFIG):
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(cfg):
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def setup():
    sys.path.insert(0, os.path.join(ROOT, "docker"))
    try:
        from cli_providers import available
        installed = available()
    except Exception:
        installed = {}

    print("\nБЕЗ УСТАНОВКИ ВООБЩЕ — работает через сайт в браузере:")
    print("  0. Через браузер (claude.ai / chatgpt.com) — копировать/вставлять руками")
    print("     Медленнее, зато точно работает даже на самом закрытом корп-компьютере.")
    print()
    print("     Если пункты 1-3 уже не устанавливались — набери именно 0.")

    print("\nПО ПОДПИСКЕ, автоматически — ключ не нужен, платить за токены не надо:")
    for k, (_, label, binary) in SUB_PROVIDERS.items():
        mark = "установлен" if installed.get(binary) else "НЕ установлен"
        print(f"  {k}. {label}  [{mark}]")

    print("\nПО API-КЛЮЧУ — оплата отдельно, по количеству слов:")
    for k, (_, label, _, site) in KEY_PROVIDERS.items():
        print(f"  {k}. {label}   (ключ берётся на {site})")

    choice = input("\nНомер: ").strip()

    if choice == "0":
        cfg = {"provider": "browser", "mode": "browser"}
        save_config(cfg)
        print("\nГотово: работаем через браузер. Ничего ставить не нужно.")
        print("На каждом шаге программа будет говорить, что скопировать и куда вставить.\n")
        return cfg

    if choice in SUB_PROVIDERS:
        provider, label, binary = SUB_PROVIDERS[choice]
        if not installed.get(binary):
            if not install_cli(binary):
                sys.exit(1)
        cfg = {"provider": provider, "mode": "subscription"}
        save_config(cfg)
        print(f"\nГотово: работаем через {label}. Ключ не нужен.\n")
        return cfg

    if choice in KEY_PROVIDERS:
        provider, label, key_env, site = KEY_PROVIDERS[choice]
        print(f"\nВставь API-ключ {label} (сохранится локально в config.json):")
        key = input("Ключ: ").strip()
        if not key:
            print("Пустой ключ — выходим.")
            sys.exit(1)
        cfg = {"provider": provider, "mode": "api", "key_env": key_env, "api_key": key}
        save_config(cfg)
        print("Сохранено. Больше спрашивать не буду.\n")
        return cfg

    print("Нет такого варианта.")
    sys.exit(1)


LOGIN_CMD = {"claude": "claude", "codex": "codex login", "agy": "agy"}


def install_cli(binary):
    """
    Ставит нужный CLI официальным нативным установщиком — одна команда,
    без Node.js, без npm, без прав администратора. Работает для всех трёх:
    Claude Code, Codex и Antigravity CLI (замена Gemini CLI с июня 2026).
    """
    import cli_providers as cp

    print()
    print("=" * 60)
    print(f"  Программа «{binary}» не найдена — ставлю")
    print("=" * 60)
    print()
    print("ВАЖНО, если ты уже ставил приложение Claude или ChatGPT:")
    print("  Приложения с окном и кнопками — это ДРУГОЕ. Нужна их отдельная")
    print("  версия для терминала, без окна. Сейчас поставим именно её.")
    print()

    answer = input("Установить сейчас? [д/н]: ").strip().lower()
    if answer not in ("д", "да", "y", "yes", ""):
        return False

    print("\nУстанавливаю, это займёт минуту. Права администратора не нужны...")
    ok, output = cp.install_native(binary, IS_WIN)
    if not ok:
        print("\nНе получилось установить автоматически:")
        print(output[-500:])
        print()
        print("Попробуй вручную. Открой обычный (не от администратора) терминал")
        print("PowerShell и набери:")
        spec = cp.NATIVE_INSTALL[binary]
        cmd = spec["win"] if IS_WIN else spec["unix"]
        print("  " + " ".join(cmd[2:]) if IS_WIN else "  " + cmd[2])
        return False

    print("Установлено.\n")
    print("=" * 60)
    print("  ОСТАЛСЯ ВХОД В АККАУНТ — делается один раз")
    print("=" * 60)
    print(f"\n  1. Набери в терминале:   {LOGIN_CMD[binary]}")
    print("  2. Откроется браузер — войди своей обычной почтой")
    print("  3. Вернись сюда и запусти программу снова")
    print()
    return False


def pick_task_dir():
    base = os.path.join(ROOT, "IDEAS")
    os.makedirs(base, exist_ok=True)
    existing = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d)))
    if existing:
        print("\nСуществующие идеи:")
        for i, d in enumerate(existing, 1):
            print(f"  {i}. {d}")
        print(f"  {len(existing) + 1}. Создать новую")
        choice = input("\nНомер: ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(existing):
            return os.path.join("IDEAS", existing[int(choice) - 1])
    name = input("Короткое имя новой идеи (например, telecom-assets): ").strip() or "idea"
    path = os.path.join(base, name)
    os.makedirs(path, exist_ok=True)
    return os.path.join("IDEAS", name)


def apply_saved_proxy():
    """Если check-proxy.py/ustanovka.py нашли и сохранили прокси — применяем
    его ко всему процессу, чтобы и сами обращения к модели (не только
    установка) шли через него."""
    proxy_file = os.path.join(ROOT, "proxy.txt")
    if os.path.exists(proxy_file):
        proxy = open(proxy_file, encoding="utf-8").read().strip()
        if proxy:
            for var in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
                os.environ[var] = proxy


def main():
    apply_saved_proxy()
    cfg = load_config()
    if not cfg:
        print("=" * 60)
        print("  Первый запуск — короткая настройка")
        print("=" * 60)
        cfg = setup()

    os.environ["WORKSPACE_PATH"] = ROOT
    os.environ["VISION_MODEL_PROVIDER"] = cfg["provider"]
    if cfg.get("key_env") and cfg.get("api_key"):
        os.environ[cfg["key_env"]] = cfg["api_key"]

    mode = {"subscription": "подписка, без оплаты токенов",
            "browser": "через браузер, копированием"}.get(cfg.get("mode"), "API-ключ")
    print("=" * 60)
    print("  Навигатор видения")
    print("=" * 60)
    print(f"  Модель: {cfg['provider']}  ({mode})")
    print()
    print("  1. Пройти 6 методологий (начать или продолжить)")
    print("  2. Собрать совет из 7 ролей и получить вердикт")
    print("  3. Проверить идею внешними данными (аналитик рынка)")
    print("  4. Спросить у базы знаний")
    print("  5. Проверить базу знаний на противоречия")
    print("  6. Начать текущую идею заново")
    print("  7. Сменить модель")
    print()
    choice = input("Что делаем: ").strip()

    if choice == "7":
        setup()
        print("Запусти скрипт снова.")
        return

    task_dir = pick_task_dir()
    os.environ["VISION_TASK_DIR"] = task_dir
    print(f"\nПапка идеи: {task_dir}\n")

    if choice == "1":
        os.environ["VISION_AGENTS_DIR"] = os.path.join(
            ROOT, "agents_registry", "vision_architect", ".agents")
        import run_vision_architect
        run_vision_architect.main()

    elif choice == "2":
        os.environ["VISION_AGENTS_DIR"] = os.path.join(
            ROOT, "agents_registry", "llm_council", ".agents")
        import run_llm_council
        run_llm_council.main()

    elif choice == "3":
        os.environ["VISION_AGENTS_DIR"] = os.path.join(
            ROOT, "agents_registry", "market_researcher", ".agents")
        import run_market_research
        run_market_research.main()

    elif choice == "4":
        import knowledge
        from model_providers import call_model
        abs_dir = os.path.join(ROOT, task_dir)
        question = input("Что хочешь узнать: ").strip()
        if not question:
            return
        memory = knowledge.recall(abs_dir, question, max_chars=8000)
        if not memory:
            print("\nБаза знаний пока пуста — сначала пройди хотя бы один этап.")
            return
        print("\nДумаю...\n")
        answer = call_model(
            "Ответь на вопрос, опираясь ТОЛЬКО на приведённую базу знаний. "
            "Если ответа в ней нет — так и скажи, не додумывай.\n\n" + memory,
            question)
        print(answer)

    elif choice == "5":
        import knowledge
        from model_providers import call_model
        abs_dir = os.path.join(ROOT, task_dir)
        curator = os.path.join(ROOT, "agents_registry", "wiki_curator", ".agents", "AGENTS.md")
        schema = open(curator, encoding="utf-8").read() if os.path.exists(curator) else ""
        print("\nПроверяю базу знаний...\n")
        try:
            report = knowledge.lint(abs_dir, call_model, schema)
        except Exception as e:
            print(f"Не удалось проверить: {e}")
            return
        if report.get("verdict") == "empty":
            print("База знаний пока пуста.")
            return
        for title, key in (("Противоречия", "contradictions"),
                           ("Устарело", "stale"),
                           ("Страницы-сироты", "orphans"),
                           ("Не хватает связей", "missing_links"),
                           ("Догадки, поданные как факты", "unsupported_claims")):
            items = report.get(key) or []
            if items:
                print(f"{title}:")
                for it in items:
                    print(f"  - {it}")
                print()
        print(f"Вердикт: {report.get('verdict', '?')}")

    elif choice == "6":
        os.environ["VISION_AGENTS_DIR"] = os.path.join(
            ROOT, "agents_registry", "vision_architect", ".agents")
        sys.argv.append("--reset")
        import run_vision_architect
        run_vision_architect.main()

    else:
        print("Нет такого варианта.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nПрервано. Прогресс сохранён — запусти снова, чтобы продолжить.")
    except Exception as e:
        # Ошибку входа показываем как понятную инструкцию, а не как трассировку.
        sys.path.insert(0, os.path.join(ROOT, "docker"))
        try:
            from cli_providers import NotLoggedIn, CLINotFound
            known = (NotLoggedIn, CLINotFound)
        except Exception:
            known = ()
        if known and isinstance(e, known):
            print("\n" + "=" * 60)
            print(e)
            print("=" * 60)
        else:
            raise
