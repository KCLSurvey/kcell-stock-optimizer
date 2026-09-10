export interface NormalizeWarning {
  message: string
}

/** Canonical string form of a SAP material code. Numbers are truncated to integer text; strings are trimmed as-is (preserves any leading zeros). */
export function normalizeMaterial(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return String(Math.trunc(value))
  }
  const s = String(value).trim()
  return s === '' ? null : s
}

/** Canonical text form of a batch number. Leading zeros must be preserved — batches are never numeric in SAP. */
export function normalizeBatch(value: unknown, warnings?: NormalizeWarning[]): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    warnings?.push({
      message: `Партия хранится как число (${value}) — возможна потеря ведущих нулей. Проверьте исходный файл.`,
    })
    if (!Number.isFinite(value)) return null
    return String(Math.trunc(value))
  }
  const s = String(value).trim()
  return s === '' ? null : s
}

/** Generic trimmed-text normalizer for plant/storage/special-stock/SPP-element fields. */
export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function normalizeOptionalText(value: unknown): string | null {
  const s = normalizeText(value)
  return s === '' ? null : s
}

/** Parses a quantity cell. Returns null for empty/non-numeric/non-positive cells (callers decide how to treat null). */
export function toPositiveQuantity(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

export function lotKey(parts: {
  material: string
  batch: string
  sourceSpp: string
  plant: string
  storageLocation: string
  specialStock: string
}): string {
  return [parts.material, parts.batch, parts.sourceSpp, parts.plant, parts.storageLocation, parts.specialStock].join(
    '',
  )
}
