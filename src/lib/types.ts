export const MAX_INPUT_ROWS = 50_000

export interface Mb52Lot {
  material: string
  batch: string
  sourceSpp: string
  plant: string
  storageLocation: string
  specialStock: string
  costCenter: string | null
  quantity: number
  /** Available quantity remaining after allocation mutates the pool. */
  remaining: number
  /** Row order of first occurrence in the source file — deterministic FIFO tie-break. */
  rowOrder: number
}

export interface TargetRequirement {
  material: string
  materialName: string | null
  targetSpp: string
  quantity: number
  sourceRow: number
}

export interface TemplateColumnMap {
  sheetName: string
  headers: string[]
  no: number
  materialFrom: number
  plantFrom: number
  storageFrom: number
  batchFrom: number
  specialStockFrom: number
  quantity: number
  costCenter: number
  sppFrom: number
  materialTo: number
  plantTo: number
  storageTo: number
  batchTo: number
  specialStockTo: number
  sppTo: number
}

export interface FillRow {
  no: number
  /** Internal join key (material|targetSpp|sourceRow) back to its ReconciliationEntry — not written to the sheet. */
  reqKey: string
  material: string
  plantFrom: string
  storageFrom: string
  batchFrom: string
  specialStockFrom: string
  quantity: number
  costCenter: string | null
  sppFrom: string
  plantTo: string
  storageTo: string
  batchTo: string
  specialStockTo: string
  sppTo: string
  hasDeficit: boolean
}

export type ReconciliationStatus = 'ok' | 'deficit' | 'manual_review'

export interface ReconciliationEntry {
  /** Internal join key (material|targetSpp|sourceRow) to the FillRow rows this requirement produced. */
  reqKey: string
  material: string
  materialName: string | null
  targetSpp: string
  requiredQuantity: number
  alreadyAtTargetQuantity: number
  transferredQuantity: number
  totalCovered: number
  delta: number
  status: ReconciliationStatus
  comment: string
}

export interface SurplusLot {
  material: string
  batch: string
  sourceSpp: string
  plant: string
  storageLocation: string
  remainingQuantity: number
}

export interface ProcessingSummary {
  requirementCount: number
  totalRequiredQuantity: number
  totalAlreadyAtTargetQuantity: number
  totalTransferredQuantity: number
  deficitCount: number
  deficitQuantity: number
  surplusLotCount: number
  surplusQuantity: number
  fillRowCount: number
  generatedAt: string
}

export interface ProcessingResult {
  fillRows: FillRow[]
  reconciliation: ReconciliationEntry[]
  surplusLots: SurplusLot[]
  summary: ProcessingSummary
  warnings: string[]
}

export interface ProcessingInput {
  mb52ArrayBuffer: ArrayBuffer
  targetArrayBuffer: ArrayBuffer
  templateArrayBuffer: ArrayBuffer
}

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
  /** Rows/items processed so far within this stage, if known upfront. */
  current?: number
  /** Total rows/items expected in this stage, if known upfront. */
  total?: number
  /** 0-100, weighted across all stages — what the UI's single progress bar shows. */
  overallPercent: number
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  runId: string
  ts: string
  level: LogLevel
  stage: ProgressStage | 'system'
  code?: string
  message: string
  technical?: string
  context?: Record<string, unknown>
}

export type RunStatus = 'running' | 'success' | 'error' | 'aborted'

export interface RunRecord {
  id: string
  startedAt: string
  finishedAt: string | null
  status: RunStatus
  mb52FileName: string | null
  targetFileName: string | null
  summary: ProcessingSummary | null
  errorCode: string | null
  errorMessage: string | null
}
