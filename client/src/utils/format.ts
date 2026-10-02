/** 24-hour clock time (HH:MM:SS) so lists read the same in every locale. */
export function formatClock(value: string | number): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatEur(amount: number): string {
  return `EUR ${amount.toFixed(2)}`;
}
