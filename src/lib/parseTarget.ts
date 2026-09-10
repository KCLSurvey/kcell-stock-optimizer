import ExcelJS from 'exceljs'
import { MAX_INPUT_ROWS, type TargetRequirement } from './types'
import { normalizeMaterial, normalizeText, toPositiveQuantity } from './normalize'
import { cellScalar, readHeaderMap } from './columnMap'
import { ERROR_CODES, ProcessingError } from './errors'
import { checkpoint, type AbortState } from './cooperative'

export interface ParseTargetResult {
  requirements: TargetRequirement[]
  warnings: string[]
  rawRowCount: number
  projectColumns: string[]
}

// Known attribute columns (whitespace/case-insensitive). Everything else in the header
// row is treated as a target СПП-element column — this is what makes the "wide" target
// file format self-describing instead of relying on a fixed column order.
const KNOWN_ATTRIBUTE_HEADERS = new Set([
  'материал',
  'старый материал',
  'код продукта',
  'название материала',
  'еи',
  'в сап пусто',
])

function normalizeHeaderKey(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export async function parseTarget(
  buffer: ArrayBuffer,
  onProgress?: (current: number, total: number) => void,
  abortState?: AbortState,
): Promise<ParseTargetResult> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch (err) {
    throw new ProcessingError(ERROR_CODES.FILE_READ_FAILED, 'Целевой файл не удалось прочитать как Excel (.xlsx).', {
      technical: err instanceof Error ? err.message : String(err),
    })
  }

  // Multiple target files may exist (one per city); each upload carries exactly one sheet
  // with the actual pivot table. Pick the sheet with the most rows if there's more than one.
  const worksheet = workbook.worksheets.reduce((best, ws) => (ws.rowCount > (best?.rowCount ?? -1) ? ws : best), workbook.worksheets[0])
  if (!worksheet) {
    throw new ProcessingError(ERROR_CODES.SHEET_MISSING, 'Целевой файл не содержит листов с данными.')
  }

  const headerMap = readHeaderMap(worksheet)
  const colMaterial = headerMap.get('материал')
  if (!colMaterial) {
    throw new ProcessingError(ERROR_CODES.COLUMN_NOT_FOUND, 'В целевом файле не найдена колонка «Материал». Проверьте заголовки файла.', {
      context: { file: 'целевой файл', expectedColumn: 'Материал', foundHeaders: Array.from(headerMap.keys()) },
    })
  }
  const colMaterialName = headerMap.get('название материала') ?? null
  const colEmptyInSap = headerMap.get('в сап пусто') ?? null

  const headerRow = worksheet.getRow(1)
  const colCount = Math.max(worksheet.columnCount, headerRow.cellCount)
  const projectColumns: { col: number; name: string }[] = []
  for (let c = 1; c <= colCount; c++) {
    const raw = cellScalar(worksheet, 1, c)
    const name = normalizeText(raw)
    if (!name) continue
    if (KNOWN_ATTRIBUTE_HEADERS.has(normalizeHeaderKey(name))) continue
    projectColumns.push({ col: c, name })
  }
  if (projectColumns.length === 0) {
    throw new ProcessingError(
      ERROR_CODES.NO_PROJECT_COLUMNS,
      'В целевом файле не найдено ни одной колонки-проекта (СПП-элемента) справа от атрибутов материала.',
      { context: { foundHeaders: Array.from(headerMap.keys()) } },
    )
  }

  const warnings: string[] = []
  const requirements: TargetRequirement[] = []
  const emptyInSapHits: number[] = []
  let rawRowCount = 0

  const lastRow = worksheet.rowCount
  const totalRows = Math.max(lastRow - 1, 0)
  for (let r = 2; r <= lastRow; r++) {
    await checkpoint(abortState, r)
    if (r % 500 === 0 || r === lastRow) onProgress?.(r - 1, totalRows)

    const material = normalizeMaterial(cellScalar(worksheet, r, colMaterial))
    if (material === null) continue // real-data-extent detection

    rawRowCount++
    if (rawRowCount > MAX_INPUT_ROWS) {
      throw new ProcessingError(
        ERROR_CODES.ROW_LIMIT_EXCEEDED,
        `Целевой файл содержит более ${MAX_INPUT_ROWS.toLocaleString('ru-RU')} заполненных строк материалов. ` +
          `Разбейте файл на части не более ${MAX_INPUT_ROWS.toLocaleString('ru-RU')} строк и загрузите по очереди.`,
        { context: { limit: MAX_INPUT_ROWS, atRow: r } },
      )
    }

    const materialName = colMaterialName ? normalizeText(cellScalar(worksheet, r, colMaterialName)) || null : null

    if (colEmptyInSap !== null) {
      const v = cellScalar(worksheet, r, colEmptyInSap)
      if (v !== null && v !== undefined && String(v).trim() !== '') emptyInSapHits.push(r)
    }

    for (const { col, name } of projectColumns) {
      const quantity = toPositiveQuantity(cellScalar(worksheet, r, col))
      if (quantity === null) continue // empty / zero / non-numeric cell — no requirement here
      requirements.push({ material, materialName, targetSpp: name, quantity, sourceRow: r })
    }
  }
  onProgress?.(totalRows, totalRows)

  if (rawRowCount === 0) {
    warnings.push('В целевом файле не найдено ни одной заполненной строки (по колонке «Материал»).')
  }
  if (emptyInSapHits.length > 0) {
    const sample = emptyInSapHits.slice(0, 10).join(', ')
    warnings.push(
      `Колонка «в САП пусто» не пуста в ${emptyInSapHits.length} строках (например: ${sample}) — ` +
        `эти значения игнорируются программой. Проверьте, не должны ли они быть отдельным целевым СПП.`,
    )
  }

  return { requirements, warnings, rawRowCount, projectColumns: projectColumns.map((p) => p.name) }
}
