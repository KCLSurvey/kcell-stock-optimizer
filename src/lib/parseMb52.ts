import ExcelJS from 'exceljs'
import { MAX_INPUT_ROWS, type Mb52Lot } from './types'
import { normalizeBatch, normalizeMaterial, normalizeText, toPositiveQuantity, lotKey } from './normalize'
import { cellScalar, readHeaderMap, requireColumn } from './columnMap'

export interface ParseMb52Result {
  lots: Mb52Lot[]
  warnings: string[]
  rawRowCount: number
}

export async function parseMb52(buffer: ArrayBuffer): Promise<ParseMb52Result> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const worksheet =
    workbook.worksheets.find((ws) => ws.name.trim().toLowerCase() === 'data') ?? workbook.worksheets[0]
  if (!worksheet) throw new Error('Файл остатков MB52 не содержит листов с данными.')

  const headerMap = readHeaderMap(worksheet)
  const colMaterial = requireColumn(headerMap, 'Материал', 'MB52')
  const colPlant = requireColumn(headerMap, 'Завод ИЗ', 'MB52')
  const colStorage = requireColumn(headerMap, 'Склад ИЗ', 'MB52')
  const colBatch = requireColumn(headerMap, 'Партия ИЗ', 'MB52')
  const colSpecial = requireColumn(headerMap, 'Особый запас (например Q) ИЗ', 'MB52')
  const colQuantity = requireColumn(headerMap, 'Количество', 'MB52')
  const colCostCenter = headerMap.get('мвз') ?? null
  const colSpp = requireColumn(headerMap, 'СПП-элемент ИЗ', 'MB52')

  const warnings: string[] = []
  const lotsByKey = new Map<string, Mb52Lot>()
  let rawRowCount = 0
  let rowOrderCounter = 0

  const lastRow = worksheet.rowCount
  for (let r = 2; r <= lastRow; r++) {
    const materialRaw = cellScalar(worksheet, r, colMaterial)
    const material = normalizeMaterial(materialRaw)
    if (material === null) continue // real-data-extent detection: skip padding/blank rows

    rawRowCount++
    if (rawRowCount > MAX_INPUT_ROWS) {
      throw new Error(
        `Файл остатков MB52 содержит более ${MAX_INPUT_ROWS.toLocaleString('ru-RU')} заполненных строк. ` +
          `Разбейте файл на части не более ${MAX_INPUT_ROWS.toLocaleString('ru-RU')} строк и загрузите по очереди.`,
      )
    }

    const batchWarnings: { message: string }[] = []
    const batch = normalizeBatch(cellScalar(worksheet, r, colBatch), batchWarnings)
    batchWarnings.forEach((w) => warnings.push(`MB52, строка ${r}: ${w.message}`))
    const plant = normalizeText(cellScalar(worksheet, r, colPlant))
    const storageLocation = normalizeText(cellScalar(worksheet, r, colStorage))
    const specialStock = normalizeText(cellScalar(worksheet, r, colSpecial))
    const costCenter = colCostCenter ? normalizeText(cellScalar(worksheet, r, colCostCenter)) || null : null
    const sourceSpp = normalizeText(cellScalar(worksheet, r, colSpp))
    const quantity = toPositiveQuantity(cellScalar(worksheet, r, colQuantity))

    if (batch === null) {
      warnings.push(`MB52, строка ${r}: пустая партия — строка пропущена.`)
      continue
    }
    if (!sourceSpp) {
      warnings.push(`MB52, строка ${r}: пустой СПП-элемент — строка пропущена.`)
      continue
    }
    if (quantity === null) {
      warnings.push(`MB52, строка ${r}: некорректное или неположительное количество — строка пропущена.`)
      continue
    }

    const key = lotKey({ material, batch, sourceSpp, plant, storageLocation, specialStock })
    const existing = lotsByKey.get(key)
    if (existing) {
      existing.quantity += quantity
      existing.remaining += quantity
    } else {
      lotsByKey.set(key, {
        material,
        batch,
        sourceSpp,
        plant,
        storageLocation,
        specialStock,
        costCenter,
        quantity,
        remaining: quantity,
        rowOrder: rowOrderCounter++,
      })
    }
  }

  if (rawRowCount === 0) {
    warnings.push('В файле MB52 не найдено ни одной заполненной строки (по колонке «Материал»).')
  }

  return { lots: Array.from(lotsByKey.values()), warnings, rawRowCount }
}
