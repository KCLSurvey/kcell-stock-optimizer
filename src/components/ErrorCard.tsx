import { useState } from 'react'
import type { SerializedError } from '../lib/errors'

export function ErrorCard({ error }: { error: SerializedError }) {
  const [showTechnical, setShowTechnical] = useState(false)
  return (
    <div className="error-card">
      <div className="error-card__head">
        <span className="error-card__code">{error.code}</span>
        <span className="error-card__title">Обработка остановлена</span>
      </div>
      <p className="error-card__message">{error.message}</p>
      <p className="error-card__explain">{error.explanation}</p>

      {(error.technical || error.context) && (
        <>
          <button className="btn btn--ghost btn--small" onClick={() => setShowTechnical((v) => !v)}>
            {showTechnical ? 'Скрыть техническую информацию' : 'Показать техническую информацию'}
          </button>
          {showTechnical && (
            <pre className="error-card__technical">
              {error.technical ? `${error.technical}\n\n` : ''}
              {error.context ? JSON.stringify(error.context, null, 2) : ''}
            </pre>
          )}
        </>
      )}
      <p className="error-card__hint">
        Эта ошибка сохранена в журнале ниже — можно скачать лог запуска и прислать его для исправления.
      </p>
    </div>
  )
}
