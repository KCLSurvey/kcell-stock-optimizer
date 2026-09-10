/**
 * Every expected failure in the pipeline throws a ProcessingError with a stable
 * `code`. The UI shows `message` (already human-readable Russian) plus, in a
 * collapsible technical section, `technical`/`context` — the detail a person
 * debugging the code (or Claude, reading an exported log) actually needs.
 */
export class ProcessingError extends Error {
  readonly code: string
  readonly technical?: string
  readonly context?: Record<string, unknown>

  constructor(code: string, message: string, opts?: { technical?: string; context?: Record<string, unknown> }) {
    super(message)
    this.name = 'ProcessingError'
    this.code = code
    this.technical = opts?.technical
    this.context = opts?.context
  }
}

export const ERROR_CODES = {
  SHEET_MISSING: 'E_SHEET_MISSING',
  COLUMN_NOT_FOUND: 'E_COLUMN_NOT_FOUND',
  ROW_LIMIT_EXCEEDED: 'E_ROW_LIMIT_EXCEEDED',
  NO_PROJECT_COLUMNS: 'E_NO_PROJECT_COLUMNS',
  TEMPLATE_MATERIAL_COLUMNS: 'E_TEMPLATE_MATERIAL_COLUMNS',
  FILE_READ_FAILED: 'E_FILE_READ_FAILED',
  ABORTED_BY_USER: 'E_ABORTED_BY_USER',
  STALLED_ABORTED: 'E_STALLED_ABORTED',
  UNKNOWN: 'E_UNKNOWN',
} as const

/** One-line "what this code means" shown next to every occurrence — for the person reading the UI or the exported log, not just the message from the throw site. */
export const ERROR_CATALOG: Record<string, string> = {
  [ERROR_CODES.SHEET_MISSING]: 'В файле не найден ожидаемый лист с данными — проверьте, что загружен правильный файл.',
  [ERROR_CODES.COLUMN_NOT_FOUND]:
    'В файле нет колонки с ожидаемым названием — структура файла отличается от той, что описана в спецификации.',
  [ERROR_CODES.ROW_LIMIT_EXCEEDED]:
    'В файле больше заполненных строк, чем программа рассчитана обрабатывать за один раз (лимit 50 000). Разбейте файл на части.',
  [ERROR_CODES.NO_PROJECT_COLUMNS]:
    'В целевом файле не нашлось ни одной колонки-проекта (СПП-элемента) — только атрибуты материала.',
  [ERROR_CODES.TEMPLATE_MATERIAL_COLUMNS]:
    'В шаблоне заливки нарушена ожидаемая структура колонки «Материал» (должна встречаться ровно 2 раза).',
  [ERROR_CODES.FILE_READ_FAILED]:
    'Файл не удалось прочитать как Excel (.xlsx) — возможно, он повреждён, защищён паролем или это не Excel-файл.',
  [ERROR_CODES.ABORTED_BY_USER]: 'Обработка остановлена пользователем вручную.',
  [ERROR_CODES.STALLED_ABORTED]:
    'Обработка не подавала признаков активности длительное время и была остановлена автоматически как «зависшая».',
  [ERROR_CODES.UNKNOWN]:
    'Внутренняя ошибка программы, не предусмотренная заранее. Это повод прислать лог для исправления кода.',
}

export interface SerializedError {
  code: string
  message: string
  explanation: string
  technical?: string
  context?: Record<string, unknown>
}

/** Converts any thrown value (ProcessingError, native Error, or a non-Error throw) into a uniform, loggable shape. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof ProcessingError) {
    return {
      code: err.code,
      message: err.message,
      explanation: ERROR_CATALOG[err.code] ?? ERROR_CATALOG[ERROR_CODES.UNKNOWN],
      technical: err.technical,
      context: err.context,
    }
  }
  if (err instanceof Error) {
    return {
      code: ERROR_CODES.UNKNOWN,
      message: `Непредвиденная ошибка: ${err.message}`,
      explanation: ERROR_CATALOG[ERROR_CODES.UNKNOWN],
      technical: err.stack ?? `${err.name}: ${err.message}`,
    }
  }
  return {
    code: ERROR_CODES.UNKNOWN,
    message: `Непредвиденная ошибка: ${String(err)}`,
    explanation: ERROR_CATALOG[ERROR_CODES.UNKNOWN],
  }
}
