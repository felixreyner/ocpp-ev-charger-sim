import { useEffect, useState } from 'react';
import { duration, kw, kwh, statusTone } from '@sim/ui';
import type { CarPreset, ConnectorView } from '../../server/types.ts';

interface Props {
  c: ConnectorView;
  cars: CarPreset[];
  cards: string[];
  online: boolean;
  act: (a: any) => void;
  side: 'left' | 'right';
}

function SocRing({ soc, charging, color }: { soc: number | null; charging: boolean; color: string }) {
  const r = 52;
  const len = 2 * Math.PI * r;
  const pct = soc ?? 0;
  return (
    <svg className={`soc-ring ${charging ? 'is-charging' : ''}`} viewBox="0 0 128 128">
      <defs>
        <linearGradient id={`ring-${color}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a3ff12" />
          <stop offset="1" stopColor={color} />
        </linearGradient>
      </defs>
      <circle cx="64" cy="64" r={r} className="ring-bg" />
      <circle
        cx="64"
        cy="64"
        r={r}
        className="ring-fg"
        stroke={`url(#ring-${color})`}
        strokeDasharray={`${(len * pct) / 100} ${len}`}
        transform="rotate(-90 64 64)"
      />
      <text x="64" y="62" className="ring-num">
        {soc === null ? '--' : Math.floor(soc)}
        <tspan className="ring-pct">%</tspan>
      </text>
      <text x="64" y="84" className="ring-cap">
        battery
      </text>
    </svg>
  );
}

/** A little side-view of the car with the cable coming in from the charger. */
function Scene({ c, side }: { c: ConnectorView; side: 'left' | 'right' }) {
  const charging = c.status === 'Charging';
  const car = c.car;
  const flip = side === 'left';
  return (
    <svg className={`scene ${charging ? 'is-charging' : ''}`} viewBox="0 0 320 120" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <defs>
        <linearGradient id={`body-${c.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={car?.color ?? '#334155'} stopOpacity="0.95" />
          <stop offset="1" stopColor={car?.color ?? '#334155'} stopOpacity="0.45" />
        </linearGradient>
      </defs>
      {/* ground */}
      <line x1="0" y1="104" x2="320" y2="104" className="ground" />
      {/* cable from the charger (left edge) */}
      {car ? (
        <>
          <path d="M0 62 C 50 62, 60 100, 110 96 S 170 70, 196 66" className="cable" />
          <path d="M0 62 C 50 62, 60 100, 110 96 S 170 70, 196 66" className="cable-flow" />
        </>
      ) : (
        <path d="M0 62 C 30 62, 34 92, 22 100" className="cable idle" />
      )}
      {car ? (
        <g className="car" transform="translate(150 28)">
          <path
            d="M10 60 C 8 46, 18 40, 34 38 L 62 18 C 70 12, 82 10, 96 10 L 124 10 C 138 10, 148 16, 156 26 L 166 38 C 178 40, 188 44, 190 56 L 190 64 L 10 64 Z"
            fill={`url(#body-${c.id})`}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth="1.2"
          />
          <path d="M68 22 L 92 16 L 92 36 L 52 38 Z" className="glass" />
          <path d="M100 16 L 124 16 C 134 16, 142 22, 148 34 L 100 36 Z" className="glass" />
          <circle cx="46" cy="66" r="12" className="wheel" />
          <circle cx="154" cy="66" r="12" className="wheel" />
          <circle cx="46" cy="66" r="4" className="hub" />
          <circle cx="154" cy="66" r="4" className="hub" />
          <rect x="40" y="38" width="10" height="7" rx="2" className={`port ${charging ? 'on' : ''}`} />
          <rect x="176" y="46" width="12" height="4" rx="2" fill="#fde68a" opacity="0.9" />
        </g>
      ) : (
        <g className="empty-bay" transform="translate(150 30)">
          <rect x="0" y="0" width="190" height="72" rx="14" className="bay" />
        </g>
      )}
    </svg>
  );
}

export function ConnectorCard({ c, cars, cards, online, act, side }: Props) {
  const [car, setCar] = useState(side === 'left' ? 2 : 1);
  const [card, setCard] = useState(cards[0] ?? '');
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const tone = statusTone(c.status);
  const charging = c.status === 'Charging';
  const tx = c.transaction;
  const out = c.faulted || !c.operative;

  return (
    <div className={`conn-card tone-border-${tone} ${charging ? 'glow' : ''}`}>
      <div className="conn-head">
        <div>
          <div className="conn-title">Connector {c.id}</div>
          <div className="muted small">{c.label}</div>
        </div>
        <span className={`badge tone-${tone}`}>{c.status}</span>
      </div>

      <Scene c={c} side={side} />

      <div className="conn-metrics">
        <SocRing soc={c.car ? c.car.soc : null} charging={charging} color={c.car?.color ?? '#22d3ee'} />
        <div className="metric-grid">
          <div className="metric">
            <span>Power</span>
            <b className={charging ? 'charge-text' : ''}>
              {kw(c.powerW)}
              <small> kW</small>
            </b>
          </div>
          <div className="metric">
            <span>Session</span>
            <b>
              {tx ? kwh(tx.energyWh) : '0.00'}
              <small> kWh</small>
            </b>
          </div>
          <div className="metric">
            <span>Time</span>
            <b>{tx ? duration(Date.now() - tx.startedAt) : '--'}</b>
          </div>
          <div className="metric">
            <span>Meter</span>
            <b className="mono small-num">{kwh(c.meterWh, 1)} kWh</b>
          </div>
        </div>
      </div>

      <div className="power-bar" title={`${kw(c.powerW)} / ${kw(c.maxPowerW, 0)} kW`}>
        <div className="power-fill" style={{ width: `${Math.min(100, (c.powerW / c.maxPowerW) * 100)}%` }} />
        {c.limitW !== null && <div className="power-limit" style={{ left: `${Math.min(100, (c.limitW / c.maxPowerW) * 100)}%` }} title="Charging profile limit" />}
      </div>
      <div className="power-legend muted small">
        <span>{c.car ? `${c.car.name} · ${c.car.capacityKWh} kWh` : 'No car'}</span>
        <span>{c.limitW !== null ? <b className="limit-text">limit {kw(c.limitW)} kW</b> : `max ${kw(c.maxPowerW, 0)} kW`}</span>
      </div>

      {tx && (
        <div className="tx-strip">
          <span>
            Tx <b className="mono">{tx.id.length > 12 ? tx.id.slice(0, 8) + '…' : tx.id}</b>
          </span>
          <span>
            🪪 <b className="mono">{tx.idTag}</b>
          </span>
          {tx.remote && <span className="remote-pill">remote</span>}
        </div>
      )}
      {!tx && c.pendingIdTag && <div className="tx-strip pending">Authorized {c.pendingIdTag}, waiting for car…</div>}

      <div className="conn-actions">
        <div className="action-row">
          {c.car ? (
            <button className="btn" onClick={() => act({ type: 'unplug', connectorId: c.id })}>
              🔌 Unplug car
            </button>
          ) : (
            <>
              <select className="select" value={car} onChange={(e) => setCar(Number(e.target.value))}>
                {cars.map((x, i) => (
                  <option key={x.name} value={i}>
                    {x.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" onClick={() => act({ type: 'plug', connectorId: c.id, car })}>
                🚗 Plug in
              </button>
            </>
          )}
        </div>
        <div className="action-row">
          <select className="select" value={card} onChange={(e) => setCard(e.target.value)}>
            {cards.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <button className="btn btn-charge rfid" disabled={!online || out} onClick={() => act({ type: 'tap', connectorId: c.id, idTag: card })}>
            <span className="nfc">)))</span> Tap card
          </button>
        </div>
        <div className="action-row">
          <button className="btn" disabled={!tx} onClick={() => act({ type: 'stop', connectorId: c.id })}>
            ■ Stop
          </button>
          <button className={`btn btn-danger ${c.faulted ? 'on' : ''}`} onClick={() => act({ type: 'fault', connectorId: c.id, on: !c.faulted })}>
            {c.faulted ? '✔ Clear fault' : '⚠ Inject fault'}
          </button>
        </div>
      </div>
    </div>
  );
}
