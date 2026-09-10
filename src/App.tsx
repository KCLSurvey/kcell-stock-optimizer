import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { FileSlot } from './components/FileSlot'
import { fmtNum } from './lib/format'
import type { ProcessingResult } from './lib/types'
import type { WorkerResponse } from './worker/process.worker'

type Status = 'idle' | 'processing' | 'done' | 'error'

const TEMPLATE_URL = `${import.meta.env.BASE_URL}template-zalivka.xlsx`

function App() {
  const [mb52File, setMb52File] = useState<File | null>(null)
  const [targetFile, setTargetFile] = useState<File | null>(null)
  const [customTemplateFile, setCustomTemplateFile] = useState<File | null>(null)

  const [status, setStatus] = useState<Status>('idle')
  const [progressMessage, setProgressMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ProcessingResult | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [showAllRows, setShowAllRows] = useState(false)

  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      if (outputUrl) URL.revokeObjectURL(outputUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canProcess = mb52File !== null && targetFile !== null && status !== 'processing'

  async function handleProcess() {
    if (!mb52File || !targetFile) return
    setStatus('processing')
    setErrorMessage(null)
    setResult(null)
    if (outputUrl) {
      URL.revokeObjectURL(outputUrl)
      setOutputUrl(null)
    }
    setProgressMessage('Чтение файлов…')

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
        if (msg.type === 'progress') {
          setProgressMessage(msg.event.message)
        } else if (msg.type === 'success') {
          setResult(msg.result)
          const blob = new Blob([msg.outputArrayBuffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          })
          setOutputUrl(URL.createObjectURL(blob))
          setStatus('done')
          worker.terminate()
          workerRef.current = null
        } else if (msg.type === 'error') {
          setErrorMessage(msg.message)
          setStatus('error')
          worker.terminate()
          workerRef.current = null
        }
      }
      worker.onerror = (e) => {
        setErrorMessage(e.message || 'Неизвестная ошибка воркера.')
        setStatus('error')
        worker.terminate()
        workerRef.current = null
      }

      worker.postMessage({
        type: 'process',
        payload: { mb52ArrayBuffer, targetArrayBuffer, templateArrayBuffer },
      })
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const deficitRows = useMemo(
    () => result?.reconciliation.filter((r) => r.status === 'deficit') ?? [],
    [result],
  )
  const okRows = useMemo(() => result?.reconciliation.filter((r) => r.status === 'ok') ?? [], [result])
  const displayedOkRows = showAllRows ? okRows : okRows.slice(0, 100)

  const outputFileName = `zalivka_${new Date().toISOString().slice(0, 10)}.xlsx`

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
        {status === 'processing' && <div className="progress-line">{progressMessage}</div>}
        {status === 'error' && errorMessage && <div className="alert alert--error">{errorMessage}</div>}
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
                  Скачать итоговый файл ({outputFileName})
                </a>
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
