import type { FillRow, Mb52Lot, ReconciliationEntry, SurplusLot, TargetRequirement } from './types'
import { checkpoint, type AbortState } from './cooperative'

function compareBatch(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const na = BigInt(a)
    const nb = BigInt(b)
    if (na < nb) return -1
    if (na > nb) return 1
    return 0
  }
  return a.localeCompare(b)
}

export interface AllocationResult {
  fillRows: Omit<FillRow, 'no'>[]
  reconciliation: ReconciliationEntry[]
  surplusLots: SurplusLot[]
}

/**
 * Core allocation algorithm (spec v1.3):
 *  1. Stock already sitting at the requirement's own target СПП never gets a transfer
 *     row — it's consumed first ("already at target") and simply reduces remaining need.
 *  2. Remaining need is filled by fully consuming lots in ascending batch order (FIFO),
 *     tie-broken by original row order in MB52 — never fragmenting a batch that a
 *     smaller number of fuller batches could cover.
 *  3. Any requirement quantity left unmet after exhausting all lots for that material
 *     is a critical deficit; the available part is still transferred.
 *  4. Lots left with remaining stock after every requirement has been processed are
 *     surplus — not needed anywhere in this target file.
 *
 * Requirements are processed in the order they were unpivoted from the target file
 * (row-major, then column-major), since the lot pool is shared and mutated across
 * requirements for the same material — processing order is a deliberate, documented
 * assumption (see spec v1.3, "Единица запуска").
 */
export async function allocate(
  lots: Mb52Lot[],
  requirements: TargetRequirement[],
  onProgress?: (current: number, total: number) => void,
  abortState?: AbortState,
): Promise<AllocationResult> {
  const lotsByMaterial = new Map<string, Mb52Lot[]>()
  for (const lot of lots) {
    const arr = lotsByMaterial.get(lot.material)
    if (arr) arr.push(lot)
    else lotsByMaterial.set(lot.material, [lot])
  }

  const fillRows: Omit<FillRow, 'no'>[] = []
  const reconciliation: ReconciliationEntry[] = []

  let i = 0
  for (const req of requirements) {
    await checkpoint(abortState, i, 200)
    if (i % 200 === 0 || i === requirements.length - 1) onProgress?.(i, requirements.length)
    i++
    const reqKey = `${req.material}|${req.targetSpp}|${req.sourceRow}`
    const materialLots = lotsByMaterial.get(req.material) ?? []

    const sameSpp = materialLots
      .filter((l) => l.remaining > 0 && l.sourceSpp === req.targetSpp)
      .sort((a, b) => compareBatch(a.batch, b.batch))
    const otherLots = materialLots
      .filter((l) => l.remaining > 0 && l.sourceSpp !== req.targetSpp)
      .sort((a, b) => compareBatch(a.batch, b.batch) || a.rowOrder - b.rowOrder)

    let remaining = req.quantity
    let alreadyAtTarget = 0
    let transferred = 0
    const reqFillRows: Omit<FillRow, 'no' | 'hasDeficit'>[] = []

    for (const lot of sameSpp) {
      if (remaining <= 0) break
      const use = Math.min(lot.remaining, remaining)
      if (use <= 0) continue
      lot.remaining -= use
      remaining -= use
      alreadyAtTarget += use
    }

    for (const lot of otherLots) {
      if (remaining <= 0) break
      const use = Math.min(lot.remaining, remaining)
      if (use <= 0) continue
      lot.remaining -= use
      remaining -= use
      transferred += use
      reqFillRows.push({
        reqKey,
        material: req.material,
        plantFrom: lot.plant,
        storageFrom: lot.storageLocation,
        batchFrom: lot.batch,
        specialStockFrom: lot.specialStock,
        quantity: use,
        costCenter: lot.costCenter,
        sppFrom: lot.sourceSpp,
        plantTo: lot.plant,
        storageTo: lot.storageLocation,
        batchTo: lot.batch,
        specialStockTo: lot.specialStock,
        sppTo: req.targetSpp,
      })
    }

    const totalCovered = alreadyAtTarget + transferred
    const deficit = req.quantity - totalCovered
    const hasDeficit = deficit > 0

    for (const row of reqFillRows) fillRows.push({ ...row, hasDeficit })

    let comment: string
    if (!hasDeficit && alreadyAtTarget > 0 && transferred > 0) {
      comment = 'Закрыто полностью: часть уже на целевом СПП, часть перенесена из других СПП.'
    } else if (!hasDeficit && alreadyAtTarget > 0 && transferred === 0) {
      comment = 'Уже полностью в наличии на целевом СПП — перенос не требуется.'
    } else if (!hasDeficit) {
      comment = 'Закрыто полностью переносом из MB52.'
    } else if (totalCovered > 0) {
      comment = `Критично: не хватает ${deficit} шт. из ${req.quantity} (в наличии по всем партиям только ${totalCovered}).`
    } else {
      comment = `Критично: остатков по данному материалу нет вообще (требуется ${req.quantity}).`
    }

    reconciliation.push({
      reqKey,
      material: req.material,
      materialName: req.materialName,
      targetSpp: req.targetSpp,
      requiredQuantity: req.quantity,
      alreadyAtTargetQuantity: alreadyAtTarget,
      transferredQuantity: transferred,
      totalCovered,
      delta: totalCovered - req.quantity,
      status: hasDeficit ? 'deficit' : 'ok',
      comment,
    })
  }
  onProgress?.(requirements.length, requirements.length)

  const surplusLots: SurplusLot[] = lots
    .filter((l) => l.remaining > 0)
    .map((l) => ({
      material: l.material,
      batch: l.batch,
      sourceSpp: l.sourceSpp,
      plant: l.plant,
      storageLocation: l.storageLocation,
      remainingQuantity: l.remaining,
    }))

  return { fillRows, reconciliation, surplusLots }
}

/**
 * Assigns final row numbers, grouping deficit-affected rows first so the exported
 * "Материалы" sheet surfaces problem positions before fully-closed ones (spec §7),
 * while preserving generation order within each group (stable sort).
 */
export function finalizeFillRows(rows: Omit<FillRow, 'no'>[]): FillRow[] {
  const sorted = [...rows].sort((a, b) => Number(b.hasDeficit) - Number(a.hasDeficit))
  return sorted.map((row, i) => ({ ...row, no: i + 1 }))
}
