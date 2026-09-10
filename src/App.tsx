import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { ErrorCard } from './components/ErrorCard'
import { FileSlot } from './components/FileSlot'
import { ProgressPanel } from './components/ProgressPanel'
import type { SerializedError } from './lib/errors'
import { ERROR_CATALOG, ERROR_CODES } from './lib/errors'
import { fmtNum } from './lib/format'
import type { ProcessingResult, ProgressEvent } from './lib/types'
import type { WorkerResponse } from './worker/process.worker'

type Status = 'idle' | 'processing' | 'done' | 'error'

const TEMPLATE_URL = `${import.meta.env.BASE_URL}template-zalivka.xlsx`
const STALL_THRESHOLD_MS = 20_000
const FORCE_TERMINATE_TIMEOUT_MS = 5_000

function buildOutputFileName(): string {
  return `zalivka_${new Date().toISOString().slice(0, 10)}.xlsx`
}

/** Saves the blob straight to the browser's downloads via a throwaway link — no tab, no page state to leave behind. */
function triggerDownload(url: string, fileName: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function App() {
  const [mb52File, setMb52File] = useState<File | null>(null)
  const [targetFile, setTargetFile] = useState<File | null>(null)
  const [customTemplateFile, setCustomTemplateFile] = useState<File | null>(null)

  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [stalled, setStalled] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)
  const [result, setResult] = useState<ProcessingResult | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [showAllRows, setShowAllRows] = useState(false)

  const workerRef = useRef<Worker | null>(null)
  const lastProgressAtRef = useRef<number>(Date.now())
  const forceTerminateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      if (outputUrl) URL.revokeObjectURL(outputUrl)
      if (forceTerminateTimerRef.current) clearTimeout(forceTerminateTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ticking clock + stall watchdog: the worker itself can't reliably notice its own
  // hang, so the main thread tracks "time since the last message we heard from it".
  useEffect(() => {
    if (status !== 'processing') return
    const id = setInterval(() => {
      setNow(Date.now())
      if (Date.now() - lastProgressAtRef.current > STALL_THRESHOLD_MS) setStalled(true)
    }, 1000)
    return () => clearInterval(id)
  }, [status])

  const canProcess = mb52File !== null && targetFile !== null && status !== 'processing'

  function finishWithError(err: SerializedError) {
    setError(err)
    setStatus('error')
    workerRef.current?.terminate()
    workerRef.current = null
    if (forceTerminateTimerRef.current) {
      clearTimeout(forceTerminateTimerRef.current)
      forceTerminateTimerRef.current = null
    }
  }

  function handleAbort() {
    if (!workerRef.current) return
    workerRef.current.postMessage({ type: 'abort' })
    // Cooperative abort relies on the worker yielding between checkpoints — normally
    // near-instant. If it truly never yields (a real deadlock), don't leave the user stuck.
    forceTerminateTimerRef.current = setTimeout(() => {
      if (workerRef.current) {
        finishWithError({
          code: ERROR_CODES.STALLED_ABORTED,
          message: 'Обработка не ответила на команду остановки и была прервана принудительно.',
          explanation: ERROR_CATALOG[ERROR_CODES.STALLED_ABORTED],
        })
      }
    }, FORCE_TERMINATE_TIMEOUT_MS)
  }

  async function handleProcess() {
    if (!mb52File || !targetFile) return
    setStatus('processing')
    setError(null)
    setResult(null)
    setProgress(null)
    setStalled(false)
    if (outputUrl) {
      URL.revokeObjectURL(outputUrl)
      setOutputUrl(null)
    }
    const start = Date.now()
    setStartedAt(start)
    setNow(start)
    lastProgressAtRef.current = start

    try {
      const [mb52ArrayBuffer, targetArrayBuffer, templateArrayBuffer] = await Promise.all([
        mb52File.arrayBuffer(),
        targetFile.arrayBuffer(),
        customTemplateFile ? customTemplateFile.arrayBuffer() : fetch(TEMPLATE_URL).then((r) => r.arrayBuffer()),
      ])

      const worker = new Worker(new URL('./worker/process.worker.ts', import.meta.url), { type: 'module' })
      workerRef.current = worker

      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data
        lastProgressAtRef.current = Date.now()
        if (stalled) setStalled(false)

        if (msg.type === 'progress') {
          setProgress(msg.event)
        } else if (msg.type === 'success') {
          setResult(msg.result)
          const blob = new Blob([msg.outputArrayBuffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          })
          const url = URL.createObjectURL(blob)
          setOutputUrl(url)
          setStatus('done')
          worker.terminate()
          workerRef.current = null
          // Save straight to the browser's downloads — nothing stays open on the site,
          // and the run's log trail travels inside this same file (see "Лог обработки" sheet).
          triggerDownload(url, buildOutputFileName())
        } else if (msg.type === 'error') {
          finishWithError(msg.error)
        }
      }
      worker.onerror = (e) => {
        finishWithError({
          code: ERROR_CODES.UNKNOWN,
          message: `Внутренняя ошибка веб-воркера: ${e.message || 'нет описания'}.`,
          explanation: ERROR_CATALOG[ERROR_CODES.UNKNOWN],
        })
      }

      worker.postMessage({
        type: 'process',
        payload: { mb52ArrayBuffer, targetArrayBuffer, templateArrayBuffer },
      })
    } catch (err) {
      finishWithError({
        code: ERROR_CODES.UNKNOWN,
        message: err instanceof Error ? err.message : String(err),
        explanation: ERROR_CATALOG[ERROR_CODES.UNKNOWN],
        technical: err instanceof Error ? err.stack : undefined,
      })
    }
  }

  const deficitRows = useMemo(
    () => result?.reconciliation.filter((r) => r.status === 'deficit') ?? [],
    [result],
  )
  const okRows = useMemo(() => result?.reconciliation.filter((r) => r.status === 'ok') ?? [], [result])
  const displayedOkRows = showAllRows ? okRows : okRows.slice(0, 100)

  const outputFileName = buildOutputFileName()
  const elapsedMs = startedAt ? now - startedAt : 0

  return (
    <div className="app">
      <header className="app__header">
        <h1>Kcell Stock Optimizer</h1>
        <p>Формирование заливочного файла для переноса запасов между СПП по данным MB52 и целевого файла.</p>
      </header>

      <section className="card">
        <h2>1. Файлы</h2>
        <div className="file-grid">
          <FileSlot
            title="Остатки MB52"
            description="Выгрузка из транзакции MB52 (Материал, Завод/Склад ИЗ, Партия ИЗ, Особый запас, Количество, СПП-элемент ИЗ)"
            required
            file={mb52File}
            onChange={setMb52File}
          />
          <FileSlot
            title="Целевой файл"
            description="Материал + требуемое количество по колонкам-проектам (целевым СПП)"
            required
            file={targetFile}
            onChange={setTargetFile}
          />
          <FileSlot
            title="Шаблон заливки (необязательно)"
            description="По умолчанию используется встроенный SAP-шаблон. Загрузите свой, только если он отличается."
            file={customTemplateFile}
            onChange={setCustomTemplateFile}
          />
        </div>
        <div className="actions-row">
          <a className="btn btn--ghost" href={TEMPLATE_URL} download="zalivka_template.xlsx">
            Скачать пустой шаблон заливки
          </a>
          <button className="btn btn--primary" disabled={!canProcess} onClick={handleProcess}>
            {status === 'processing' ? 'Обработка…' : 'Обработать'}
          </button>
        </div>

        {status === 'processing' && (
          <ProgressPanel progress={progress} elapsedMs={elapsedMs} stalled={stalled} onAbort={handleAbort} />
        )}
        {status === 'error' && error && <ErrorCard error={error} />}
      </section>

      {result && (
        <>
          <section className="card">
            <h2>2. Итоги</h2>
            <div className="summary-grid">
              <SummaryCard label="Целевых позиций (материал × СПП)" value={fmtNum(result.summary.requirementCount)} />
              <SummaryCard label="Требуется, всего шт." value={fmtNum(result.summary.totalRequiredQuantity)} />
              <SummaryCard
                label="Уже на целевом СПП"
                value={fmtNum(result.summary.totalAlreadyAtTargetQuantity)}
                tone="ok"
              />
              <SummaryCard label="Перенесено" value={fmtNum(result.summary.totalTransferredQuantity)} tone="ok" />
              <SummaryCard label="Строк в заливке" value={fmtNum(result.summary.fillRowCount)} />
              <SummaryCard
                label="Критично: дефицит позиций"
                value={fmtNum(result.summary.deficitCount)}
                tone={result.summary.deficitCount > 0 ? 'critical' : 'ok'}
              />
              <SummaryCard
                label="Недостающее количество"
                value={fmtNum(result.summary.deficitQuantity)}
                tone={result.summary.deficitQuantity > 0 ? 'critical' : 'ok'}
              />
              <SummaryCard label="Излишки (партий / шт.)" value={`${fmtNum(result.summary.surplusLotCount)} / ${fmtNum(result.summary.surplusQuantity)}`} />
            </div>

            {outputUrl && (
              <div className="actions-row">
                <a className="btn btn--primary" href={outputUrl} download={outputFileName}>
                  Скачать повторно ({outputFileName})
                </a>
                <span className="hint-text">
                  Файл уже сохранён в папку загрузок браузера. Журнал обработки — на листе «Лог обработки» внутри него;
                  нигде на сайте ничего не хранится.
                </span>
              </div>
            )}

            {result.warnings.length > 0 && (
              <details className="warnings">
                <summary>Предупреждения при разборе файлов ({result.warnings.length})</summary>
                <ul>
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          {deficitRows.length > 0 && (
            <section className="card">
              <h2>3. Критичные позиции — не хватает остатков ({fmtNum(deficitRows.length)})</h2>
              <div className="table-wrap">
                <table className="rec-table rec-table--critical">
                  <thead>
                    <tr>
                      <th>Материал</th>
                      <th>Название</th>
                      <th>Целевой СПП</th>
                      <th>Требуется</th>
                      <th>Закрыто</th>
                      <th>Не хватает</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deficitRows.map((r) => (
                      <tr key={r.reqKey}>
                        <td>{r.material}</td>
                        <td>{r.materialName ?? ''}</td>
                        <td>{r.targetSpp}</td>
                        <td>{fmtNum(r.requiredQuantity)}</td>
                        <td>{fmtNum(r.totalCovered)}</td>
                        <td className="num-critical">{fmtNum(-r.delta)}</td>
                        <td>{r.comment}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {okRows.length > 0 && (
            <section className="card">
              <h2>4. Закрытые позиции ({fmtNum(okRows.length)})</h2>
              <div className="table-wrap">
                <table className="rec-table">
                  <thead>
                    <tr>
                      <th>Материал</th>
                      <th>Название</th>
                      <th>Целевой СПП</th>
                      <th>Требуется</th>
                      <th>Уже на месте</th>
                      <th>Перенесено</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedOkRows.map((r) => (
                      <tr key={r.reqKey}>
                        <td>{r.material}</td>
                        <td>{r.materialName ?? ''}</td>
                        <td>{r.targetSpp}</td>
                        <td>{fmtNum(r.requiredQuantity)}</td>
                        <td>{fmtNum(r.alreadyAtTargetQuantity)}</td>
                        <td>{fmtNum(r.transferredQuantity)}</td>
                        <td>{r.comment}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {okRows.length > 100 && (
                <button className="btn btn--ghost" onClick={() => setShowAllRows((v) => !v)}>
                  {showAllRows ? 'Показать первые 100' : `Показать все (${fmtNum(okRows.length)})`}
                </button>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'critical' }) {
  return (
    <div className={`summary-card${tone ? ` summary-card--${tone}` : ''}`}>
      <div className="summary-card__value">{value}</div>
      <div className="summary-card__label">{label}</div>
    </div>
  )
}

export default App
