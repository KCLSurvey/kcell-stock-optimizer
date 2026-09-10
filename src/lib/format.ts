const numberFormatter = new Intl.NumberFormat('ru-RU')

export function fmtNum(n: number): string {
  return numberFormatter.format(n)
}
