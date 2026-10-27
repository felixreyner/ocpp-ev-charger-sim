export const kw = (w: number, digits = 1) => (w / 1000).toFixed(digits);
export const kwh = (wh: number, digits = 2) => (wh / 1000).toFixed(digits);
export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
  '.' +
  String(ts % 1000).padStart(3, '0');
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}
export const ago = (ts: number | null) => {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

/** Statuses from both OCPP versions mapped onto a few visual tones. */
export function statusTone(status: string | null | undefined): 'ok' | 'busy' | 'charging' | 'warn' | 'bad' | 'off' {
  switch (status) {
    case 'Available':
      return 'ok';
    case 'Charging':
      return 'charging';
    case 'Preparing':
    case 'Occupied':
    case 'Finishing':
    case 'Reserved':
      return 'busy';
    case 'SuspendedEV':
    case 'SuspendedEVSE':
      return 'warn';
    case 'Faulted':
      return 'bad';
    default:
      return 'off';
  }
}
