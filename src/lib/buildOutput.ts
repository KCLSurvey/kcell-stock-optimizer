import ExcelJS from 'exceljs'
import { compareBatch } from './allocate'
import type { FillRow, Mb52Lot, ProcessingResult, ReconciliationEntry, RunLogEntry, SurplusLot, TemplateColumnMap } from './types'
import { checkpoint, type AbortState } from './cooperative'

function materialCellValue(material: string): string | number {
  return /^\d+$/.test(material) && material.length <= 15 ? Number(material) : material
}

function writeTextCell(cell: ExcelJS.Cell, value: string) {
  cell.value = value
  cell.numFmt = '@'
}

/** 1-based column index -> Excel column letters (1 -> A, 27 -> AA, ...). */
function colLetter(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    const rem = (x - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    x = Math.floor((x - 1) / 26)
  }
  return s
}

async function buildMaterialySheet(
  workbook: ExcelJS.Workbook,
  map: TemplateColumnMap,
  fillRows: FillRow[],
  onProgress?: (current: number, total: number) => void,
  abortState?: AbortState,
): Promise<Map<string, number[]>> {
  const sheet = workbook.addWorksheet(map.sheetName || 'Материалы')
  map.headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  // fillRows arrives already finalized by allocate.finalizeFillRows(): deficit-affected
  // rows first, then fully-closed rows (spec §7 "отдельно отфильтрованы проблемные позиции").
  const noByReqKey = new Map<string, number[]>()
  for (const row of fillRows) {
    await checkpoint(abortState, row.no, 500)
    if (row.no % 500 === 0) onProgress?.(row.no, fillRows.length)
    const rowIdx = row.no + 1
    const list = noByReqKey.get(row.reqKey)
    if (list) list.push(row.no)
    else noByReqKey.set(row.reqKey, [row.no])

    sheet.getCell(rowIdx, map.no).value = row.no
    sheet.getCell(rowIdx, map.materialFrom).value = materialCellValue(row.material)
    sheet.getCell(rowIdx, map.materialFrom).numFmt = '0'
    sheet.getCell(rowIdx, map.plantFrom).value = row.plantFrom
    sheet.getCell(rowIdx, map.storageFrom).value = row.storageFrom
    writeTextCell(sheet.getCell(rowIdx, map.batchFrom), row.batchFrom)
    sheet.getCell(rowIdx, map.specialStockFrom).value = row.specialStockFrom
    sheet.getCell(rowIdx, map.quantity).value = row.quantity
    sheet.getCell(rowIdx, map.quantity).numFmt = '#,##0'
    sheet.getCell(rowIdx, map.costCenter).value = row.costCenter ?? null
    sheet.getCell(rowIdx, map.sppFrom).value = row.sppFrom
    sheet.getCell(rowIdx, map.materialTo).value = materialCellValue(row.material)
    sheet.getCell(rowIdx, map.materialTo).numFmt = '0'
    sheet.getCell(rowIdx, map.plantTo).value = row.plantTo
    sheet.getCell(rowIdx, map.storageTo).value = row.storageTo
    writeTextCell(sheet.getCell(rowIdx, map.batchTo), row.batchTo)
    sheet.getCell(rowIdx, map.specialStockTo).value = row.specialStockTo
    sheet.getCell(rowIdx, map.sppTo).value = row.sppTo
  }
  onProgress?.(fillRows.length, fillRows.length)

  sheet.columns.forEach((col) => {
    col.width = 16
  })

  return noByReqKey
}

function buildControlSheet(
  workbook: ExcelJS.Workbook,
  reconciliation: ReconciliationEntry[],
  noByReqKey: Map<string, number[]>,
) {
  const sheet = workbook.addWorksheet('Контроль')
  const headers = [
    'Материал',
    'Название материала',
    'Целевой СПП',
    'Требуется',
    'Уже на целевом СПП',
    'Перенесено',
    'Итого закрыто',
    'Дельта',
    'Статус',
    'Строки в "Материалы" (№)',
    'Комментарий',
  ]
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  reconciliation.forEach((entry, i) => {
    const rowIdx = i + 2
    const rows = noByReqKey.get(entry.reqKey) ?? []
    sheet.getCell(rowIdx, 1).value = materialCellValue(entry.material)
    sheet.getCell(rowIdx, 1).numFmt = '0'
    sheet.getCell(rowIdx, 2).value = entry.materialName ?? ''
    sheet.getCell(rowIdx, 3).value = entry.targetSpp
    sheet.getCell(rowIdx, 4).value = entry.requiredQuantity
    sheet.getCell(rowIdx, 5).value = entry.alreadyAtTargetQuantity
    sheet.getCell(rowIdx, 6).value = entry.transferredQuantity
    sheet.getCell(rowIdx, 7).value = entry.totalCovered
    sheet.getCell(rowIdx, 8).value = entry.delta
    sheet.getCell(rowIdx, 9).value = entry.status === 'deficit' ? 'КРИТИЧНО: дефицит' : 'OK'
    sheet.getCell(rowIdx, 10).value = rows.join(', ')
    sheet.getCell(rowIdx, 11).value = entry.comment

    if (entry.status === 'deficit') {
      for (let c = 1; c <= headers.length; c++) {
        sheet.getCell(rowIdx, c).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFDE2E2' },
        }
      }
    }
  })

  sheet.columns.forEach((col) => {
    col.width = 18
  })
}

function buildSurplusSheet(workbook: ExcelJS.Workbook, surplusLots: SurplusLot[]) {
  const sheet = workbook.addWorksheet('Излишки')
  const headers = ['Материал', 'Партия', 'СПП-источник', 'Завод', 'Склад', 'Остаток без переноса']
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  surplusLots.forEach((lot, i) => {
    const rowIdx = i + 2
    sheet.getCell(rowIdx, 1).value = materialCellValue(lot.material)
    sheet.getCell(rowIdx, 1).numFmt = '0'
    writeTextCell(sheet.getCell(rowIdx, 2), lot.batch)
    sheet.getCell(rowIdx, 3).value = lot.sourceSpp
    sheet.getCell(rowIdx, 4).value = lot.plant
    sheet.getCell(rowIdx, 5).value = lot.storageLocation
    sheet.getCell(rowIdx, 6).value = lot.remainingQuantity
  })

  sheet.columns.forEach((col) => {
    col.width = 18
  })
}

const MB52_RAW_SHEET_NAME = 'MB52 остатки'

interface RawSheetRef {
  lastRow: number // last row with data (>= 2 even when empty, so ranges never go backwards)
  colMaterial: number
  colBatch: number
  colQuantity: number
}

/** Embeds the parsed MB52 lots (original available quantity, not post-allocation remainder) as plain data — the ground truth the control sheets' formulas reference. */
function buildMb52RawSheet(workbook: ExcelJS.Workbook, lots: Mb52Lot[]): RawSheetRef {
  const sheet = workbook.addWorksheet(MB52_RAW_SHEET_NAME)
  const headers = ['Материал', 'Партия', 'Завод', 'Склад', 'Особый запас', 'СПП-элемент', 'Количество доступно']
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  lots.forEach((lot, i) => {
    const r = i + 2
    sheet.getCell(r, 1).value = materialCellValue(lot.material)
    sheet.getCell(r, 1).numFmt = '0'
    writeTextCell(sheet.getCell(r, 2), lot.batch)
    sheet.getCell(r, 3).value = lot.plant
    sheet.getCell(r, 4).value = lot.storageLocation
    sheet.getCell(r, 5).value = lot.specialStock
    sheet.getCell(r, 6).value = lot.sourceSpp
    sheet.getCell(r, 7).value = lot.quantity
    sheet.getCell(r, 7).numFmt = '#,##0'
  })

  sheet.columns.forEach((col) => {
    col.width = 18
  })

  return { lastRow: Math.max(lots.length + 1, 2), colMaterial: 1, colBatch: 2, colQuantity: 7 }
}

function statusFormula(deltaRef: string): string {
  return `IF(${deltaRef}<0,"ОШИБКА — использовано больше, чем доступно",IF(${deltaRef}=0,"Полностью использовано","Остаток"))`
}

/**
 * Материал + Партия control: for every combination that appears in MB52 OR in the
 * заливка output (the union — so a batch the code invented, which should be
 * structurally impossible but is exactly the kind of bug this sheet exists to catch,
 * still shows up with "Доступно = 0"), compares available vs used via live SUMIFS
 * formulas against the embedded raw sheets — never a value this code precomputed.
 */
function buildBatchControlSheet(
  workbook: ExcelJS.Workbook,
  lots: Mb52Lot[],
  fillRows: FillRow[],
  map: TemplateColumnMap,
  mb52Ref: RawSheetRef,
  materialyLastRow: number,
) {
  const keys = new Map<string, { material: string; batch: string }>()
  for (const lot of lots) keys.set(`${lot.material}${lot.batch}`, { material: lot.material, batch: lot.batch })
  for (const row of fillRows) keys.set(`${row.material}${row.batchFrom}`, { material: row.material, batch: row.batchFrom })
  const sorted = Array.from(keys.values()).sort(
    (a, b) => a.material.localeCompare(b.material) || compareBatch(a.batch, b.batch),
  )

  const sheet = workbook.addWorksheet('Контроль партий')
  const headers = ['Материал', 'Партия', 'Доступно в MB52', 'Использовано в заливке', 'Разница', 'Статус']
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  const mb52Mat = `'${MB52_RAW_SHEET_NAME}'!$${colLetter(mb52Ref.colMaterial)}$2:$${colLetter(mb52Ref.colMaterial)}$${mb52Ref.lastRow}`
  const mb52Batch = `'${MB52_RAW_SHEET_NAME}'!$${colLetter(mb52Ref.colBatch)}$2:$${colLetter(mb52Ref.colBatch)}$${mb52Ref.lastRow}`
  const mb52Qty = `'${MB52_RAW_SHEET_NAME}'!$${colLetter(mb52Ref.colQuantity)}$2:$${colLetter(mb52Ref.colQuantity)}$${mb52Ref.lastRow}`
  const matSheet = `'${map.sheetName || 'Материалы'}'`
  const matMat = `${matSheet}!$${colLetter(map.materialFrom)}$2:$${colLetter(map.materialFrom)}$${materialyLastRow}`
  const matBatch = `${matSheet}!$${colLetter(map.batchFrom)}$2:$${colLetter(map.batchFrom)}$${materialyLastRow}`
  const matQty = `${matSheet}!$${colLetter(map.quantity)}$2:$${colLetter(map.quantity)}$${materialyLastRow}`

  sorted.forEach((key, i) => {
    const r = i + 2
    sheet.getCell(r, 1).value = materialCellValue(key.material)
    sheet.getCell(r, 1).numFmt = '0'
    writeTextCell(sheet.getCell(r, 2), key.batch)
    sheet.getCell(r, 3).value = { formula: `SUMIFS(${mb52Qty},${mb52Mat},$A${r},${mb52Batch},$B${r})` } as ExcelJS.CellFormulaValue
    sheet.getCell(r, 4).value = { formula: `SUMIFS(${matQty},${matMat},$A${r},${matBatch},$B${r})` } as ExcelJS.CellFormulaValue
    sheet.getCell(r, 5).value = { formula: `C${r}-D${r}` } as ExcelJS.CellFormulaValue
    sheet.getCell(r, 6).value = { formula: statusFormula(`E${r}`) } as ExcelJS.CellFormulaValue
    ;[3, 4, 5].forEach((c) => (sheet.getCell(r, c).numFmt = '#,##0'))
  })

  sheet.columns.forEach((col) => {
    col.width = 20
  })
}

/** Same idea as buildBatchControlSheet, one level up: totals by Материал alone, ignoring Партия. */
function buildMaterialControlSheet(
  workbook: ExcelJS.Workbook,
  lots: Mb52Lot[],
  fillRows: FillRow[],
  map: TemplateColumnMap,
  mb52Ref: RawSheetRef,
  materialyLastRow: number,
) {
  const materials = new Set<string>()
  for (const lot of lots) materials.add(lot.material)
  for (const row of fillRows) materials.add(row.material)
  const sorted = Array.from(materials).sort((a, b) => a.localeCompare(b))

  const sheet = workbook.addWorksheet('Контроль материал')
  const headers = ['Материал', 'Доступно всего в MB52', 'Использовано всего в заливке', 'Разница', 'Статус']
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  const mb52Mat = `'${MB52_RAW_SHEET_NAME}'!$${colLetter(mb52Ref.colMaterial)}$2:$${colLetter(mb52Ref.colMaterial)}$${mb52Ref.lastRow}`
  const mb52Qty = `'${MB52_RAW_SHEET_NAME}'!$${colLetter(mb52Ref.colQuantity)}$2:$${colLetter(mb52Ref.colQuantity)}$${mb52Ref.lastRow}`
  const matSheet = `'${map.sheetName || 'Материалы'}'`
  const matMat = `${matSheet}!$${colLetter(map.materialFrom)}$2:$${colLetter(map.materialFrom)}$${materialyLastRow}`
  const matQty = `${matSheet}!$${colLetter(map.quantity)}$2:$${colLetter(map.quantity)}$${materialyLastRow}`

  sorted.forEach((material, i) => {
    const r = i + 2
    sheet.getCell(r, 1).value = materialCellValue(material)
    sheet.getCell(r, 1).numFmt = '0'
    sheet.getCell(r, 2).value = { formula: `SUMIF(${mb52Mat},$A${r},${mb52Qty})` } as ExcelJS.CellFormulaValue
    sheet.getCell(r, 3).value = { formula: `SUMIF(${matMat},$A${r},${matQty})` } as ExcelJS.CellFormulaValue
    sheet.getCell(r, 4).value = { formula: `B${r}-C${r}` } as ExcelJS.CellFormulaValue
    sheet.getCell(r, 5).value = { formula: statusFormula(`D${r}`) } as ExcelJS.CellFormulaValue
    ;[2, 3, 4].forEach((c) => (sheet.getCell(r, c).numFmt = '#,##0'))
  })

  sheet.columns.forEach((col) => {
    col.width = 22
  })
}

function buildSummarySheet(workbook: ExcelJS.Workbook, result: ProcessingResult) {
  const sheet = workbook.addWorksheet('Итог')
  const s = result.summary
  const rows: [string, string | number][] = [
    ['Сформировано', s.generatedAt],
    ['Всего целевых позиций (материал × СПП)', s.requirementCount],
    ['Требуемое количество, всего', s.totalRequiredQuantity],
    ['Уже на целевом СПП (без переноса), всего', s.totalAlreadyAtTargetQuantity],
    ['Перенесено переносом, всего', s.totalTransferredQuantity],
    ['Строк в листе "Материалы"', s.fillRowCount],
    ['Позиций с дефицитом (критично)', s.deficitCount],
    ['Недостающее количество, всего', s.deficitQuantity],
    ['Неиспользованных партий (излишки)', s.surplusLotCount],
    ['Излишек количества, всего', s.surplusQuantity],
    ['Предупреждений при разборе файлов', result.warnings.length],
  ]
  rows.forEach(([label, value], i) => {
    sheet.getCell(i + 1, 1).value = label
    sheet.getCell(i + 1, 1).font = { bold: true }
    sheet.getCell(i + 1, 2).value = value
  })
  sheet.getColumn(1).width = 46
  sheet.getColumn(2).width = 24

  if (result.warnings.length > 0) {
    const startRow = rows.length + 2
    sheet.getCell(startRow, 1).value = 'Предупреждения:'
    sheet.getCell(startRow, 1).font = { bold: true }
    result.warnings.forEach((w, i) => {
      sheet.getCell(startRow + 1 + i, 1).value = w
    })
  }
}

const LEVEL_LABEL: Record<RunLogEntry['level'], string> = {
  info: 'Инфо',
  warn: 'Предупреждение',
  error: 'Ошибка',
}

/**
 * The run's full log trail, embedded as a sheet in the file the user already downloads —
 * this is the only place the log lives; nothing is persisted in the browser or anywhere
 * server-side, so a diagnostic report is just "send me this file" rather than a separate export.
 */
function buildLogSheet(workbook: ExcelJS.Workbook, logEntries: RunLogEntry[]) {
  const sheet = workbook.addWorksheet('Лог обработки')
  const headers = ['Время', 'Уровень', 'Этап', 'Код', 'Сообщение', 'Технические детали']
  headers.forEach((h, i) => {
    sheet.getCell(1, i + 1).value = h
  })
  sheet.getRow(1).font = { bold: true }

  logEntries.forEach((entry, i) => {
    const r = i + 2
    sheet.getCell(r, 1).value = new Date(entry.ts).toLocaleString('ru-RU')
    sheet.getCell(r, 2).value = LEVEL_LABEL[entry.level]
    sheet.getCell(r, 3).value = entry.stage
    sheet.getCell(r, 4).value = entry.code ?? ''
    sheet.getCell(r, 5).value = entry.message
    sheet.getCell(r, 6).value = [entry.technical, entry.context ? JSON.stringify(entry.context) : null]
      .filter(Boolean)
      .join(' ')
    if (entry.level === 'error') {
      for (let c = 1; c <= headers.length; c++) {
        sheet.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E2' } }
      }
    } else if (entry.level === 'warn') {
      for (let c = 1; c <= headers.length; c++) {
        sheet.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6D9' } }
      }
    }
  })

  sheet.getColumn(1).width = 20
  sheet.getColumn(2).width = 16
  sheet.getColumn(3).width = 16
  sheet.getColumn(4).width = 16
  sheet.getColumn(5).width = 60
  sheet.getColumn(6).width = 40
}

export async function buildOutputWorkbook(
  map: TemplateColumnMap,
  result: ProcessingResult,
  lots: Mb52Lot[],
  onProgress?: (current: number, total: number) => void,
  abortState?: AbortState,
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Kcell Stock Optimizer'
  workbook.created = new Date()

  const noByReqKey = await buildMaterialySheet(workbook, map, result.fillRows, onProgress, abortState)
  buildControlSheet(workbook, result.reconciliation, noByReqKey)
  buildSurplusSheet(workbook, result.surplusLots)

  const mb52Ref = buildMb52RawSheet(workbook, lots)
  const materialyLastRow = Math.max(result.fillRows.length + 1, 2)
  buildBatchControlSheet(workbook, lots, result.fillRows, map, mb52Ref, materialyLastRow)
  buildMaterialControlSheet(workbook, lots, result.fillRows, map, mb52Ref, materialyLastRow)

  buildSummarySheet(workbook, result)
  buildLogSheet(workbook, result.logEntries)

  const buffer = await workbook.xlsx.writeBuffer()
  // writeBuffer() can return a Node-style Buffer/Uint8Array view rather than a
  // standalone ArrayBuffer — only a real ArrayBuffer is a transferable postMessage value.
  if (buffer instanceof ArrayBuffer) return buffer
  const view = buffer as Uint8Array
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}
