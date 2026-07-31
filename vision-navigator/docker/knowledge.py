#!/usr/bin/env python3
"""
knowledge.py — слой памяти: вики Карпатого + граф graphify.

Зачем. Каждый прогон навигатора и каждое заседание совета порождают тексты.
Без памяти они лежат мёртвым грузом: следующая сессия начинается с нуля, а
роли совета не помнят, что уже обсуждали. Здесь два дополняющих механизма.

1. LLM Wiki (паттерн Андрея Карпатого, апрель 2026). Три слоя:
       raw/   — исходники, неизменяемые: сырая мысль, стенограммы этапов,
                вердикты совета. Модель их читает, но никогда не правит.
       wiki/  — страницы, которые модель пишет и поддерживает сама:
                понятия, участники, допущения, противоречия, решения.
       схема  — agents_registry/wiki_curator/.agents/AGENTS.md: какие бывают
                типы страниц и как они связываются.
   Три операции: ingest (внести новое), query (спросить), lint (проверить
   здоровье: противоречия, устаревшее, страницы-сироты).
   Смысл в том, что знание НАКАПЛИВАЕТСЯ, а не собирается заново каждый раз.

2. Граф graphify. Механически строит структуру над raw/ + wiki/: сообщества,
   узлы-концентраторы, кратчайшие пути между понятиями. Умеет отвечать на
   вопросы обходом графа (`graphify query`) и объяснять узел (`explain`).
   Вики отвечает на «что мы про это знаем», граф — на «как это связано
   с остальным».

Оба механизма необязательны: если graphify не установлен, работает одна вики;
если и вики пуста, всё работает как раньше, просто без памяти.
"""

import os
import re
import json
import shutil
import subprocess
import datetime

GRAPHIFY_TIMEOUT = int(os.environ.get("GRAPHIFY_TIMEOUT", "600"))


# --------------------------------------------------------------- пути и утилиты

def kb_paths(task_dir):
    return {
        "raw": os.path.join(task_dir, "raw"),
        "wiki": os.path.join(task_dir, "wiki"),
        "graph_out": os.path.join(task_dir, "graphify-out"),
        "index": os.path.join(task_dir, "wiki", "index.md"),
    }


def ensure_kb(task_dir):
    p = kb_paths(task_dir)
    os.makedirs(p["raw"], exist_ok=True)
    os.makedirs(p["wiki"], exist_ok=True)
    if not os.path.exists(p["index"]):
        with open(p["index"], "w", encoding="utf-8") as f:
            f.write("# Индекс базы знаний\n\n"
                    "Страницы создаёт и поддерживает модель. Не редактируй вручную —\n"
                    "правки лучше вносить как новый источник в raw/.\n\n"
                    "## Страницы\n\n(пока пусто)\n")
    return p


def slugify(text, maxlen=60):
    text = re.sub(r"[^\w\s-]", "", text, flags=re.U).strip().lower()
    text = re.sub(r"[\s_]+", "-", text)
    return text[:maxlen] or "page"


def save_raw(task_dir, name, content, meta=None):
    """Кладёт источник в raw/ — неизменяемый слой."""
    p = ensure_kb(task_dir)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(p["raw"], f"{stamp}-{slugify(name)}.md")
    header = f"---\nsource: {name}\ndate: {datetime.datetime.now().isoformat()}\n"
    if meta:
        for k, v in meta.items():
            header += f"{k}: {v}\n"
    header += "---\n\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(header + content)
    return path


def read_wiki_index(task_dir, limit_chars=4000):
    p = kb_paths(task_dir)
    if not os.path.exists(p["index"]):
        return ""
    with open(p["index"], encoding="utf-8") as f:
        return f.read()[:limit_chars]


def list_wiki_pages(task_dir):
    p = kb_paths(task_dir)
    if not os.path.isdir(p["wiki"]):
        return []
    return sorted(f for f in os.listdir(p["wiki"])
                  if f.endswith(".md") and f != "index.md")


def read_wiki_pages(task_dir, names, limit_chars=6000):
    """Читает конкретные страницы вики целиком (в пределах лимита)."""
    p = kb_paths(task_dir)
    out = []
    used = 0
    for n in names:
        path = os.path.join(p["wiki"], n if n.endswith(".md") else n + ".md")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            body = f.read()
        chunk = f"\n### {n}\n{body}"
        if used + len(chunk) > limit_chars:
            break
        out.append(chunk)
        used += len(chunk)
    return "".join(out)


# ------------------------------------------------------------------- graphify

def graphify_available():
    return shutil.which("graphify") is not None


def graphify_build(task_dir, update=True, wiki=True):
    """
    Строит или обновляет граф над папкой идеи. --wiki просит graphify
    сгенерировать статьи по сообществам, что дополняет нашу вики
    структурной стороной.
    """
    if not graphify_available():
        return False, "graphify не установлен"
    cmd = ["graphify", task_dir]
    if update and os.path.exists(os.path.join(task_dir, "graphify-out", "graph.json")):
        cmd.append("--update")
    if wiki:
        cmd.append("--wiki")
    cmd.append("--no-viz")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=GRAPHIFY_TIMEOUT, encoding="utf-8", errors="replace")
        if res.returncode != 0:
            return False, (res.stderr or res.stdout or "")[-400:]
        return True, "граф обновлён"
    except subprocess.TimeoutExpired:
        return False, "graphify: превышено время ожидания"
    except Exception as e:
        return False, f"graphify: {e}"


def graphify_query(task_dir, question, budget=1200):
    """Спрашивает граф. Возвращает текст ответа или None."""
    graph_json = os.path.join(task_dir, "graphify-out", "graph.json")
    if not graphify_available() or not os.path.exists(graph_json):
        return None
    try:
        res = subprocess.run(
            ["graphify", "query", question, "--budget", str(budget)],
            capture_output=True, text=True, timeout=180,
            cwd=task_dir, encoding="utf-8", errors="replace")
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception:
        pass
    return None


def graph_stats(task_dir):
    graph_json = os.path.join(task_dir, "graphify-out", "graph.json")
    if not os.path.exists(graph_json):
        return None
    try:
        with open(graph_json, encoding="utf-8") as f:
            g = json.load(f)
        return {"nodes": len(g.get("nodes", [])), "edges": len(g.get("edges", []))}
    except Exception:
        return None


# --------------------------------------------------- сборка контекста для промпта

def recall(task_dir, question, max_chars=5000):
    """
    Собирает всё, что база знаний может сказать по теме вопроса. Это то,
    что подмешивается в системный промпт, чтобы модель «всё помнила».
    """
    parts = []

    index = read_wiki_index(task_dir, limit_chars=1500)
    if index and "(пока пусто)" not in index:
        parts.append("### Оглавление базы знаний\n" + index)

    pages = list_wiki_pages(task_dir)
    if pages:
        # грубый отбор релевантных страниц по совпадению слов вопроса с именем
        words = {w.lower() for w in re.findall(r"\w{4,}", question, flags=re.U)}
        scored = []
        for p in pages:
            name_words = set(re.findall(r"\w{4,}", p.lower(), flags=re.U))
            scored.append((len(words & name_words), p))
        scored.sort(reverse=True)
        picked = [p for score, p in scored[:4] if score > 0] or pages[:2]
        body = read_wiki_pages(task_dir, picked, limit_chars=max_chars // 2)
        if body:
            parts.append("### Страницы базы знаний по теме" + body)

    graph_answer = graphify_query(task_dir, question)
    if graph_answer:
        parts.append("### Что говорит граф связей\n" + graph_answer[:max_chars // 3])

    if not parts:
        return ""
    return ("\n\n".join(parts))[:max_chars]


# ------------------------------------------------------- операции вики (Карпатый)

INGEST_INSTRUCTION = """Ты — куратор базы знаний, работающий по паттерну LLM Wiki.

Тебе дан НОВЫЙ ИСТОЧНИК и текущее состояние вики. Твоя задача — обновить вики так,
чтобы знание накапливалось, а не дублировалось.

Правила:
- Страницы пиши по-русски, в markdown, имя файла — короткий слаг латиницей.
- Обновляй существующие страницы, а не плоди новые на ту же тему.
- Явно отмечай ПРОТИВОРЕЧИЯ с уже записанным, а не затирай старое молча.
- Различай факт, догадку и решение. Догадку помечай как догадку.
- Ставь перекрёстные ссылки вида [[имя-страницы]].

Верни строго один JSON-объект. Поля перечислены списком намеренно, НЕ готовым
JSON-блоком, чтобы разборщик не принял пример за настоящий ответ (такая ошибка
уже случалась):
- `pages` — список объектов, у каждого: `name` (слаг без расширения),
  `title` (заголовок), `content` (полный markdown страницы)
- `index_entries` — список строк вида: - [[слаг]] — одна строка, о чём страница
- `contradictions` — список строк с описанием противоречий, если нашлись
"""

LINT_INSTRUCTION = """Ты — куратор базы знаний. Проведи проверку здоровья вики.

Ищи: внутренние противоречия между страницами; утверждения, устаревшие после
более поздних источников; страницы-сироты, на которые никто не ссылается;
отсутствующие перекрёстные ссылки; догадки, которые незаметно стали
подаваться как факты.

Верни строго один JSON-объект. Поля перечислены списком намеренно, НЕ готовым
JSON-блоком, чтобы разборщик не принял пример за настоящий ответ:
- `contradictions` — список строк
- `stale` — список строк
- `orphans` — список строк
- `missing_links` — список строк
- `unsupported_claims` — список строк
- `verdict` — ровно одно значение: healthy либо needs_attention
"""


def ingest(task_dir, source_name, source_text, call_model_fn, agents_md=""):
    """
    Операция ingest: новый источник -> обновление страниц вики.
    call_model_fn — функция вызова модели (из model_providers).
    """
    ensure_kb(task_dir)
    save_raw(task_dir, source_name, source_text)

    existing = list_wiki_pages(task_dir)
    existing_body = read_wiki_pages(task_dir, existing[:8], limit_chars=6000)

    system = (agents_md + "\n\n" + INGEST_INSTRUCTION +
              f"\n\nТЕКУЩЕЕ ОГЛАВЛЕНИЕ:\n{read_wiki_index(task_dir)}"
              f"\n\nСУЩЕСТВУЮЩИЕ СТРАНИЦЫ:\n{existing_body or '(вики пуста)'}")
    user = f"НОВЫЙ ИСТОЧНИК ({source_name}):\n\n{source_text}"

    from model_providers import parse_model_json
    raw = call_model_fn(system, user)
    data = parse_model_json(raw)

    p = kb_paths(task_dir)
    written = []
    for page in data.get("pages", []):
        name = slugify(page.get("name") or page.get("title") or "page")
        path = os.path.join(p["wiki"], name + ".md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(f"# {page.get('title', name)}\n\n{page.get('content', '')}\n")
        written.append(name)

    entries = data.get("index_entries") or []
    if entries:
        with open(p["index"], encoding="utf-8") as f:
            idx = f.read().replace("(пока пусто)", "").rstrip()
        known = set(re.findall(r"\[\[([^\]]+)\]\]", idx))
        new_lines = [e for e in entries
                     if not (set(re.findall(r"\[\[([^\]]+)\]\]", e)) & known)]
        if new_lines:
            with open(p["index"], "w", encoding="utf-8") as f:
                f.write(idx + "\n" + "\n".join(new_lines) + "\n")

    return {"pages_written": written,
            "contradictions": data.get("contradictions") or []}


def lint(task_dir, call_model_fn, agents_md=""):
    """Операция lint: проверка здоровья базы знаний."""
    pages = list_wiki_pages(task_dir)
    if not pages:
        return {"verdict": "empty", "contradictions": [], "stale": [],
                "orphans": [], "missing_links": [], "unsupported_claims": []}
    body = read_wiki_pages(task_dir, pages, limit_chars=12000)
    system = agents_md + "\n\n" + LINT_INSTRUCTION
    from model_providers import parse_model_json
    raw = call_model_fn(system, f"ОГЛАВЛЕНИЕ:\n{read_wiki_index(task_dir)}\n\nСТРАНИЦЫ:{body}")
    return parse_model_json(raw)
