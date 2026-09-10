import { useEffect, useState } from 'react'
import { downloadTextFile } from '../lib/downloadFile'
import { fmtDuration } from '../lib/formatDuration'
import { clearAllLogs, exportAllLogsAsJson, getRunLogs, listRuns } from '../lib/logStore'
import type { LogEntry, RunRecord } from '../lib/types'

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  running: 'выполняется…',
  success: 'успешно',
  error: 'ошибка',
  aborted: 'прервано',
}

function RunRow({ run }: { run: RunRecord }) {
  const [expanded, setExpanded] = useState(false)
  const [entries, setEntries] = useState<LogEntry[] | null>(null)

  async function toggle() {
    if (!expanded && entries === null) {
      setEntries(await getRunLogs(run.id))
    }
    setExpanded((v) => !v)
  }

  const durationMs = run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null

  return (
    <div className={`run-row run-row--${run.status}`}>
      <button className="run-row__head" onClick={toggle}>
        <span className={`run-row__badge run-row__badge--${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <span className="run-row__files">
          {run.mb52FileName ?? '—'} + {run.targetFileName ?? '—'}
        </span>
        <span className="run-row__time">
          {new Date(run.startedAt).toLocaleString('ru-RU')}
          {durationMs !== null && ` · ${fmtDuration(durationMs)}`}
        </span>
        <span className="run-row__chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {run.errorMessage && <div className="run-row__error">{run.errorCode}: {run.errorMessage}</div>}
      {run.summary && (
        <div className="run-row__summary">
          Требовалось {run.summary.totalRequiredQuantity.toLocaleString('ru-RU')} шт., перенесено{' '}
          {run.summary.totalTransferredQuantity.toLocaleString('ru-RU')}, дефицит{' '}
          {run.summary.deficitCount.toLocaleString('ru-RU')} позиций.
        </div>
      )}
      {expanded && entries && (
        <div className="run-row__entries">
          {entries.length === 0 && <div className="run-row__entry-empty">Событий нет.</div>}
          {entries.map((e) => (
            <div key={e.id} className={`log-entry log-entry--${e.level}`}>
              <span className="log-entry__time">{new Date(e.ts).toLocaleTimeString('ru-RU')}</span>
              <span className="log-entry__level">{e.level}</span>
              {e.code && <span className="log-entry__code">{e.code}</span>}
              <span className="log-entry__message">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LogsPanel({ refreshKey }: { refreshKey: number }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listRuns().then(setRuns)
  }, [refreshKey])

  async function handleExport() {
    setBusy(true)
    try {
      const json = await exportAllLogsAsJson()
      downloadTextFile(`kcell-stock-optimizer-logs_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, json)
    } finally {
      setBusy(false)
    }
  }

  async function handleClear() {
    if (!confirm('Удалить весь журнал обработки из этого браузера? Действие необратимо.')) return
    setBusy(true)
    try {
      await clearAllLogs()
      setRuns(await listRuns())
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Журнал обработки</h2>
      <p className="logs-panel__hint">
        Каждый запуск сохраняется в этом браузере (IndexedDB) с этапами, предупреждениями и точной причиной ошибки, если
        она была. Скачайте JSON и пришлите его, чтобы поправить код по конкретной ошибке.
      </p>
      <div className="actions-row">
        <button className="btn btn--ghost" disabled={busy || !runs?.length} onClick={handleExport}>
          Скачать все логи (JSON)
        </button>
        <button className="btn btn--ghost" disabled={busy || !runs?.length} onClick={handleClear}>
          Очистить журнал
        </button>
      </div>
      {!runs || runs.length === 0 ? (
        <p className="logs-panel__empty">Журнал пуст — запусков ещё не было.</p>
      ) : (
        <div className="run-list">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
      )}
    </section>
  )
}
