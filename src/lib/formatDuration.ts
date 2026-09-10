export function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec} с`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min} мин ${sec} с`
}
