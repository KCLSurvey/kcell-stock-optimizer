#!/usr/bin/env python3
"""
LLM Council Runner (docker/run_llm_council.py)

Adapts Andrej Karpathy's LLM Council (github.com/karpathy/llm-council) to
this pipeline. The original: N general-purpose models answer the same
question independently, anonymously critique each other, and a Chairman
model synthesizes the final answer. This version: 6 fixed domain personas
(Engineer, Auditor, Inventory/Asset-Management expert, Sector Critic,
Businessman, Investor) independently review the CURRENT STATE of the
telecom equipment-lifecycle idea (Stage 1), anonymously critique each
other's reviews (Stage 2), and a 7th persona — CEO, as Chairman — reads
everything with full attribution and synthesizes a verdict (Stage 3).

Unlike run_vision_architect.py, this does not require a converged vision.
It reads whatever exists, in order of preference:
    vision.md (converged)  ->  vision_state.json (in progress)  ->  raw_thought.md
so it is useful even on an idea with "no hypotheses yet" — the skeptical
personas (Sector Critic, Investor) are often most useful precisely when
the material is still rough.

Each persona can be pinned to a specific real model via
COUNCIL_<ROLE>_PROVIDER / COUNCIL_<ROLE>_MODEL env vars (e.g.
COUNCIL_ENGINEER_PROVIDER=anthropic, COUNCIL_INVESTOR_PROVIDER=openai),
falling back to the shared VISION_MODEL_PROVIDER default if unset — so
this works whether you have one API key or four.

Output: workspace/council/{stage1_opinions.json, stage2_reviews.json,
verdict.json, verdict.md}, plus logs/V3_council_timeline.json and
logs/V4_council_telemetry.json (continuing the V-prefix numbering started
by run_vision_architect.py's V0-V2, so both stages' logs coexist cleanly
in the same task-folder logs/ directory).
"""

import os
import sys
import json
import datetime

from model_providers import call_model, parse_model_json  # noqa: E402
import knowledge  # noqa: E402

MEMBERS = [
    {"key": "engineer", "title": "Инженер / Технический архитектор"},
    {"key": "auditor", "title": "Аудитор"},
    {"key": "inventory", "title": "Эксперт по учёту запасов"},
    {"key": "critic", "title": "Отраслевой критик (Red Team)"},
    {"key": "businessman", "title": "Бизнесмен / Оператор"},
    {"key": "investor", "title": "Инвестор"},
]
CHAIRMAN = {"key": "ceo", "title": "CEO (Председатель)"}


def role_provider_model(role_key):
    prefix = f"COUNCIL_{role_key.upper()}_"
    provider = os.environ.get(prefix + "PROVIDER")  # None -> falls back inside call_model
    model_name = os.environ.get(prefix + "MODEL")
    return provider, model_name


def read_optional(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    return ""


def resolve_context(task_dir):
    vision_md = os.path.join(task_dir, "vision.md")
    state_file = os.path.join(task_dir, "vision_state.json")
    raw_file = os.path.join(task_dir, "raw_thought.md")

    if os.path.exists(vision_md):
        return "vision.md (сошедшееся видение)", read_optional(vision_md)

    if os.path.exists(state_file):
        with open(state_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        lines = ["(Видение ещё в процессе формирования, это срез текущего состояния.)", ""]
        for s in state.get("stages", []):
            qa = s.get("qa", [])
            if not qa and not s.get("summary"):
                continue
            lines.append(f"### Этап: {s['key']}")
            if s.get("summary"):
                lines.append(f"Итог: {s['summary']}")
            for pair in qa:
                lines.append(f"- Вопрос: {pair['question']}")
                lines.append(f"  Ответ: {pair['answer']}")
            lines.append("")
        return "vision_state.json (видение в процессе)", "\n".join(lines)

    if os.path.exists(raw_file):
        return "raw_thought.md (сырая мысль, без гипотез)", read_optional(raw_file)

    print("[LLM Council] Не найден ни vision.md, ни vision_state.json, ни raw_thought.md.")
    print("[LLM Council] Положи хотя бы raw_thought.md в рабочую папку и запусти снова.")
    sys.exit(1)


def append_timeline(timeline_file, event, details):
    events = []
    if os.path.exists(timeline_file):
        try:
            with open(timeline_file, "r", encoding="utf-8") as f:
                events = json.load(f)
        except Exception:
            events = []
    events.append({
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "agent": "LLM_Council",
        "event": event,
        "details": details,
    })
    os.makedirs(os.path.dirname(timeline_file), exist_ok=True)
    with open(timeline_file, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2, ensure_ascii=False)


def run_stage1(agents_md, source_label, idea_text, log_fn, task_dir=None):
    results = []
    for m in MEMBERS:
        provider, model_name = role_provider_model(m["key"])
        # Память под мандат конкретной роли: аудитор вспоминает про капитализацию,
        # инвестор — про права на ИС, и т.д. Так совет не повторяет прошлые заседания.
        memory = ""
        if task_dir:
            memory = knowledge.recall(task_dir, f"{m['title']} {m['key']}", max_chars=3000)
        system_prompt = (
            f"{agents_md}\n\n"
            f"ТЫ СЕЙЧАС ИГРАЕШЬ РОЛЬ: {m['key']} ({m['title']}).\n"
            f"Это Stage 1 — независимая оценка, БЕЗ доступа к мнениям других советников.\n"
            f"Источник материала об идее: {source_label}.\n"
            + (f"\nПАМЯТЬ ПРЕДЫДУЩИХ ЗАСЕДАНИЙ И ЭТАПОВ (не повторяй уже сказанное, "
               f"опирайся и развивай):\n{memory}\n" if memory else "")
            + f"\nОтвечай строго в формате Stage 1 из раздела «Формат ответов»."
        )
        try:
            raw = call_model(system_prompt, idea_text, provider=provider, model_name=model_name)
            parsed = parse_model_json(raw)
            parsed["role"] = m["key"]
            log_fn("STAGE1_DONE", f"[{m['key']}] provider={provider or '(default)'}")
        except Exception as e:
            parsed = {"role": m["key"], "error": str(e)}
            log_fn("STAGE1_FAILED", f"[{m['key']}]: {e}")
        results.append(parsed)
        print(f"  [Stage 1] {m['title']}: {'ok' if 'error' not in parsed else 'ОШИБКА — ' + parsed['error']}")
    return results


def run_stage2(agents_md, source_label, stage1_results, log_fn):
    results = []
    for i, m in enumerate(MEMBERS):
        own = stage1_results[i]
        if "error" in own:
            results.append({"role": m["key"], "skipped": "stage1 failed"})
            continue

        others = [r for j, r in enumerate(stage1_results) if j != i and "error" not in r]
        # Буквы генерируются по числу советников, а не берутся из строки фиксированной
        # длины — иначе добавление седьмого члена совета уронило бы Stage 2 по IndexError.
        letters = [chr(ord("A") + k) for k in range(len(others))]
        anon_block = "\n\n".join(
            f"Советник {letters[k]}:\n{json.dumps({kk: vv for kk, vv in o.items() if kk != 'role'}, ensure_ascii=False, indent=2)}"
            for k, o in enumerate(others)
        )

        provider, model_name = role_provider_model(m["key"])
        system_prompt = (
            f"{agents_md}\n\n"
            f"ТЫ СЕЙЧАС ИГРАЕШЬ РОЛЬ: {m['key']} ({m['title']}).\n"
            f"Это Stage 2 — тебе показывают анонимизированные Stage-1 мнения остальных "
            f"пяти советников (без указания, кто есть кто). Твоё собственное Stage-1 "
            f"мнение было:\n{json.dumps({kk: vv for kk, vv in own.items() if kk != 'role'}, ensure_ascii=False, indent=2)}\n\n"
            f"МНЕНИЯ ДРУГИХ СОВЕТНИКОВ (анонимно):\n{anon_block}\n\n"
            f"Источник материала об идее: {source_label}.\n"
            f"Отвечай строго в формате Stage 2 из раздела «Формат ответов»."
        )
        try:
            raw = call_model(system_prompt, "Проведи Stage 2.", provider=provider, model_name=model_name)
            parsed = parse_model_json(raw)
            parsed["role"] = m["key"]
            log_fn("STAGE2_DONE", f"[{m['key']}]")
        except Exception as e:
            parsed = {"role": m["key"], "error": str(e)}
            log_fn("STAGE2_FAILED", f"[{m['key']}]: {e}")
        results.append(parsed)
        print(f"  [Stage 2] {m['title']}: {'ok' if 'error' not in parsed else 'ОШИБКА — ' + parsed['error']}")
    return results


def run_stage3(agents_md, source_label, stage1_results, stage2_results, log_fn):
    full_dump = []
    for m, s1, s2 in zip(MEMBERS, stage1_results, stage2_results):
        full_dump.append(f"### {m['title']} ({m['key']})")
        full_dump.append(f"Stage 1: {json.dumps(s1, ensure_ascii=False)}")
        full_dump.append(f"Stage 2: {json.dumps(s2, ensure_ascii=False)}")
        full_dump.append("")

    provider, model_name = role_provider_model(CHAIRMAN["key"])
    system_prompt = (
        f"{agents_md}\n\n"
        f"ТЫ СЕЙЧАС ИГРАЕШЬ РОЛЬ: {CHAIRMAN['key']} ({CHAIRMAN['title']}), Председатель.\n"
        f"Это Stage 3 — синтез. В отличие от рядовых советников, тебе показывают ВСЁ "
        f"с полной атрибуцией (кто есть кто).\n\n"
        f"Источник материала об идее: {source_label}.\n\n"
        f"ПОЛНЫЙ ПРОТОКОЛ STAGE 1 И STAGE 2:\n" + "\n".join(full_dump) + "\n\n"
        f"Отвечай строго в формате Stage 3 из раздела «Формат ответов»."
    )
    raw = call_model(system_prompt, "Вынеси вердикт.", provider=provider, model_name=model_name)
    parsed = parse_model_json(raw)
    log_fn("STAGE3_DONE", f"verdict={parsed.get('verdict')}")
    return parsed


def write_verdict_md(path, source_label, stage1, stage2, verdict):
    lines = [
        "# Вердикт LLM Council",
        "",
        f"*Источник материала: {source_label}*",
        "",
        f"**Решение: {verdict.get('verdict', '?')}**",
        "",
        verdict.get("summary", ""),
        "",
        "## Ключевые расхождения между советниками",
    ]
    for d in verdict.get("key_disagreements", []):
        lines.append(f"- {d}")
    lines += ["", "## Открытые вопросы обратно в Vision Architect"]
    for q in verdict.get("open_questions_for_vision_navigator", []):
        lines.append(f"- {q}")
    lines += ["", "## Рекомендация следующего шага", verdict.get("next_step_recommendation", ""), ""]
    lines += ["## Приложение A: мнения по ролям (Stage 1)", ""]
    for m, s1 in zip(MEMBERS, stage1):
        lines.append(f"### {m['title']}")
        if "error" in s1:
            lines.append(f"*Ошибка вызова модели: {s1['error']}*")
        else:
            lines.append(s1.get("assessment", ""))
            risks = s1.get("top_risks") or []
            if risks:
                lines.append("Риски: " + "; ".join(risks))
        lines.append("")

    lines += ["## Приложение B: взаимная критика (Stage 2)", ""]
    for m, s2 in zip(MEMBERS, stage2):
        lines.append(f"### {m['title']}")
        if "error" in s2 or "skipped" in s2:
            lines.append(f"*Пропущено: {s2.get('error') or s2.get('skipped')}*")
        else:
            dis = s2.get("disagreements") or []
            agr = s2.get("agreements") or []
            if dis:
                lines.append("**Не согласен:**")
                lines += [f"- {d}" for d in dis]
            if agr:
                lines.append("**Согласен:**")
                lines += [f"- {a}" for a in agr]
            if s2.get("revised_view"):
                lines.append(f"**Пересмотрел мнение:** {s2['revised_view']}")
        lines.append("")

    lines += ["---", "**council: reviewed** by LLM Council"]
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def main():
    # См. комментарий в run_vision_architect.py: /workspace — корень проекта,
    # VISION_TASK_DIR — подпапка конкретной задачи.
    workspace = os.environ.get("WORKSPACE_PATH", "/workspace")
    task_dir = os.path.abspath(os.path.join(workspace, os.environ.get("VISION_TASK_DIR", ".")))
    os.makedirs(task_dir, exist_ok=True)

    # В Docker папка агента монтируется как /workspace/.agents. При локальном
    # запуске через start.py монтировать нечего, поэтому путь можно задать явно.
    agents_dir = os.environ.get("VISION_AGENTS_DIR") or os.path.join(workspace, ".agents")
    logs_dir = os.path.join(task_dir, "logs")
    council_dir = os.path.join(task_dir, "council")
    os.makedirs(logs_dir, exist_ok=True)
    os.makedirs(council_dir, exist_ok=True)

    timeline_file = os.path.join(logs_dir, "V3_council_timeline.json")
    telemetry_file = os.path.join(logs_dir, "V4_council_telemetry.json")

    agents_md = read_optional(os.path.join(agents_dir, "AGENTS.md"))
    if not agents_md:
        print("[LLM Council ERROR] agents_registry/llm_council/.agents/AGENTS.md не смонтирован в .agents — без него роли не определены.")
        sys.exit(1)

    source_label, idea_text = resolve_context(task_dir)
    print(f"[LLM Council] Источник материала: {source_label}")

    def log_fn(event, details):
        append_timeline(timeline_file, event, details)

    log_fn("COUNCIL_STARTED", source_label)

    print("\n=== Stage 1: независимые мнения ===")
    stage1 = run_stage1(agents_md, source_label, idea_text, log_fn, task_dir)

    print("\n=== Stage 2: анонимная взаимная критика ===")
    stage2 = run_stage2(agents_md, source_label, stage1, log_fn)

    print("\n=== Stage 3: синтез Председателя (CEO) ===")
    verdict = run_stage3(agents_md, source_label, stage1, stage2, log_fn)

    with open(os.path.join(council_dir, "stage1_opinions.json"), "w", encoding="utf-8") as f:
        json.dump(stage1, f, indent=2, ensure_ascii=False)
    with open(os.path.join(council_dir, "stage2_reviews.json"), "w", encoding="utf-8") as f:
        json.dump(stage2, f, indent=2, ensure_ascii=False)
    with open(os.path.join(council_dir, "verdict.json"), "w", encoding="utf-8") as f:
        json.dump(verdict, f, indent=2, ensure_ascii=False)
    verdict_md_path = os.path.join(council_dir, "verdict.md")
    write_verdict_md(verdict_md_path, source_label, stage1, stage2, verdict)

    telemetry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": source_label,
        "verdict": verdict.get("verdict"),
        "stage1_failures": sum(1 for r in stage1 if "error" in r),
        "stage2_failures": sum(1 for r in stage2 if "error" in r),
    }
    with open(telemetry_file, "w", encoding="utf-8") as f:
        json.dump(telemetry, f, indent=2, ensure_ascii=False)

    # Вердикт уходит в базу знаний, чтобы следующий прогон навигатора и следующее
    # заседание совета его помнили.
    try:
        knowledge.ensure_kb(task_dir)
        with open(verdict_md_path, encoding="utf-8") as f:
            knowledge.ingest(task_dir, "Вердикт совета", f.read(), call_model, agents_md)
        print("[LLM Council] База знаний обновлена вердиктом.")
    except Exception as e:
        print(f"[LLM Council] Не удалось обновить базу знаний: {e}")
    ok, msg = knowledge.graphify_build(task_dir)
    print(f"[LLM Council] Граф связей: {msg}")

    log_fn("COUNCIL_COMPLETE", f"verdict={verdict.get('verdict')} -> {verdict_md_path}")

    print(f"\n[LLM Council] Готово. Вердикт: {verdict.get('verdict', '?')}")
    print(f"[LLM Council] Полный отчёт: {verdict_md_path}")
    if verdict.get("open_questions_for_vision_navigator"):
        print("[LLM Council] Открытые вопросы для следующего прогона Vision Architect:")
        for q in verdict["open_questions_for_vision_navigator"]:
            print(f"  - {q}")


if __name__ == "__main__":
    main()
