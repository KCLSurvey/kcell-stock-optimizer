# LLM Council — интеграция (Stage 0b)

## Место в конвейере
Совет — не обязательно последний шаг перед Архитектором. Он читает то, что
есть, в порядке убывания зрелости:

```
vision.md (сошлось)  →  vision_state.json (в процессе)  →  raw_thought.md (сырое)
```

Значит, есть два естественных способа использования:

1. **Ранний прогон** — прямо на `raw_thought.md`, до Vision Architect вообще.
   Скептические роли (Отраслевой критик, Инвестор) особенно хорошо вскрывают,
   чего не хватает, ещё когда нечего терять — гипотез ещё нет, значит и
   защищать нечего.
2. **Финальный прогон** — после того как `vision.md` получил штамп
   `vision: converged`, как гейт перед тем, как `task.md` реально уйдёт в
   `run_architect.py`. Ближе к оригинальному духу Карпатого — независимая
   оценка готового материала.

Открытые вопросы, которые Председатель (CEO) выносит в
`open_questions_for_vision_navigator`, — это буквально следующий раунд
входных данных для `run_vision_architect.py`: перенеси их вручную в
`raw_thought.md` или прямо в диалог следующего прогона.

## Запуск

Использует тот же образ, что и Vision Architect — зависимости идентичны
(чистый `urllib`, без pandas/openpyxl):

```bash
docker run --rm \
  -v "$(pwd):/workspace" \
  -v "$(pwd)/agents_registry/llm_council/.agents:/workspace/.agents" \
  -e VISION_TASK_DIR="TASKS/02.in-progress/task-042" \
  -e VISION_MODEL_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  vision-architect-sandbox:latest \
  python3 /workspace/docker/run_llm_council.py
```

Переопределение команды работает потому, что в образе задан только `CMD`, без
`ENTRYPOINT ["python3"]` — иначе аргументы склеились бы в `python3 python3 ...`
и контейнер бы не стартовал.

Не интерактивный (`-it` не нужен) — Совет ничего не спрашивает у человека,
это батч-прогон в отличие от `run_vision_architect.py`.

## Настоящее разнообразие моделей (не обязательно, но ближе к духу Карпатого)

По умолчанию все 7 ролей используют один и тот же `VISION_MODEL_PROVIDER` —
это работает, если под рукой только один ключ API. Но если есть доступ к
нескольким провайдерам, каждую роль можно закрепить за конкретной моделью:

```bash
-e COUNCIL_ENGINEER_PROVIDER=anthropic \
-e COUNCIL_AUDITOR_PROVIDER=openai \
-e COUNCIL_INVENTORY_PROVIDER=anthropic \
-e COUNCIL_CRITIC_PROVIDER=gemini \
-e COUNCIL_BUSINESSMAN_PROVIDER=moonshot \
-e COUNCIL_INVESTOR_PROVIDER=openai \
-e COUNCIL_CEO_PROVIDER=anthropic \
-e ANTHROPIC_API_KEY=... -e OPENAI_API_KEY=... -e GEMINI_API_KEY=... -e MOONSHOT_API_KEY=...
```

`COUNCIL_<ROЛЬ>_MODEL` — аналогично, если нужна конкретная версия модели, а
не дефолт провайдера. Это ровно то различие, ради которого Карпатый вообще
затевал Council: не "одна модель играет пять ролей", а действительно разные
модели, которые физически не могут договориться за кулисами.

## Результат

```
workspace/council/
├── stage1_opinions.json   # 6 независимых мнений
├── stage2_reviews.json    # 6 взаимных анонимных критик
├── verdict.json           # машиночитаемый вердикт CEO
└── verdict.md             # человекочитаемый отчёт, штамп "council: reviewed"

workspace/logs/
├── V3_council_timeline.json
└── V4_council_telemetry.json
```

Если у какой-то роли не оказалось ключа API — она не валит весь прогон:
её Stage 1 помечается `"error"`, Stage 2 остальных просто не увидит её
мнения, а CEO на Stage 3 получит на одно мнение меньше и увидит это в
протоколе. Число `stage1_failures`/`stage2_failures` в телеметрии — сигнал
проверить, все ли ключи на месте.

## Что осталось на твоё усмотрение
- Разбивать ли `verdict` `reshape` автоматически на новый прогон
  `run_vision_architect.py`, или это ручной шаг — сейчас ручной.
- Стоит ли давать Совету доступ к остальным документам концепции (не только
  к `vision.md`) — сейчас нет, чтобы советники судили по тому же материалу,
  что получит Архитектор, а не по всему корпусу знаний.
