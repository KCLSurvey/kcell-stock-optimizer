import type ExcelJS from 'exceljs'

function normalizeHeader(s: unknown): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Builds a name -> 1-based column index map from a worksheet's header row.
 * Matching is whitespace/case-insensitive so a shuffled or slightly reformatted
 * header row (real-world exports vary) still resolves correctly.
 */
export function readHeaderMap(worksheet: ExcelJS.Worksheet, headerRowNumber = 1): Map<string, number> {
  const row = worksheet.getRow(headerRowNumber)
  const map = new Map<string, number>()
  const colCount = Math.max(worksheet.columnCount, row.cellCount)
  for (let c = 1; c <= colCount; c++) {
    const raw = row.getCell(c).value
    const key = normalizeHeader(typeof raw === 'object' && raw !== null && 'text' in raw ? (raw as { text: unknown }).text : raw)
    if (key && !map.has(key)) map.set(key, c)
  }
  return map
}

export function requireColumn(map: Map<string, number>, name: string, context: string): number {
  const key = normalizeHeader(name)
  const idx = map.get(key)
  if (!idx) {
    throw new Error(`В файле «${context}» не найдена ожидаемая колонка «${name}». Проверьте заголовки файла.`)
  }
  return idx
}

export function findColumn(map: Map<string, number>, name: string): number | null {
  return map.get(normalizeHeader(name)) ?? null
}

/**
 * Returns every column index whose header matches `name`, in left-to-right order.
 * Needed for the зaливка template, where "Материал" legitimately appears twice
 * (source-side and destination-side) with the exact same header text.
 */
export function findAllColumns(worksheet: ExcelJS.Worksheet, headerRowNumber: number, name: string): number[] {
  const target = normalizeHeader(name)
  const row = worksheet.getRow(headerRowNumber)
  const colCount = Math.max(worksheet.columnCount, row.cellCount)
  const result: number[] = []
  for (let c = 1; c <= colCount; c++) {
    const raw = row.getCell(c).value
    const key = normalizeHeader(typeof raw === 'object' && raw !== null && 'text' in raw ? (raw as { text: unknown }).text : raw)
    if (key === target) result.push(c)
  }
  return result
}

/** Reads a cell's value, unwrapping rich-text / hyperlink / formula-result objects to a plain scalar. */
export function cellScalar(worksheet: ExcelJS.Worksheet, row: number, col: number): unknown {
  const v = worksheet.getRow(row).getCell(col).value
  if (v === null || v === undefined) return null
  if (typeof v === 'object') {
    if ('result' in v) return (v as { result: unknown }).result
    if ('text' in v) return (v as { text: unknown }).text
    if ('richText' in v) {
      return (v as { richText: Array<{ text: string }> }).richText.map((p) => p.text).join('')
    }
  }
  return v
}
