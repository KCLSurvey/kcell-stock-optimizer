import ExcelJS from 'exceljs'
import type { FillRow, ProcessingResult, ReconciliationEntry, SurplusLot, TemplateColumnMap } from './types'
import { checkpoint, type AbortState } from './cooperative'

function materialCellValue(material: string): string | number {
  return /^\d+$/.test(material) && material.length <= 15 ? Number(material) : material
}

function writeTextCell(cell: ExcelJS.Cell, value: string) {
  cell.value = value
  cell.numFmt = '@'
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

export async function buildOutputWorkbook(
  map: TemplateColumnMap,
  result: ProcessingResult,
  onProgress?: (current: number, total: number) => void,
  abortState?: AbortState,
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Kcell Stock Optimizer'
  workbook.created = new Date()

  const noByReqKey = await buildMaterialySheet(workbook, map, result.fillRows, onProgress, abortState)
  buildControlSheet(workbook, result.reconciliation, noByReqKey)
  buildSurplusSheet(workbook, result.surplusLots)
  buildSummarySheet(workbook, result)

  const buffer = await workbook.xlsx.writeBuffer()
  // writeBuffer() can return a Node-style Buffer/Uint8Array view rather than a
  // standalone ArrayBuffer — only a real ArrayBuffer is a transferable postMessage value.
  if (buffer instanceof ArrayBuffer) return buffer
  const view = buffer as Uint8Array
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
}
