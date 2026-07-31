#!/usr/bin/env python3
"""
Vision Architect Runner Script (docker/run_vision_architect.py)

Stage 0 of the pipeline — runs BEFORE run_architect.py.
Takes a raw, fuzzy idea and runs it through 6 shaping frameworks
(Effectuation -> Working Backwards -> Soft Systems Methodology ->
Fuzzy Front End -> Opportunity Solution Tree/JTBD -> Double Diamond),
detecting cross-stage contradictions and looping the user back to
resolve them, exactly the way run_architect.py gates on plan.md
approval and the 0-balance audit.

Output: workspace/vision.md (stamped "vision: converged") and
workspace/task.md (auto-handoff). Because run_architect.py only
writes task.md `if not os.path.exists(task_file)`, dropping a
well-formed task.md here means the existing Architect pipeline
picks it up unmodified — no changes needed to run_architect.py.

Model backend is pluggable via VISION_MODEL_PROVIDER, since different
runs may be driven by Claude, Gemini, ChatGPT, or Kimi K3:
    VISION_MODEL_PROVIDER = anthropic | gemini | openai | moonshot
Each provider reads its own API key from the environment (see
call_model() below). Endpoints/models were verified as of this
writing but move fast — check the provider's current docs if a
call starts failing.

State persists in workspace/vision_state.json, so the process is
resumable: re-running this script continues from wherever it left
off (mirrors how run_executor.py resumes from plan.md).
"""

import os
import sys
import json
import datetime

from model_providers import call_model, parse_model_json  # noqa: E402
import knowledge  # noqa: E402
import user_input as ui  # noqa: E402

# --------------------------------------------------------------------------
# Stage definitions (fixed order, mirrors the AGENTS.md source of truth)
# --------------------------------------------------------------------------

STAGE_DEFS = [
    {
        "key": "effectuation",
        "fw": "Effectuation (Сарасвати)",
        "title": "Средства",
        "why": "Полная неопределённость: не от цели, а от того, что уже есть на руках.",
        "seed": "Начнём с того, что у тебя уже есть, а не с того, чего ты хочешь. Кто ты в этой теме (опыт, роль, репутация)? Что ты знаешь такого, чего не знает случайный человек со стороны? Кого ты знаешь — кто мог бы дать доступ, данные, первого клиента?",
        "steps": [
            "«Кто я» — опыт, роль, положение, которое даёт право говорить об этой теме",
            "«Что я знаю» — знание предметной области, доступ к данным, инсайдерское понимание процессов",
            "«Кого я знаю» — сеть контактов, потенциальные партнёры, первый заказчик",
            "Affordable loss — сколько времени/денег/репутации не жалко потерять, если не выйдет",
        ],
        "max_exchanges": 4,
    },
    {
        "key": "backwards",
        "fw": "Working Backwards (Amazon)",
        "title": "Пресс-релиз и FAQ",
        "why": "Вытащить видение из головы раньше данных: писать так, будто продукт уже есть и уже успешен.",
        "seed": "Представь, что продукт уже выпущен и признан успешным. Напиши пресс-релиз с позиции того дня: заголовок, для кого это, какую проблему снимает, и одна цитата довольного клиента — что именно у него изменилось.",
        "steps": [
            "Пресс-релиз: заголовок, целевой клиент, снимаемая проблема, выгода в его словах",
            "Цитата клиента — конкретная, с измеримым изменением, а не «стало удобнее»",
            "FAQ для клиента: самые неудобные вопросы, которые он задаст",
            "FAQ внутренний: что должно быть правдой, чтобы это вообще работало",
        ],
        "max_exchanges": 5,
    },
    {
        "key": "ssm",
        "fw": "Soft Systems Methodology (Чекланд)",
        "title": "Rich Picture + CATWOE",
        "why": "Метод для «мутных» ситуаций (wicked problems), где непонятно даже, в чём проблема.",
        "seed": "Опиши ситуацию как «rich picture» — свободно, словами, без структуры: кто в ней участвует, кто с кем конфликтует, где что застревает, кто чем недоволен. Не пытайся сформулировать проблему — просто опиши беспорядок как он есть.",
        "steps": [
            "Rich picture — свободное описание беспорядка: участники, конфликты, узкие места, эмоции",
            "C (Customers) — кто выигрывает или страдает от целевого преобразования",
            "A (Actors) — кто фактически выполняет работу внутри системы",
            "T (Transformation) — какой вход во что превращается: «X на входе -> Y на выходе»",
            "W (Weltanschauung) — картина мира, при которой это преобразование вообще имеет смысл",
            "O (Owners) — кто может остановить или закрыть эту систему",
            "E (Environmental constraints) — что принимается как данность и не подлежит изменению",
        ],
        "max_exchanges": 7,
    },
    {
        "key": "diamond",
        "fw": "Double Diamond, первый ромб (Discover -> Define)",
        "title": "Расхождение и схождение",
        "why": "Разойтись по проблемному полю без решения в голове, затем сойтись к чёткой формулировке проблемы. Второй ромб (Develop-Deliver) сюда не входит — туда рано.",
        "seed": "Разойдёмся (Discover): забудь пока о продукте и решениях. Какие ещё проблемы, симптомы и странности есть в этом поле, помимо той, с которой ты начал? Перечисли максимально широко, даже то, что кажется не твоим делом.",
        "steps": [
            "Discover — расширение проблемного поля, без единого упоминания решения",
            "Discover — где болит сильнее всего и у кого именно, по свидетельствам, а не по догадке",
            "Define — схождение: одна формулировка проблемы, которая покрывает главное",
            "Define — проверка формулировки: она про проблему, а не про замаскированное решение",
        ],
        "max_exchanges": 5,
    },
    {
        "key": "ffe",
        "fw": "Fuzzy Front End / NCD (Коэн)",
        "title": "Пять шагов до концепции",
        "why": "Формальная модель до-идейной стадии: возможность -> анализ -> идеи -> отбор -> концепция.",
        "seed": "Шаг 1 — Identify opportunity. Исходя из сформулированной проблемы: какие возможности здесь вообще открываются? Не решения пока, а именно окна возможностей — что изменилось в мире/отрасли/компании, из-за чего это стало решаемо или востребовано именно сейчас?",
        "steps": [
            "Identify opportunity — какие окна возможностей открылись и почему именно сейчас",
            "Analyze opportunity — насколько они реальны: размер, срочность, кто ещё их видит",
            "Generate idea — несколько разных вариантов решения, в том числе неудобных",
            "Select idea — по каким критериям отбираем и что отбрасываем (и почему)",
            "Define concept — отобранная идея, описанная как связная концепция продукта",
        ],
        "max_exchanges": 6,
    },
    {
        "key": "ost",
        "fw": "Opportunity Solution Tree (Торрес)",
        "title": "Дерево",
        "why": "Сверху — outcome, ниже — возможности (боли и потребности людей), в самом низу — решения-гипотезы и тесты допущений.",
        "seed": "Вершина дерева — outcome. Сформулируй одну измеримую бизнес-цель, к которой всё это должно привести. Не «сделать продукт», а изменение в поведении или в показателе: что должно стать другим и на сколько?",
        "steps": [
            "Outcome — одна измеримая цель на вершине дерева",
            "Opportunities — конкретные боли и потребности реальных людей, ведущие к этой цели",
            "Источник возможностей — что из этого от реальных людей, а что пока твоя догадка",
            "Solutions — решения-гипотезы под каждой значимой возможностью",
            "Assumption tests — самое рискованное допущение и как его проверить дешевле всего",
        ],
        "max_exchanges": 6,
    },
]

MAX_EXCHANGES_DEFAULT = 5
MAX_AUTO_REVISITS = 4


def max_exchanges_for(stage_idx):
    return STAGE_DEFS[stage_idx].get("max_exchanges", MAX_EXCHANGES_DEFAULT)


def idx_of(key):
    for i, d in enumerate(STAGE_DEFS):
        if d["key"] == key:
            return i
    return -1


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------

def fresh_state():
    return {
        "view": "flow",
        "stage_index": 0,
        "pending_return": None,
        "revisit_count": 0,
        "final_vision": None,
        "stages": [
            {
                "key": d["key"],
                "status": "active" if i == 0 else "pending",
                "qa": [],
                "summary": None,
                "pending_question": d["seed"] if i == 0 else None,
            }
            for i, d in enumerate(STAGE_DEFS)
        ],
    }


def load_state(state_file):
    if os.path.exists(state_file):
        with open(state_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return fresh_state()


def save_state(state_file, state):
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def full_log(state):
    lines = []
    for s in state["stages"]:
        d = STAGE_DEFS[idx_of(s["key"])]
        for pair in s["qa"]:
            lines.append(f"[{d['fw']}] Вопрос: {pair['question']}\nОтвет: {pair['answer']}")
        if s["summary"]:
            lines.append(f"[{d['fw']}] ИТОГ ЭТАПА: {s['summary']}")
    return "\n\n".join(lines)


def read_optional(path):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    return ""


def build_system_prompt(state, current_idx, agents_md, learnings_md, errors_md):
    cur = state["stages"][current_idx]
    cur_def = STAGE_DEFS[current_idx]
    overview = "\n".join(f"{i+1}. [{d['key']}] {d['fw']} — {d['why']}" for i, d in enumerate(STAGE_DEFS))
    in_subthread = state["pending_return"] is not None and current_idx != state["pending_return"]

    parts = [
        agents_md or "(AGENTS.md не найден — используются встроенные правила ниже.)",
        "",
        f"ЭТАПЫ:\n{overview}",
        "",
        f"СЕЙЧАС АКТИВЕН ЭТАП: [{cur['key']}] {cur_def['fw']} (обменов уже было: {len(cur['qa'])}, "
        f"лимит {max_exchanges_for(current_idx)}).",
        "",
        "ШАГИ МЕТОДА, которые этот этап обязан закрыть перед завершением:",
        "\n".join(f"  - {s}" for s in cur_def.get("steps", [])),
        "",
        "Веди человека по этим шагам последовательно — по одному-двум за обмен, а не все сразу. "
        "Не закрывай этап (`complete_stage`), пока по каждому шагу нет содержательного ответа; "
        "исключение — исчерпан лимит обменов. Если человек ответил общими словами, "
        "переспроси конкретнее по тому же шагу, а не переходи к следующему.",
    ]
    if in_subthread:
        return_target = STAGE_DEFS[state["pending_return"]]["key"]
        parts.append(f"ВАЖНО: это уточняющее под-обсуждение, вызванное конфликтом с этапом [{return_target}]. "
                     f"Определи, снят ли конфликт после нового ответа (поле conflict_resolved).")
    parts.append(f"\nВСЯ ИСТОРИЯ ОТВЕТОВ ПО ВСЕМ ЭТАПАМ:\n{full_log(state) or '(пока пусто)'}")

    # Память: что база знаний уже знает по теме текущего этапа. Благодаря этому
    # модель помнит выводы прошлых сессий и прошлых заседаний совета.
    task_dir = os.environ.get("_VISION_TASK_DIR_ABS")
    if task_dir:
        memory = knowledge.recall(task_dir, f"{cur_def['fw']} {cur_def['title']} {cur_def['why']}")
        if memory:
            parts.append("\nПАМЯТЬ (база знаний по этой идее). Опирайся на неё, "
                         "не переспрашивай уже известное, и отмечай расхождения:\n" + memory)
    if learnings_md:
        parts.append(f"\nНАКОПЛЕННЫЕ УРОКИ (LEARNINGS.md):\n{learnings_md}")
    if errors_md:
        parts.append(f"\nИЗВЕСТНЫЕ ОШИБКИ ЭТОГО АГЕНТА (ERRORS.md) — не повторяй их:\n{errors_md}")
    return "\n".join(parts)


# --------------------------------------------------------------------------
# Response handling (ports the same logic as the browser version)
# --------------------------------------------------------------------------

def handle_response(state, resp, answered_idx, log_fn):
    stage = state["stages"][answered_idx]
    in_subthread = state["pending_return"] is not None and answered_idx != state["pending_return"]

    if resp.get("action") == "ask_followup" and len(stage["qa"]) >= max_exchanges_for(answered_idx):
        resp["action"] = "complete_stage"
        resp["stage_summary"] = resp.get("stage_summary") or "Этап зафиксирован по итогам обсуждения (лимит обменов)."

    if in_subthread:
        if resp.get("conflict_resolved") or resp.get("action") == "complete_stage":
            origin_idx = state["pending_return"]
            state["pending_return"] = None
            state["stage_index"] = origin_idx
            log_fn("CONFLICT_RESOLVED", f"Возврат к этапу [{STAGE_DEFS[origin_idx]['key']}] после уточнения на [{stage['key']}]")
            if not state["stages"][origin_idx]["pending_question"]:
                state["stages"][origin_idx]["pending_question"] = "Продолжим с того места, где остановились."
            return
        else:
            stage["pending_question"] = resp.get("next_question") or "Уточни ещё раз — как это соотносится с прошлым ответом?"
            state["stage_index"] = answered_idx
            return

    if (resp.get("action") == "revisit" and resp.get("revisit_stage_key")
            and state["pending_return"] is None and state["revisit_count"] < MAX_AUTO_REVISITS):
        target_idx = idx_of(resp["revisit_stage_key"])
        if target_idx >= 0 and target_idx != answered_idx:
            state["revisit_count"] += 1
            state["pending_return"] = answered_idx
            note = resp.get("conflict_note") or "Обнаружена нестыковка с более ранним ответом."
            log_fn("CONFLICT_DETECTED", f"[{stage['key']}] -> [{resp['revisit_stage_key']}]: {note}")
            target_stage = state["stages"][target_idx]
            target_stage["status"] = "active"
            target_stage["pending_question"] = f"{note} Уточни, пожалуйста, как это соотносится с тем, что обсуждали здесь."
            state["stage_index"] = target_idx
            return

    if resp.get("action") == "complete_stage":
        stage["status"] = "complete"
        stage["summary"] = resp.get("stage_summary") or "Этап завершён."
        log_fn("STAGE_COMPLETE", f"[{stage['key']}] {stage['summary']}")
        if resp.get("final_vision"):
            state["final_vision"] = resp["final_vision"]
            state["view"] = "final"
            log_fn("VISION_CONVERGED", "Все 6 этапов пройдены, итоговое видение сформировано.")
            return
        next_idx = answered_idx + 1
        if next_idx < len(state["stages"]):
            state["stages"][next_idx]["status"] = "active"
            if not state["stages"][next_idx]["pending_question"]:
                state["stages"][next_idx]["pending_question"] = STAGE_DEFS[next_idx]["seed"]
            state["stage_index"] = next_idx
        else:
            # Последний этап закрыт, но модель не вернула final_vision. Раньше это
            # приводило к вечному циклу с пустым вопросом — теперь помечаем маршрут
            # завершённым, а синтез делается отдельным гарантированным вызовом в main().
            state["view"] = "final"
            log_fn("VISION_CONVERGED", "Все этапы пройдены; финальный синтез будет выполнен отдельным вызовом.")
    else:
        stage["pending_question"] = resp.get("next_question") or "Расскажи чуть подробнее."
        state["stage_index"] = answered_idx


# --------------------------------------------------------------------------
# Logging (mirrors the existing 1_pipeline_timeline.json convention)
# --------------------------------------------------------------------------

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
        "agent": "Vision_Architect",
        "event": event,
        "details": details,
    })
    os.makedirs(os.path.dirname(timeline_file), exist_ok=True)
    with open(timeline_file, "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2, ensure_ascii=False)


def append_audit_log(audit_file, line):
    os.makedirs(os.path.dirname(audit_file), exist_ok=True)
    with open(audit_file, "a", encoding="utf-8") as f:
        f.write(f"[{datetime.datetime.now().isoformat()}] {line}\n")


def write_telemetry(telemetry_file, state, provider):
    total_exchanges = sum(len(s["qa"]) for s in state["stages"])
    data = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "provider": provider,
        "model": os.environ.get("VISION_MODEL_NAME", "(default)"),
        "total_exchanges": total_exchanges,
        "revisit_count": state["revisit_count"],
        "stages_complete": sum(1 for s in state["stages"] if s["status"] == "complete"),
        "converged": state["view"] == "final",
    }
    os.makedirs(os.path.dirname(telemetry_file), exist_ok=True)
    with open(telemetry_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------
# Final artifacts
# --------------------------------------------------------------------------

def write_vision_md(path, state):
    lines = ["# Видение продукта", "", state["final_vision"] or "", "", "## По этапам", ""]
    for s in state["stages"]:
        d = STAGE_DEFS[idx_of(s["key"])]
        lines.append(f"### {d['fw']} — {d['title']}")
        lines.append(s["summary"] or "")
        lines.append("")
    lines.append("---")
    lines.append("**vision: converged** by Vision Architect")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def write_task_md(path, state):
    """Only called if task.md doesn't already exist — see main(). Matches the
    section shape run_architect.py expects, so the existing pipeline needs
    zero modification to consume it."""
    background = "\n".join(
        f"- **{STAGE_DEFS[idx_of(s['key'])]['fw']}**: {s['summary']}"
        for s in state["stages"] if s["summary"]
    )
    content = f"""# Task Specification

## Objective
{state['final_vision'] or ''}

## Background (from Vision Architect)
{background}

## Recommended Skills
- (заполнить по домену задачи — см. task_quality_framework.md)

## Source
Сформировано автоматически из vision.md (Vision Architect, Stage 0).
"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


# --------------------------------------------------------------------------
# Main interactive loop
# --------------------------------------------------------------------------

def main():
    # WORKSPACE_PATH = корень проекта, смонтированный как /workspace — так же,
    # как это делает существующий run_architect.py (workspace = os.getcwd()).
    # Именно поэтому внутри контейнера существует /workspace/docker/*.py.
    # VISION_TASK_DIR — подпапка (относительно корня), куда складывать артефакты
    # конкретной задачи, например TASKS/02.in-progress/task-042. По умолчанию "."
    # — то есть корень, что повторяет поведение run_executor.py.
    workspace = os.environ.get("WORKSPACE_PATH", "/workspace")
    task_dir = os.path.join(workspace, os.environ.get("VISION_TASK_DIR", "."))
    task_dir = os.path.abspath(task_dir)
    os.makedirs(task_dir, exist_ok=True)

    # В Docker папка агента монтируется как /workspace/.agents. При локальном
    # запуске через start.py монтировать нечего, поэтому путь можно задать явно.
    agents_dir = os.environ.get("VISION_AGENTS_DIR") or os.path.join(workspace, ".agents")
    logs_dir = os.path.join(task_dir, "logs")
    os.makedirs(logs_dir, exist_ok=True)

    state_file = os.path.join(task_dir, "vision_state.json")
    timeline_file = os.path.join(logs_dir, "V0_vision_timeline.json")
    audit_file = os.path.join(logs_dir, "V1_conflict_audit.log")
    telemetry_file = os.path.join(logs_dir, "V2_telemetry.json")
    vision_file = os.path.join(task_dir, "vision.md")
    task_file = os.path.join(task_dir, "task.md")

    agents_md = read_optional(os.path.join(agents_dir, "AGENTS.md"))
    learnings_md = read_optional(os.path.join(agents_dir, ".learnings", "LEARNINGS.md"))
    errors_md = read_optional(os.path.join(agents_dir, ".learnings", "ERRORS.md"))

    if "--reset" in sys.argv and os.path.exists(state_file):
        os.remove(state_file)
        print("[Vision Architect] Состояние сброшено.")

    os.environ["_VISION_TASK_DIR_ABS"] = task_dir
    knowledge.ensure_kb(task_dir)

    state = load_state(state_file)
    provider = os.environ.get("VISION_MODEL_PROVIDER", "anthropic").lower()

    if not any(s["qa"] for s in state["stages"]):
        append_timeline(timeline_file, "VISION_STARTED", f"Провайдер модели: {provider}")

    print(f"[Vision Architect] Провайдер модели: {provider}")
    print("[Vision Architect] Отвечай развёрнуто. 'exit' — сохранить и выйти (можно продолжить позже).\n")

    while state["view"] != "final":
        idx = state["stage_index"]
        stage = state["stages"][idx]
        d = STAGE_DEFS[idx]

        print(f"--- Этап {idx+1}/{len(STAGE_DEFS)} · {d['fw']} ({d['title']}) ---")
        print(f"({d['why']})\n")

        # Через read_long_answer, а не через input(): обычный input() читает
        # только ОДНУ строку, и ответ из нескольких абзацев обрезался на первом
        # же переводе строки — терялось всё, кроме первого абзаца.
        answer = ui.read_long_answer(stage["pending_question"], task_dir)

        if answer.lower() in ("exit", "quit"):
            save_state(state_file, state)
            print("[Vision Architect] Сохранено. Запусти скрипт снова, чтобы продолжить.")
            sys.exit(0)
        if not answer.strip():
            continue

        question = stage["pending_question"]
        stage["qa"].append({"question": question, "answer": answer})
        stage["pending_question"] = None

        sys_prompt = build_system_prompt(state, idx, agents_md, learnings_md, errors_md)
        try:
            raw = call_model(sys_prompt, answer)
            resp = parse_model_json(raw)
        except Exception as e:
            # Сообщение зависит от режима: в режиме подписки упоминание
            # ключа API только сбивает с толку.
            hint = ("Исправь и запусти снова — ответ сохранён."
                    if "вход в аккаунт" in str(e) or "не найдена" in str(e).lower()
                    else "Повтори ответ или проверь подключение к модели.")
            print(f"\n[Ошибка] {e}\n{hint}\n")
            stage["pending_question"] = question
            continue

        def log_fn(event, details):
            append_timeline(timeline_file, event, details)
            append_audit_log(audit_file, f"{event}: {details}")

        was_complete = state["stages"][idx]["status"] == "complete"
        handle_response(state, resp, idx, log_fn)
        save_state(state_file, state)

        # Этап только что закрылся — вносим его в базу знаний (операция ingest).
        if not was_complete and state["stages"][idx]["status"] == "complete":
            stage_text = "\n".join(
                f"Вопрос: {q['question']}\nОтвет: {q['answer']}"
                for q in state["stages"][idx]["qa"])
            stage_text += f"\n\nИТОГ ЭТАПА: {state['stages'][idx]['summary']}"
            try:
                res = knowledge.ingest(task_dir, f"Этап {STAGE_DEFS[idx]['fw']}",
                                       stage_text, call_model, agents_md)
                if res["pages_written"]:
                    print(f"  [память] обновлено страниц: {len(res['pages_written'])}")
                for c in res["contradictions"]:
                    print(f"  [память] противоречие: {c}")
            except Exception as e:
                print(f"  [память] не удалось обновить базу знаний: {e}")
        write_telemetry(telemetry_file, state, provider)
        print()

    if not state.get("final_vision"):
        print("[Vision Architect] Синтезирую итоговое видение...")
        synth_prompt = (
            (agents_md or "") + "\n\n"
            "Все 6 этапов пройдены. Твоя задача — финальный синтез.\n\n"
            f"ПОЛНЫЙ ПРОТОКОЛ:\n{full_log(state)}\n\n"
            "Верни строго JSON вида {\"final_vision\": \"...\"} — связный текст 150-250 слов, "
            "синтезирующий всё обсуждение в единое видение продукта: для кого, какая проблема, "
            "что делает, какое главное допущение нужно проверить первым."
        )
        try:
            raw = call_model(synth_prompt, "Синтезируй итоговое видение.")
            state["final_vision"] = parse_model_json(raw).get("final_vision")
        except Exception as e:
            print(f"[Vision Architect] Синтез не удался ({e}) — собираю видение из итогов этапов.")
        if not state.get("final_vision"):
            state["final_vision"] = " ".join(
                s["summary"] for s in state["stages"] if s.get("summary")
            ) or "(Итоговое видение не сформировано — см. итоги этапов ниже.)"
        save_state(state_file, state)

    write_vision_md(vision_file, state)
    if not os.path.exists(task_file):
        write_task_md(task_file, state)
        print("[Vision Architect] task.md создан — готов для run_architect.py.")
    else:
        print("[Vision Architect] task.md уже существует — не перезаписан.")

    try:
        knowledge.ingest(task_dir, "Итоговое видение", state["final_vision"], call_model, agents_md)
    except Exception:
        pass
    ok, msg = knowledge.graphify_build(task_dir)
    print(f"[Vision Architect] Граф связей: {msg}")

    append_timeline(timeline_file, "VISION_HANDOFF", "vision.md и task.md записаны в workspace")
    print(f"\n[Vision Architect] Готово. Видение сохранено в {vision_file}")
    print("[Vision Architect] Дальше можно запускать run_architect.py.")


if __name__ == "__main__":
    main()
