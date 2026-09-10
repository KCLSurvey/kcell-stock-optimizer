import { allocate, finalizeFillRows } from './allocate'
import { buildOutputWorkbook } from './buildOutput'
import { parseMb52 } from './parseMb52'
import { parseTarget } from './parseTarget'
import { parseTemplate } from './parseTemplate'
import type { ProcessingInput, ProcessingResult } from './types'

export type ProgressStage =
  | 'parsing_mb52'
  | 'parsing_target'
  | 'parsing_template'
  | 'allocating'
  | 'building_output'
  | 'done'

export interface ProgressEvent {
  stage: ProgressStage
  message: string
}

export interface PipelineOutput {
  result: ProcessingResult
  outputArrayBuffer: ArrayBuffer
}

export async function runPipeline(
  input: ProcessingInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<PipelineOutput> {
  onProgress?.({ stage: 'parsing_mb52', message: 'Разбор файла остатков MB52…' })
  const mb52 = await parseMb52(input.mb52ArrayBuffer)

  onProgress?.({ stage: 'parsing_target', message: 'Разбор целевого файла…' })
  const target = await parseTarget(input.targetArrayBuffer)

  onProgress?.({ stage: 'parsing_template', message: 'Разбор шаблона заливки…' })
  const template = await parseTemplate(input.templateArrayBuffer)

  onProgress?.({ stage: 'allocating', message: 'Распределение партий по потребностям…' })
  const { fillRows: rawFillRows, reconciliation, surplusLots } = allocate(mb52.lots, target.requirements)
  const fillRows = finalizeFillRows(rawFillRows)

  const totalRequiredQuantity = target.requirements.reduce((s, r) => s + r.quantity, 0)
  const totalAlreadyAtTargetQuantity = reconciliation.reduce((s, r) => s + r.alreadyAtTargetQuantity, 0)
  const totalTransferredQuantity = reconciliation.reduce((s, r) => s + r.transferredQuantity, 0)
  const deficitEntries = reconciliation.filter((r) => r.status === 'deficit')
  const deficitQuantity = deficitEntries.reduce((s, r) => s + (r.requiredQuantity - r.totalCovered), 0)
  const surplusQuantity = surplusLots.reduce((s, l) => s + l.remainingQuantity, 0)

  const result: ProcessingResult = {
    fillRows,
    reconciliation,
    surplusLots,
    summary: {
      requirementCount: target.requirements.length,
      totalRequiredQuantity,
      totalAlreadyAtTargetQuantity,
      totalTransferredQuantity,
      deficitCount: deficitEntries.length,
      deficitQuantity,
      surplusLotCount: surplusLots.length,
      surplusQuantity,
      fillRowCount: fillRows.length,
      generatedAt: new Date().toISOString(),
    },
    warnings: [...mb52.warnings, ...target.warnings],
  }

  onProgress?.({ stage: 'building_output', message: 'Формирование итогового файла…' })
  const outputArrayBuffer = await buildOutputWorkbook(template, result)

  onProgress?.({ stage: 'done', message: 'Готово.' })
  return { result, outputArrayBuffer }
}
