import ExcelJS from 'exceljs'
import type { TemplateColumnMap } from './types'
import { cellScalar, findAllColumns, readHeaderMap, requireColumn } from './columnMap'
import { ERROR_CODES, ProcessingError } from './errors'

export async function parseTemplate(buffer: ArrayBuffer): Promise<TemplateColumnMap> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(buffer)
  } catch (err) {
    throw new ProcessingError(ERROR_CODES.FILE_READ_FAILED, 'Шаблон заливки не удалось прочитать как Excel (.xlsx).', {
      technical: err instanceof Error ? err.message : String(err),
    })
  }

  const worksheet =
    workbook.worksheets.find((ws) => ws.name.trim().toLowerCase() === 'материалы') ?? workbook.worksheets[0]
  if (!worksheet) {
    throw new ProcessingError(ERROR_CODES.SHEET_MISSING, 'Шаблон заливочного файла не содержит листов.')
  }

  const headerMap = readHeaderMap(worksheet)
  const materialCols = findAllColumns(worksheet, 1, 'Материал')
  if (materialCols.length !== 2) {
    throw new ProcessingError(
      ERROR_CODES.TEMPLATE_MATERIAL_COLUMNS,
      `В шаблоне заливки ожидались ровно 2 колонки «Материал» (источник и назначение), найдено ${materialCols.length}. ` +
        'Структура шаблона изменилась — проверьте файл.',
      { context: { foundCount: materialCols.length } },
    )
  }

  const ctx = 'шаблон заливки'
  const map: TemplateColumnMap = {
    sheetName: worksheet.name,
    headers: [],
    no: requireColumn(headerMap, '№', ctx),
    materialFrom: materialCols[0],
    plantFrom: requireColumn(headerMap, 'Завод ИЗ', ctx),
    storageFrom: requireColumn(headerMap, 'Склад ИЗ', ctx),
    batchFrom: requireColumn(headerMap, 'Партия ИЗ', ctx),
    specialStockFrom: requireColumn(headerMap, 'Особый запас (например Q) ИЗ', ctx),
    quantity: requireColumn(headerMap, 'Количество', ctx),
    costCenter: requireColumn(headerMap, 'МВЗ', ctx),
    sppFrom: requireColumn(headerMap, 'СПП-элемент ИЗ', ctx),
    materialTo: materialCols[1],
    plantTo: requireColumn(headerMap, 'Завод В', ctx),
    storageTo: requireColumn(headerMap, 'Склад В', ctx),
    batchTo: requireColumn(headerMap, 'Партия В', ctx),
    specialStockTo: requireColumn(headerMap, 'Особый запас (например Q) В', ctx),
    sppTo: requireColumn(headerMap, 'СПП-элемент В', ctx),
  }

  const maxCol = Math.max(
    map.no,
    map.materialFrom,
    map.plantFrom,
    map.storageFrom,
    map.batchFrom,
    map.specialStockFrom,
    map.quantity,
    map.costCenter,
    map.sppFrom,
    map.materialTo,
    map.plantTo,
    map.storageTo,
    map.batchTo,
    map.specialStockTo,
    map.sppTo,
  )
  const headers: string[] = []
  for (let c = 1; c <= maxCol; c++) {
    headers.push(String(cellScalar(worksheet, 1, c) ?? ''))
  }
  map.headers = headers

  return map
}
