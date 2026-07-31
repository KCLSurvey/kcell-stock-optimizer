# Vision Architect — интеграция в конвейер (Stage 0)

## Идея одной строкой
`run_vision_architect.py` пишет `task.md` **до** того, как стартует
`run_architect.py`. Существующий Архитектор создаёт `task.md` только
`if not os.path.exists(task_file)` — значит, если файл уже готов, Архитектор
просто пойдёт дальше со своим шагом 2. **`run_architect.py` не нужно
модифицировать вообще.**

## Куда класть файлы

```
project-root/
├── docker/
│   ├── run_architect.py                (уже есть)
│   ├── run_executor.py                 (уже есть)
│   ├── model_providers.py              (новый — общий модуль вызова 4 провайдеров)
│   ├── run_vision_architect.py         (новый)
│   ├── run_llm_council.py              (новый — см. docs/llm_council_integration.md)
│   └── Dockerfile.vision_architect     (новый — общий образ для обоих новых скриптов)
│
└── agents_registry/
    ├── architect/.agents/...           (уже есть)
    ├── executor_finance/.agents/...    (уже есть)
    ├── vision_architect/.agents/       (новый)
    │   ├── AGENTS.md
    │   └── .learnings/{LEARNINGS.md, ERRORS.md}
    └── llm_council/.agents/            (новый)
        ├── AGENTS.md
        └── .learnings/{LEARNINGS.md, ERRORS.md}
```

`run_vision_architect.py` и `run_llm_council.py` оба импортируют
`model_providers.py` — четыре провайдера описаны один раз, а не дублируются
по скриптам (тот же принцип, что в `code_reuse_and_execution_logging.md`).

## Сборка образа

```bash
docker build -f docker/Dockerfile.vision_architect -t vision-architect-sandbox:latest .
```

## Запуск: формирование видения → появление задачи

Создай папку задачи заранее (как обычно, вручную или скриптом переноса из
`ВХОДЯЩИЕ/`) — но **не пиши `task.md`**, это сделает Vision Architect:

```bash
mkdir -p TASKS/02.in-progress/task-042

docker run --rm -it \
  -v "$(pwd):/workspace" \
  -v "$(pwd)/agents_registry/vision_architect/.agents:/workspace/.agents" \
  -e VISION_TASK_DIR="TASKS/02.in-progress/task-042" \
  -e VISION_MODEL_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  vision-architect-sandbox:latest
```

**Важно про монтирование.** Как `/workspace` монтируется **корень проекта**, а не
папка задачи — точно так же, как это делает существующий `run_architect.py`
(`workspace = os.getcwd()`). Иначе путь `/workspace/docker/run_vision_architect.py`
внутри контейнера просто не существовал бы. Куда складывать артефакты конкретной
задачи, задаётся отдельно через `VISION_TASK_DIR` (по умолчанию — корень, как у
`run_executor.py`).

Флаг `-it` обязателен — это интерактивный диалог, а не одноразовый батч-запуск,
в отличие от `run_executor.py`. Процесс резюмируем: `vision_state.json`
сохраняется после каждого обмена, `exit` в диалоге просто ставит паузу.

После того как все 6 этапов сойдутся, в `TASKS/02.in-progress/task-042/`
появятся:
- `vision.md` — полный документ со штампом `vision: converged`;
- `task.md` — авто-сгенерированный черновик спецификации для Архитектора;
- `logs/V0_vision_timeline.json`, `logs/V1_conflict_audit.log`, `logs/V2_telemetry.json`.

Префикс `V` — намеренно, чтобы не путать с `1_pipeline_timeline.json` и
остальными файлами, которые в эту же `logs/` папку допишет уже
`run_architect.py` на следующем шаге. Коллизий имён нет — обе группы логов
спокойно живут рядом, и в `TASKS/04.done/task-042/logs/` в итоге видна вся
история целиком: от сырой мысли до 0-balance аудита.

Дальше — как обычно:

```bash
python3 docker/run_architect.py
```

## Переменные окружения по провайдерам

Раз раннер может быть любым из четырёх — переключение через
`VISION_MODEL_PROVIDER`, без правок кода:

| Провайдер | `VISION_MODEL_PROVIDER` | Ключ | `VISION_MODEL_NAME` (опционально) |
|---|---|---|---|
| Claude | `anthropic` | `ANTHROPIC_API_KEY` | по умолчанию `claude-sonnet-4-6` |
| Gemini | `gemini` | `GEMINI_API_KEY` (или `GOOGLE_API_KEY`) | по умолчанию `gemini-2.5-flash` |
| ChatGPT | `openai` | `OPENAI_API_KEY` | по умолчанию `gpt-4.1` |
| Kimi K3 | `moonshot` | `MOONSHOT_API_KEY` | по умолчанию `kimi-k3` |

Все три HTTP-провайдера (Gemini/OpenAI/Moonshot) проверены по актуальной
документации на момент сборки; конечные точки и совместимость API у
провайдеров меняются быстро — если вызов вдруг начнёт падать, первым делом
сверься с текущей документацией провайдера, а не ищи баг в логике скрипта.

## Что можно доработать дальше (не сделано намеренно, чтобы не гадать)

- **Автоматический хэндофф** — сейчас перенос из `vision.md`/`task.md` в
  `run_architect.py` — это просто "запусти следующий скрипт руками". Если
  хочешь полностью бесшовный конвейер, можно дописать обёртку
  `run_full_pipeline.py`, которая вызывает `run_vision_architect.py`, ждёт
  штамп `vision: converged`, и сама спавнит `run_architect.py`.
- **Самообучение** — `ERRORS.md`/`LEARNINGS.md` в реестре `vision_architect`
  сейчас читаются, но никто в них не пишет автоматически (в основной системе
  это делает Архитектор при ревью). Решай сам, должен ли это делать сам
  Vision Architect, или это ручной шаг ревью, как у остальных агентов.
- **Domain-специфичный `Recommended Skills` в task.md** — сейчас это
  заглушка; логично сопоставлять её с `task_quality_framework.md`, но это
  требует знать, о каком домене вообще была идея (финансы? другое?).
