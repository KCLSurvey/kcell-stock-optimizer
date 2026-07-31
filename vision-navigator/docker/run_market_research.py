#!/usr/bin/env python3
"""
run_market_research.py — проверка идеи внешними данными.

Пробел, который закрывает: навигатор и совет рассуждают только на материале
самого человека. Если он ошибается в масштабе боли, путает свою частную
ситуацию с отраслевой или не знает о существующем продукте — этого никто
не заметит. Эта роль ходит в веб и возвращается с проверкой.

Запуск: пункт меню в start.py. Читает то же, что и совет
(vision.md -> vision_state.json -> raw_thought.md), результат кладёт в
research/ и вносит в базу знаний.
"""

import os
import sys
import json
import datetime

from model_providers import call_model, parse_model_json  # noqa: E402
import knowledge  # noqa: E402
from run_llm_council import resolve_context, append_timeline  # noqa: E402


def read_optional(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    return ""


def write_report(path, source_label, data):
    lines = [
        "# Проверка идеи внешними данными",
        "",
        f"*Источник материала: {source_label}*",
        f"*Поиск был доступен: {'да' if data.get('search_available') else 'НЕТ — достоверность низкая'}*",
        f"*Уверенность: {data.get('confidence', '?')}*",
        "",
        "## Напутствие",
        "",
        data.get("verdict", ""),
        "",
        "## Боли: отраслевые или частные",
        "",
    ]
    for p in data.get("industry_pains", []):
        mark = "ОТРАСЛЕВАЯ" if p.get("is_industry_wide") else "частная"
        lines.append(f"- **[{mark}]** {p.get('pain', '')}")
        if p.get("evidence"):
            lines.append(f"  - основание: {p['evidence']}")
    lines += ["", "## Существующие решения", ""]
    for pr in data.get("existing_products", []):
        lines.append(f"### {pr.get('name', '?')} ({pr.get('vendor', '?')})")
        lines.append(f"- закрывает: {pr.get('covers', '')}")
        lines.append(f"- НЕ закрывает: {pr.get('gaps', '')}")
        if pr.get("notes"):
            lines.append(f"- заметки: {pr['notes']}")
        lines.append("")
    lines += ["## Незанятое место", ""]
    for w in data.get("whitespace", []):
        lines.append(f"- {w}")
    lines += ["", "## Проверка заявленных цифр", ""]
    for n in data.get("number_checks", []):
        lines.append(f"- «{n.get('claim', '')}» → **{n.get('verdict', '?')}**")
        if n.get("comment"):
            lines.append(f"  - {n['comment']}")
    lines += ["", "---", "**research: done** by Market Researcher"]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    workspace = os.environ.get("WORKSPACE_PATH", "/workspace")
    task_dir = os.path.abspath(os.path.join(workspace, os.environ.get("VISION_TASK_DIR", ".")))
    agents_dir = os.environ.get("VISION_AGENTS_DIR") or os.path.join(workspace, ".agents")
    logs_dir = os.path.join(task_dir, "logs")
    research_dir = os.path.join(task_dir, "research")
    os.makedirs(logs_dir, exist_ok=True)
    os.makedirs(research_dir, exist_ok=True)

    os.environ["_VISION_TASK_DIR_ABS"] = task_dir
    timeline_file = os.path.join(logs_dir, "V5_research_timeline.json")

    agents_md = read_optional(os.path.join(agents_dir, "AGENTS.md"))
    if not agents_md:
        print("[Аналитик] Не найден AGENTS.md роли. Проверь agents_registry/market_researcher/.agents/")
        sys.exit(1)

    source_label, idea_text = resolve_context(task_dir)
    print(f"[Аналитик] Источник материала: {source_label}")
    print("[Аналитик] Готовлю запрос на проверку внешними данными...\n")

    append_timeline(timeline_file, "RESEARCH_STARTED", source_label)

    memory = knowledge.recall(task_dir, "боли отрасли существующие продукты конкуренты рынок", max_chars=3000)

    system = (
        agents_md
        + "\n\nВАЖНО: если у тебя есть доступ к веб-поиску — ОБЯЗАТЕЛЬНО воспользуйся им "
          "и найди конкретные названия продуктов и вендоров. Если поиска нет, честно "
          "поставь search_available=false и confidence=low.\n"
        + (f"\nПАМЯТЬ БАЗЫ ЗНАНИЙ:\n{memory}\n" if memory else "")
    )

    try:
        raw = call_model(system, f"МАТЕРИАЛ ОБ ИДЕЕ:\n\n{idea_text}")
        data = parse_model_json(raw)
    except Exception as e:
        print(f"[Аналитик] Ошибка: {e}")
        append_timeline(timeline_file, "RESEARCH_FAILED", str(e))
        sys.exit(1)

    # Пустой отчёт хуже отсутствия отчёта: он попадёт в базу знаний и будет
    # выглядеть как «проверка проведена, ничего не нашлось». Проверяем, что
    # в ответе есть хоть что-то содержательное, прежде чем сохранять.
    has_content = any([
        data.get("industry_pains"),
        data.get("existing_products"),
        data.get("whitespace"),
        data.get("number_checks"),
        (data.get("verdict") or "").strip(),
    ])
    if not has_content:
        print()
        print("!" * 62)
        print("  ОТЧЁТ ПУСТОЙ — сохранять не буду.")
        print()
        print("  Скорее всего у модели не было доступа к веб-поиску, либо")
        print("  ответ вставился не полностью.")
        print()
        print("  Что сделать:")
        print("   1. Открой claude.ai или chatgpt.com в браузере")
        print("   2. Убедись, что поиск в вебе включён")
        print("   3. Запусти пункт 3 ещё раз и вставь ответ ЦЕЛИКОМ")
        print("      (если длинный — через слово  файл  )")
        print("!" * 62)
        append_timeline(timeline_file, "RESEARCH_EMPTY", "пустой ответ, отчёт не сохранён")
        sys.exit(1)

    if not data.get("search_available"):
        print()
        print("  ВНИМАНИЕ: модель сообщила, что поиска не было.")
        print("  Выводы основаны только на общих знаниях — достоверность низкая.")
        print()

    report_path = os.path.join(research_dir, "market_check.md")
    write_report(report_path, source_label, data)
    with open(os.path.join(research_dir, "market_check.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    try:
        with open(report_path, encoding="utf-8") as f:
            knowledge.ingest(task_dir, "Проверка рынка", f.read(), call_model, agents_md)
        print("[Аналитик] База знаний обновлена.")
    except Exception as e:
        print(f"[Аналитик] База знаний не обновлена: {e}")

    knowledge.graphify_build(task_dir)
    append_timeline(timeline_file, "RESEARCH_COMPLETE", report_path)

    print(f"\n[Аналитик] Готово. Отчёт: {report_path}")
    if not data.get("search_available"):
        print("[Аналитик] ВНИМАНИЕ: поиск был недоступен — выводы слабые, перепроверь.")
    print(f"\nНапутствие:\n{data.get('verdict', '')}\n")


if __name__ == "__main__":
    main()
