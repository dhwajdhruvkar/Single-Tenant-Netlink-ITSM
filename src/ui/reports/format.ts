/** "95" → "1 h 35 m", "2880" → "2 d", null → "–". Wall-clock minutes. */
export function formatMinutes(m: number | null): string {
  if (m === null) return "–";
  if (m < 1) return "< 1 m";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = Math.round(m % 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return min > 0 ? `${h} h ${min} m` : `${h} h`;
  return `${min} m`;
}

export function formatPct(p: number | null): string {
  return p === null ? "–" : `${p}%`;
}
