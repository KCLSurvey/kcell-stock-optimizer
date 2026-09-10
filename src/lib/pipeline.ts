import { allocate, finalizeFillRows } from './allocate'
import { buildOutputWorkbook } from './buildOutput'
import type { AbortState } from './cooperative'
import { parseMb52 } from './parseMb52'
import { parseTarget } from './parseTarget'
import { parseTemplate } from './parseTemplate'
import type { ProcessingInput, ProcessingResult, ProgressEvent, ProgressStage, RunLogEntry } from './types'

// How much of the single overall progress bar each stage owns. Must sum to 100.
const STAGE_WEIGHTS: Record<ProgressStage, number> = {
  parsing_mb52: 30,
  parsing_target: 25,
  parsing_template: 5,
  allocating: 25,
  building_output: 15,
  done: 0,
}
const STAGE_ORDER: ProgressStage[] = ['parsing_mb52', 'parsing_target', 'parsing_template', 'allocating', 'building_output']

function stageStartPercent(stage: ProgressStage): number {
  let acc = 0
  for (const s of STAGE_ORDER) {
    if (s === stage) return acc
    acc += STAGE_WEIGHTS[s]
  }
  return acc
}

export type { ProgressEvent, ProgressStage }

export interface PipelineCallbacks {
  onProgress?: (e: ProgressEvent) => void
}

export interface PipelineOutput {
  result: ProcessingResult
  outputArrayBuffer: ArrayBuffer
}

function report(cb: PipelineCallbacks | undefined, stage: ProgressStage, message: string, current?: number, total?: number) {
  const base = stageStartPercent(stage)
  const weight = STAGE_WEIGHTS[stage]
  const fraction = total && total > 0 ? Math.min(current ?? 0, total) / total : stage === 'done' ? 1 : 0
  const overallPercent = stage === 'done' ? 100 : Math.min(99, Math.round(base + weight * fraction))
  cb?.onProgress?.({ stage, message, current, total, overallPercent })
}

// Coarse milestones (stage start/finish, warnings) — collected here and embedded as a
// sheet in the output file itself, rather than kept anywhere else. Nothing persists this
// in the browser or server-side; it travels only inside the one file the user downloads.
function log(collected: RunLogEntry[], entry: Omit<RunLogEntry, 'ts'>) {
  collected.push({ ...entry, ts: new Date().toISOString() })
}

export async function runPipeline(
  input: ProcessingInput,
  callbacks?: PipelineCallbacks,
  abortState?: AbortState,
): Promise<PipelineOutput> {
  const logEntries: RunLogEntry[] = []

  report(callbacks, 'parsing_mb52', 'Разбор файла остатков MB52…', 0, undefined)
  log(logEntries, { level: 'info', stage: 'parsing_mb52', message: 'Начат разбор файла остатков MB52.' })
  const mb52 = await parseMb52(
    input.mb52ArrayBuffer,
    (current, total) => report(callbacks, 'parsing_mb52', `Разбор MB52: строка ${current} из ${total}…`, current, total),
    abortState,
  )
  log(logEntries, {
    level: 'info',
    stage: 'parsing_mb52',
    message: `MB52 разобран: ${mb52.rawRowCount} заполненных строк → ${mb52.lots.length} партий (лотов).`,
    context: { rawRowCount: mb52.rawRowCount, lotCount: mb52.lots.length, warnings: mb52.warnings.length },
  })
  mb52.warnings.forEach((w) => log(logEntries, { level: 'warn', stage: 'parsing_mb52', message: w }))

  report(callbacks, 'parsing_target', 'Разбор целевого файла…', 0, undefined)
  log(logEntries, { level: 'info', stage: 'parsing_target', message: 'Начат разбор целевого файла.' })
  const target = await parseTarget(
    input.targetArrayBuffer,
    (current, total) => report(callbacks, 'parsing_target', `Разбор целевого файла: строка ${current} из ${total}…`, current, total),
    abortState,
  )
  log(logEntries, {
    level: 'info',
    stage: 'parsing_target',
    message: `Целевой файл разобран: ${target.rawRowCount} строк материалов → ${target.requirements.length} потребностей (материал × СПП).`,
    context: { rawRowCount: target.rawRowCount, requirementCount: target.requirements.length, projectColumns: target.projectColumns },
  })
  target.warnings.forEach((w) => log(logEntries, { level: 'warn', stage: 'parsing_target', message: w }))

  report(callbacks, 'parsing_template', 'Разбор шаблона заливки…', 0, undefined)
  const template = await parseTemplate(input.templateArrayBuffer)
  log(logEntries, { level: 'info', stage: 'parsing_template', message: `Шаблон заливки разобран (лист «${template.sheetName}»).` })

  report(callbacks, 'allocating', 'Распределение партий по потребностям…', 0, target.requirements.length)
  const { fillRows: rawFillRows, reconciliation, surplusLots } = await allocate(
    mb52.lots,
    target.requirements,
    (current, total) => report(callbacks, 'allocating', `Распределение: потребность ${current} из ${total}…`, current, total),
    abortState,
  )
  const fillRows = finalizeFillRows(rawFillRows)
  const deficitCountPreview = reconciliation.filter((r) => r.status === 'deficit').length
  log(logEntries, {
    level: deficitCountPreview > 0 ? 'warn' : 'info',
    stage: 'allocating',
    message: `Распределение завершено: ${fillRows.length} строк заливки, ${deficitCountPreview} позиций с дефицитом, ${surplusLots.length} неиспользованных партий.`,
    context: { fillRowCount: fillRows.length, deficitCount: deficitCountPreview, surplusLotCount: surplusLots.length },
  })

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
    logEntries,
  }

  report(callbacks, 'building_output', 'Формирование итогового файла…', 0, fillRows.length)
  // Logged before the write, not after — this array is embedded as a sheet inside the file
  // itself (see buildLogSheet), so a milestone can only be captured up to the moment the
  // file's own bytes are produced, not the fact of its own completion.
  log(logEntries, { level: 'info', stage: 'building_output', message: 'Начато формирование итогового файла (лист «Лог обработки» — этот).' })
  const outputArrayBuffer = await buildOutputWorkbook(
    template,
    result,
    mb52.lots,
    (current, total) => report(callbacks, 'building_output', `Запись файла: строка ${current} из ${total}…`, current, total),
    abortState,
  )

  report(callbacks, 'done', 'Готово.')
  return { result, outputArrayBuffer }
}
