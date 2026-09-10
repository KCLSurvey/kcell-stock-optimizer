import type { LogEntry, ProcessingSummary, RunStatus, RunRecord } from './types'

const DB_NAME = 'kcell-stock-optimizer-logs'
const DB_VERSION = 1
const RUNS_STORE = 'runs'
const LOGS_STORE = 'logs'
const MAX_RUNS = 200

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(RUNS_STORE)) {
        db.createObjectStore(RUNS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(LOGS_STORE)) {
        const logs = db.createObjectStore(LOGS_STORE, { keyPath: 'id' })
        logs.createIndex('runId', 'runId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction, setResult: (r: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode)
    let result: T = undefined as T
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    fn(t, (r) => {
      result = r
    })
  })
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function createRun(meta: { mb52FileName: string | null; targetFileName: string | null }): Promise<string> {
  const db = await openDb()
  const id = genId()
  const record: RunRecord = {
    id,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    mb52FileName: meta.mb52FileName,
    targetFileName: meta.targetFileName,
    summary: null,
    errorCode: null,
    errorMessage: null,
  }
  await tx(db, [RUNS_STORE], 'readwrite', (t) => {
    t.objectStore(RUNS_STORE).put(record)
  })
  db.close()
  return id
}

export async function appendLog(runId: string, entry: Omit<LogEntry, 'id' | 'runId'>): Promise<void> {
  const db = await openDb()
  const full: LogEntry = { ...entry, id: genId(), runId }
  await tx(db, [LOGS_STORE], 'readwrite', (t) => {
    t.objectStore(LOGS_STORE).put(full)
  })
  db.close()
}

export async function finishRun(
  runId: string,
  status: RunStatus,
  opts?: { summary?: ProcessingSummary; errorCode?: string; errorMessage?: string },
): Promise<void> {
  const db = await openDb()
  await tx(db, [RUNS_STORE], 'readwrite', (t) => {
    const store = t.objectStore(RUNS_STORE)
    const getReq = store.get(runId)
    getReq.onsuccess = () => {
      const record = getReq.result as RunRecord | undefined
      if (!record) return
      record.status = status
      record.finishedAt = new Date().toISOString()
      record.summary = opts?.summary ?? null
      record.errorCode = opts?.errorCode ?? null
      record.errorMessage = opts?.errorMessage ?? null
      store.put(record)
    }
  })
  db.close()
  await pruneOldRuns()
}

export async function listRuns(): Promise<RunRecord[]> {
  const db = await openDb()
  const runs = await tx<RunRecord[]>(db, [RUNS_STORE], 'readonly', (t, setResult) => {
    const req = t.objectStore(RUNS_STORE).getAll()
    req.onsuccess = () => setResult(req.result)
  })
  db.close()
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export async function getRunLogs(runId: string): Promise<LogEntry[]> {
  const db = await openDb()
  const logs = await tx<LogEntry[]>(db, [LOGS_STORE], 'readonly', (t, setResult) => {
    const req = t.objectStore(LOGS_STORE).index('runId').getAll(runId)
    req.onsuccess = () => setResult(req.result)
  })
  db.close()
  return logs.sort((a, b) => a.ts.localeCompare(b.ts))
}

async function pruneOldRuns(): Promise<void> {
  const runs = await listRuns()
  if (runs.length <= MAX_RUNS) return
  const toRemove = runs.slice(MAX_RUNS)
  const db = await openDb()
  await tx(db, [RUNS_STORE, LOGS_STORE], 'readwrite', (t) => {
    const runsStore = t.objectStore(RUNS_STORE)
    const logsStore = t.objectStore(LOGS_STORE)
    const logsIndex = logsStore.index('runId')
    for (const r of toRemove) {
      runsStore.delete(r.id)
      const cursorReq = logsIndex.openCursor(IDBKeyRange.only(r.id))
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          logsStore.delete(cursor.primaryKey)
          cursor.continue()
        }
      }
    }
  })
  db.close()
}

export async function exportAllLogsAsJson(): Promise<string> {
  const runs = await listRuns()
  const db = await openDb()
  const logs = await tx<LogEntry[]>(db, [LOGS_STORE], 'readonly', (t, setResult) => {
    const req = t.objectStore(LOGS_STORE).getAll()
    req.onsuccess = () => setResult(req.result)
  })
  db.close()
  logs.sort((a, b) => a.ts.localeCompare(b.ts))

  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'kcell-stock-optimizer',
    note:
      'Структурированный журнал обработки. "runs" — сводка по каждому запуску, "logs" — детальные события ' +
      '(info/warn/error) по каждому запуску (поле runId). Пришлите этот файл целиком для диагностики.',
    runs,
    logs,
  }
  return JSON.stringify(payload, null, 2)
}

export async function clearAllLogs(): Promise<void> {
  const db = await openDb()
  await tx(db, [RUNS_STORE, LOGS_STORE], 'readwrite', (t) => {
    t.objectStore(RUNS_STORE).clear()
    t.objectStore(LOGS_STORE).clear()
  })
  db.close()
}
