import { useEffect, useRef, useState } from 'react';
import { MessageInspector, Toasts, kw, kwh, useLiveSocket } from '@sim/ui';
import type { Command, CsmsState, UiToServer } from '../../server/types.ts';
import { ChargersPanel, RemoteControl, SessionsPanel, SettingsPanel, TagsPanel, type CommandResult } from './Panels.tsx';
import { PowerChart, colorFor } from './Charts.tsx';

function Stat({ label, value, unit, accent }: { label: string; value: string | number; unit?: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <span>{label}</span>
      <b>
        {value}
        {unit && <small> {unit}</small>}
      </b>
    </div>
  );
}

export function App() {
  const [last, setLast] = useState<CommandResult | null>(null);
  const pending = useRef(new Map<number, string>());
  const { state: s, logs, setLogs, connected, send, toasts, pushToast } = useLiveSocket<CsmsState>((msg) => {
    if (msg.type === 'commandResult') {
      pending.current.delete(msg.reqId);
      setLast({ ok: msg.ok, action: msg.action, result: msg.result, error: msg.error, at: Date.now() });
      const status = (msg.result as any)?.status;
      if (!msg.ok) pushToast('error', `${msg.action}: ${msg.error}`);
      else pushToast(status && !['Accepted', 'Unlocked'].includes(status) ? 'info' : 'success', `${msg.action} → ${status ?? 'OK'}`);
    }
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const reqId = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!s) return;
    const exists = s.chargers.find((c) => c.id === selected);
    if (!exists || (!exists.connected && s.chargers.some((c) => c.connected))) {
      setSelected(s.chargers.find((c) => c.connected)?.id ?? s.chargers[0]?.id ?? null);
    }
  }, [s, selected]);

  if (!s) {
    return (
      <div className="loading">
        <div className="brand-logo big">🛰</div>
        <p>{connected ? 'Loading…' : 'Connecting to the CSMS…'}</p>
      </div>
    );
  }

  const ui = (m: UiToServer) => send(m);
  const run = (cmd: Command) => {
    if (!selected) return;
    const id = ++reqId.current;
    pending.current.set(id, cmd.command);
    ui({ type: 'command', reqId: id, chargerId: selected, cmd });
  };
  const charger = s.chargers.find((c) => c.id === selected);
  const live = s.transactions.filter((t) => !t.stoppedAt);
  const livePower = live.reduce((sum, t) => sum + t.powerW, 0);
  const endpoint = `ws://${location.hostname}:${s.ocppPort}/ocpp/<chargePointId>`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">🛰</div>
          <div>
            Central System
            <small>OCPP CSMS · 1.6J + 2.0.1</small>
          </div>
        </div>
        <button
          className="endpoint"
          title="Click to copy. This port is published by Docker Compose, so real chargers on your network can connect too."
          onClick={() => {
            navigator.clipboard?.writeText(endpoint.replace('<chargePointId>', ''));
            pushToast('info', 'Endpoint copied');
          }}
        >
          <span className="pulse-dot" />
          <span className="muted">OCPP endpoint</span>
          <code>{endpoint}</code>
        </button>
        <div className="spacer" />
        <div className="settings-anchor">
          <button className={`btn btn-sm ${showSettings ? 'btn-primary' : ''}`} onClick={() => setShowSettings((v) => !v)}>
            ⚙ Settings
          </button>
          {showSettings && <SettingsPanel settings={s.settings} update={(settings) => ui({ type: 'settings', settings })} />}
        </div>
      </header>

      <main className="layout">
        <div className="col-main">
          <div className="stats">
            <Stat label="Stations online" value={s.chargers.filter((c) => c.connected).length} unit={`/ ${s.chargers.length}`} />
            <Stat label="Live sessions" value={live.length} />
            <Stat label="Live power" value={kw(livePower)} unit="kW" accent />
            <Stat label="Energy delivered" value={kwh(s.totals.energyWh)} unit="kWh" />
            <Stat label="Completed sessions" value={s.totals.sessions} />
          </div>

          <div className="row-2">
            <ChargersPanel chargers={s.chargers} selected={selected} onSelect={setSelected} onDisconnect={(id) => ui({ type: 'disconnect', chargerId: id })} />
            <RemoteControl charger={charger} state={s} run={run} last={last} />
          </div>

          <section className="panel">
            <header className="panel-head">
              <h2>📈 Live power</h2>
              <div className="legend">
                {live.map((t) => (
                  <span key={t.id} className="small">
                    <i style={{ background: colorFor(t.connectorId) }} /> {t.chargerId} #{t.connectorId} · {kw(t.powerW)} kW
                    {t.soc !== null ? ` · ${Math.round(t.soc)}%` : ''}
                  </span>
                ))}
              </div>
            </header>
            <div className="panel-body">
              <PowerChart txs={live} />
            </div>
          </section>

          <div className="row-2 wide-left">
            <SessionsPanel txs={s.transactions} tags={s.tags} />
            <TagsPanel tags={s.tags} upsert={(tag) => ui({ type: 'tag:upsert', tag })} remove={(idTag) => ui({ type: 'tag:delete', idTag })} />
          </div>
        </div>
        <MessageInspector logs={logs} perspective="csms" onClear={() => setLogs([])} />
      </main>
      <Toasts toasts={toasts} />
    </div>
  );
}
