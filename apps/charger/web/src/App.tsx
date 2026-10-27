import { useEffect, useState } from 'react';
import { MessageInspector, Toasts, ago, useLiveSocket } from '@sim/ui';
import type { OcppVersion } from '@sim/ocpp';
import type { ChargerAction, ChargerState } from '../../server/types.ts';
import { ConnectorCard } from './ConnectorCard.tsx';
import { Pillar } from './Pillar.tsx';
import { Learn } from './Learn.tsx';

const SPEEDS = [1, 10, 60, 300];

function ConnectionPanel({ s, act }: { s: ChargerState; act: (a: ChargerAction) => void }) {
  const [url, setUrl] = useState(s.config.csmsUrl);
  const [id, setId] = useState(s.config.chargePointId);
  useEffect(() => {
    setUrl(s.config.csmsUrl);
    setId(s.config.chargePointId);
  }, [s.config.csmsUrl, s.config.chargePointId]);
  const c = s.connection;
  const dirty = url !== s.config.csmsUrl || id !== s.config.chargePointId;
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>🔗 Connection</h2>
        {c.state === 'disconnected' ? (
          <button className="btn btn-sm btn-primary" onClick={() => act({ type: 'connect' })}>
            Connect
          </button>
        ) : (
          <button className="btn btn-sm" onClick={() => act({ type: 'disconnect' })}>
            Disconnect
          </button>
        )}
      </header>
      <div className="panel-body conn-form">
        <label className="field">
          CSMS URL
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          Charge point ID
          <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <button className="btn" disabled={!dirty} onClick={() => act({ type: 'config', config: { csmsUrl: url, chargePointId: id } })}>
          Apply &amp; reconnect
        </button>
        <div className="kv">
          <span>Endpoint</span>
          <code>
            {s.config.csmsUrl.replace(/\/+$/, '')}/{s.config.chargePointId}
          </code>
          <span>Subprotocol</span>
          <code>Sec-WebSocket-Protocol: {s.config.version}</code>
          <span>Boot status</span>
          <code>{c.bootStatus}</code>
          <span>Heartbeat</span>
          <code>
            every {c.heartbeatIntervalS || '–'}s · last {ago(c.lastHeartbeat)}
          </code>
          {c.error && c.state !== 'connected' && (
            <>
              <span>Last error</span>
              <code className="err">{c.error}</code>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const { state: s, logs, setLogs, connected, send, toasts } = useLiveSocket<ChargerState>();
  const act = (a: ChargerAction) => send(a);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);

  if (!s) {
    return (
      <div className="loading">
        <div className="brand-logo big">⚡</div>
        <p>{connected ? 'Loading charger…' : 'Connecting to the charger simulator…'}</p>
      </div>
    );
  }

  const online = s.connection.state === 'connected' && s.connection.bootStatus === 'Accepted';
  const connTone = online ? 'ok' : s.connection.state === 'connecting' || s.connection.state === 'connected' ? 'warn' : 'bad';
  const setVersion = (v: OcppVersion) => v !== s.config.version && act({ type: 'config', config: { version: v } });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">⚡</div>
          <div>
            Charger Simulator
            <small>
              {s.config.vendor} {s.config.model}
            </small>
          </div>
        </div>
        <span className={`badge tone-${connTone}`}>
          {online ? 'Online' : s.connection.state === 'connected' ? `Boot ${s.connection.bootStatus}` : s.connection.state === 'connecting' ? 'Connecting' : 'Offline'}
        </span>
        <div className="spacer" />
        <div className="top-group">
          <span className="top-label">Protocol</span>
          <div className="seg">
            <button className={s.config.version === 'ocpp1.6' ? 'on' : ''} onClick={() => setVersion('ocpp1.6')}>
              1.6J
            </button>
            <button className={s.config.version === 'ocpp2.0.1' ? 'on' : ''} onClick={() => setVersion('ocpp2.0.1')}>
              2.0.1
            </button>
          </div>
        </div>
        <div className="top-group">
          <span className="top-label">Sim speed</span>
          <div className="seg">
            {SPEEDS.map((v) => (
              <button key={v} className={s.simSpeed === v ? 'on' : ''} onClick={() => act({ type: 'speed', value: v })}>
                ×{v}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="layout">
        <div className="col-main">
          <section className="panel stage">
            <ConnectorCard c={s.connectors[0]} cars={s.cars} cards={s.cards} online={online} act={act} side="left" />
            <Pillar s={s} />
            <ConnectorCard c={s.connectors[1]} cars={s.cars} cards={s.cards} online={online} act={act} side="right" />
          </section>
          <div className="lower">
            <Learn s={s} logs={logs} />
            <ConnectionPanel s={s} act={act} />
          </div>
        </div>
        <MessageInspector logs={logs} perspective="charger" onClear={() => setLogs([])} />
      </main>
      <Toasts toasts={toasts} />
    </div>
  );
}
