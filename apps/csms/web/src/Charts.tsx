import type { Transaction } from '../../server/types.ts';

const COLORS = ['#a3ff12', '#22d3ee', '#c084fc', '#fbbf24', '#fb7185'];
export const colorFor = (connectorId: number) => COLORS[(connectorId - 1) % COLORS.length];

/** Small inline power sparkline for the sessions table. */
export function Sparkline({ tx }: { tx: Transaction }) {
  const s = tx.samples;
  if (s.length < 2) return <span className="muted small">–</span>;
  const w = 90;
  const h = 24;
  const max = Math.max(...s.map((p) => p.powerW), 1);
  const t0 = s[0].t;
  const span = Math.max(s[s.length - 1].t - t0, 1);
  const pts = s.map((p) => `${((p.t - t0) / span) * w},${h - (p.powerW / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} className="spark">
      <polyline points={pts} fill="none" stroke={colorFor(tx.connectorId)} strokeWidth="1.5" />
    </svg>
  );
}

/** Live power of the running sessions over time. */
export function PowerChart({ txs }: { txs: Transaction[] }) {
  const w = 760;
  const h = 200;
  const pad = { l: 58, r: 12, t: 12, b: 24 };
  const WINDOW_MS = 180_000;
  const nowT = Date.now();
  const t0 = nowT - WINDOW_MS;
  // keep one point before the window so lines enter from the left edge
  txs = txs.map((t) => {
    const i = t.samples.findIndex((p) => p.t >= t0);
    return { ...t, samples: i < 0 ? t.samples.slice(-1) : t.samples.slice(Math.max(0, i - 1)) };
  });
  const all = txs.flatMap((t) => t.samples);
  const maxW = Math.max(10_000, ...all.map((p) => p.powerW)) * 1.1;
  const x = (t: number) => pad.l + (Math.max(t - t0, 0) / WINDOW_MS) * (w - pad.l - pad.r);
  const y = (pw: number) => h - pad.b - (pw / maxW) * (h - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxW);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="power-chart">
      <defs>
        {txs.map((t) => (
          <linearGradient key={t.id} id={`fill-${t.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={colorFor(t.connectorId)} stopOpacity="0.35" />
            <stop offset="1" stopColor={colorFor(t.connectorId)} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} className="grid-line" />
          <text x={pad.l - 8} y={y(v)} className="axis-text" textAnchor="end" dominantBaseline="middle">
            {Math.round(v / 1000)} kW
          </text>
        </g>
      ))}
      {txs.map((t) => {
        if (t.samples.length < 2) return null;
        const line = t.samples.map((p) => `${x(p.t)},${y(p.powerW)}`).join(' L ');
        const last = t.samples[t.samples.length - 1];
        return (
          <g key={t.id}>
            <path d={`M ${x(t.samples[0].t)},${y(0)} L ${line} L ${x(last.t)},${y(0)} Z`} fill={`url(#fill-${t.id})`} />
            <path d={`M ${line}`} fill="none" stroke={colorFor(t.connectorId)} strokeWidth="2" className="chart-line" />
            <circle cx={x(last.t)} cy={y(last.powerW)} r="4" fill={colorFor(t.connectorId)} className="chart-dot" />
          </g>
        );
      })}
      <text x={pad.l} y={h - 6} className="axis-text">
        −3 min
      </text>
      <text x={w - pad.r} y={h - 6} className="axis-text" textAnchor="end">
        now
      </text>
      {txs.length === 0 && (
        <text x={w / 2} y={h / 2} textAnchor="middle" className="axis-text">
          No running sessions. Start one from the charger or with Remote start.
        </text>
      )}
    </svg>
  );
}
