import { fmtDuration } from '../lib/formatDuration'
import type { ProgressEvent } from '../lib/types'

const STAGE_LABELS: Record<ProgressEvent['stage'], string> = {
  parsing_mb52: 'Разбор MB52',
  parsing_target: 'Разбор целевого файла',
  parsing_template: 'Разбор шаблона',
  allocating: 'Распределение партий',
  building_output: 'Формирование файла',
  done: 'Готово',
}

interface Props {
  progress: ProgressEvent | null
  elapsedMs: number
  stalled: boolean
  onAbort: () => void
}

export function ProgressPanel({ progress, elapsedMs, stalled, onAbort }: Props) {
  const percent = progress?.overallPercent ?? 0
  return (
    <div className="progress-panel">
      <div className="progress-panel__top">
        <span className="progress-panel__stage">{progress ? STAGE_LABELS[progress.stage] : 'Запуск…'}</span>
        <span className="progress-panel__percent">{percent}%</span>
      </div>
      <div className="progress-bar">
        <div className="progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-panel__bottom">
        <span>{progress?.message ?? ''}</span>
        <span className="progress-panel__elapsed">Прошло: {fmtDuration(elapsedMs)}</span>
      </div>
      {progress?.current !== undefined && progress.total !== undefined && (
        <div className="progress-panel__count">
          Обработано {progress.current.toLocaleString('ru-RU')} из {progress.total.toLocaleString('ru-RU')}
        </div>
      )}

      {stalled ? (
        <div className="alert alert--warning">
          <strong>Обработка не подаёт признаков активности {fmtDuration(elapsedMs)}.</strong>
          <div>Последний этап: «{progress ? STAGE_LABELS[progress.stage] : '—'}». Возможно, программа зависла.</div>
          <button className="btn btn--critical" onClick={onAbort}>
            Прервать и показать причину
          </button>
        </div>
      ) : (
        <button className="btn btn--ghost btn--small" onClick={onAbort}>
          Прервать обработку
        </button>
      )}
    </div>
  )
}
