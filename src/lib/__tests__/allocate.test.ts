import { describe, expect, it } from 'vitest'
import { allocate } from '../allocate'
import type { Mb52Lot, TargetRequirement } from '../types'

let rowOrder = 0
function lot(overrides: Partial<Mb52Lot> & { material: string; batch: string; sourceSpp: string; quantity: number }): Mb52Lot {
  return {
    plant: '2180',
    storageLocation: '1000',
    specialStock: 'Q',
    costCenter: null,
    remaining: overrides.quantity,
    rowOrder: rowOrder++,
    ...overrides,
  }
}

function req(material: string, targetSpp: string, quantity: number, sourceRow = 0): TargetRequirement {
  return { material, materialName: null, targetSpp, quantity, sourceRow }
}

describe('allocate — FIFO batch consumption', () => {
  it('fully consumes the oldest batch before touching a newer one', async () => {
    const lots = [
      lot({ material: 'M1', batch: '0000000100', sourceSpp: 'A', quantity: 5 }),
      lot({ material: 'M1', batch: '0000000200', sourceSpp: 'A', quantity: 20 }),
    ]
    const { fillRows, reconciliation } = await allocate(lots, [req('M1', 'B', 12)])

    expect(reconciliation[0].status).toBe('ok')
    expect(fillRows).toHaveLength(2)
    expect(fillRows[0].batchFrom).toBe('0000000100')
    expect(fillRows[0].quantity).toBe(5)
    expect(fillRows[1].batchFrom).toBe('0000000200')
    expect(fillRows[1].quantity).toBe(7) // partial — only the last lot touched is split
    expect(lots[1].remaining).toBe(13) // 20 - 7 left as surplus
  })

  it('never fragments more batches than necessary (uses one full batch, not two partial ones)', async () => {
    const lots = [
      lot({ material: 'M1', batch: '0000000100', sourceSpp: 'A', quantity: 10 }),
      lot({ material: 'M1', batch: '0000000200', sourceSpp: 'A', quantity: 10 }),
    ]
    const { fillRows } = await allocate(lots, [req('M1', 'B', 10)])
    expect(fillRows).toHaveLength(1)
    expect(fillRows[0].batchFrom).toBe('0000000100')
    expect(fillRows[0].quantity).toBe(10)
  })
})

describe('allocate — same batch number on different source SPP', () => {
  it('treats them as two independent lots, not one merged pool', async () => {
    const lots = [
      lot({ material: 'M1', batch: '0000417412', sourceSpp: 'B2026.425.EXT', quantity: 2 }),
      lot({ material: 'M1', batch: '0000417412', sourceSpp: 'B9999.001.UND', quantity: 2 }),
    ]
    const { fillRows, reconciliation } = await allocate(lots, [req('M1', 'TARGET', 4)])
    expect(reconciliation[0].status).toBe('ok')
    expect(fillRows).toHaveLength(2)
    const spps = fillRows.map((r) => r.sppFrom).sort()
    expect(spps).toEqual(['B2026.425.EXT', 'B9999.001.UND'])
  })
})

describe('allocate — already at target (no-op transfer)', () => {
  it('does not generate a fill row when stock already sits at the target СПП', async () => {
    const lots = [lot({ material: 'M1', batch: '0000000100', sourceSpp: 'TARGET', quantity: 5 })]
    const { fillRows, reconciliation } = await allocate(lots, [req('M1', 'TARGET', 5)])
    expect(fillRows).toHaveLength(0)
    expect(reconciliation[0].alreadyAtTargetQuantity).toBe(5)
    expect(reconciliation[0].status).toBe('ok')
    expect(reconciliation[0].comment).toMatch(/не требуется/)
  })

  it('only consumes the already-at-target lot for the amount actually needed, leaving the rest as surplus', async () => {
    const lots = [lot({ material: 'M1', batch: '0000000100', sourceSpp: 'TARGET', quantity: 8 })]
    const { reconciliation, surplusLots } = await allocate(lots, [req('M1', 'TARGET', 5)])
    expect(reconciliation[0].alreadyAtTargetQuantity).toBe(5)
    expect(surplusLots).toHaveLength(1)
    expect(surplusLots[0].remainingQuantity).toBe(3)
  })

  it('still draws other lots via transfer when the already-at-target lot is insufficient', async () => {
    const lots = [
      lot({ material: 'M1', batch: '0000000100', sourceSpp: 'TARGET', quantity: 2 }),
      lot({ material: 'M1', batch: '0000000200', sourceSpp: 'ELSEWHERE', quantity: 10 }),
    ]
    const { fillRows, reconciliation } = await allocate(lots, [req('M1', 'TARGET', 5)])
    expect(reconciliation[0].alreadyAtTargetQuantity).toBe(2)
    expect(reconciliation[0].transferredQuantity).toBe(3)
    expect(fillRows).toHaveLength(1)
    expect(fillRows[0].sppFrom).toBe('ELSEWHERE')
    expect(fillRows[0].quantity).toBe(3)
  })
})

describe('allocate — deficit', () => {
  it('transfers everything available and flags the shortfall as critical', async () => {
    const lots = [lot({ material: 'M1', batch: '0000000100', sourceSpp: 'A', quantity: 3 })]
    const { fillRows, reconciliation } = await allocate(lots, [req('M1', 'B', 10)])
    expect(fillRows).toHaveLength(1)
    expect(fillRows[0].quantity).toBe(3)
    expect(fillRows[0].hasDeficit).toBe(true)
    expect(reconciliation[0].status).toBe('deficit')
    expect(reconciliation[0].delta).toBe(-7)
    expect(reconciliation[0].comment).toMatch(/Критично/)
  })

  it('flags a total absence of stock as critical with zero coverage', async () => {
    const { fillRows, reconciliation } = await allocate([], [req('GHOST', 'B', 4)])
    expect(fillRows).toHaveLength(0)
    expect(reconciliation[0].status).toBe('deficit')
    expect(reconciliation[0].totalCovered).toBe(0)
  })
})

describe('allocate — shared pool across requirements', () => {
  it('reduces availability for a later requirement on the same material', async () => {
    const lots = [lot({ material: 'M1', batch: '0000000100', sourceSpp: 'A', quantity: 10 })]
    const requirements = [req('M1', 'X', 7), req('M1', 'Y', 5)]
    const { reconciliation } = await allocate(lots, requirements)
    expect(reconciliation[0].status).toBe('ok')
    expect(reconciliation[0].transferredQuantity).toBe(7)
    expect(reconciliation[1].status).toBe('deficit')
    expect(reconciliation[1].totalCovered).toBe(3) // only 3 left after the first requirement
  })

  it('leaves unused stock as surplus once every requirement is processed', async () => {
    const lots = [lot({ material: 'M1', batch: '0000000100', sourceSpp: 'A', quantity: 10 })]
    const { surplusLots } = await allocate(lots, [req('M1', 'X', 4)])
    expect(surplusLots).toHaveLength(1)
    expect(surplusLots[0].remainingQuantity).toBe(6)
  })
})
