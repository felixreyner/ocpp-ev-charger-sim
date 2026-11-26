import { useEffect, useState } from 'react';
import { MessageInspector, Toasts, ago, useLiveSocket } from '@sim/ui';
import { ATTACKS, type AttackId, type RogueAction, type RogueState } from '../../server/types.ts';

const INTENSITIES = [1, 2, 4, 8];

const isWsUrl = (v: string) => /^wss?:\/\/.+/i.test(v.trim());

function TargetEditor({ s, act }: { s: RogueState; act: (a: RogueAction) => void }) {
  const current = s.config.csmsUrl;
  const [draft, setDraft] = useState(current);
  const [editing, setEditing] = useState(false);
  // Follow server-side changes (e.g. edits from the unified dashboard) unless
  // the user is in the middle of typing their own value.
  useEffect(() => {
    if (!editing) setDraft(current);
  }, [current, editing]);

  const trimmed = draft.trim();
  const valid = isWsUrl(trimmed);
  const dirty = trimmed !== current;
  const apply = () => {
    if (!valid || !dirty) return;
    act({ type: 'setTarget', csmsUrl: trimmed });
    setEditing(false);
  };

  return (
    <div className="target-edit">
      <label className="target-label muted small">OCPP WebSocket endpoint</label>
      <div className="target-input-row">
        <input
          className={`target-input mono ${!valid && trimmed ? 'invalid' : ''}`}
          value={draft}
          spellCheck={false}
          placeholder="ws://host:9000/ocpp"
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setEditing(true);
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply();
            if (e.key === 'Escape') {
              setDraft(current);
              setEditing(false);
            }
          }}
        />
        <button className="btn btn-sm btn-primary" disabled={!valid || !dirty} onClick={apply}>
          Retarget
        </button>
      </div>
      <div className="target-sub">
        <span className="muted small">
          Node connects as <code className="mono">{s.config.chargePointId}</code> → <code className="mono">{(dirty && valid ? trimmed : current).replace(/\/+$/, '')}/{s.config.chargePointId}</code>
        </span>
        {!valid && trimmed && <span className="err small">Must start with ws:// or wss://</span>}
        {dirty && valid && <span className="warn small">Press Retarget to reconnect here.</span>}
        {current !== s.defaultCsmsUrl && (
          <button
            className="btn btn-xs"
            onClick={() => {
              setEditing(false);
              act({ type: 'setTarget', csmsUrl: s.defaultCsmsUrl });
            }}
          >
            Reset to default ({s.defaultCsmsUrl})
          </button>
        )}
      </div>
    </div>
  );
}

function ConnBadge({ s }: { s: RogueState }) {
  const c = s.connection;
  const tone = c.state === 'connected' ? 'ok' : c.state === 'connecting' ? 'warn' : 'bad';
  const label = c.state === 'connected' ? 'connected' : c.state === 'connecting' ? 'connecting…' : 'offline';
  return (
    <span className={`pill pill-${tone}`}>
      <span className="pill-dot" /> {label}
    </span>
  );
}

function AttackRow({ s, act }: { s: RogueState; act: (a: RogueAction) => void }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>🧨 Attack modes</h2>
        <div className="head-actions">
          <button className="btn btn-sm" onClick={() => act({ type: 'all', on: true })}>
            Enable all
          </button>
          <button className="btn btn-sm" onClick={() => act({ type: 'all', on: false })}>
            Disable all
          </button>
        </div>
      </header>
      <div className="panel-body attack-grid">
        {ATTACKS.map((a) => {
          const on = s.attacks[a.id];
          const fired = s.stats.attacksFired[a.id] ?? 0;
          return (
            <div key={a.id} className={`attack-card ${on ? 'on' : ''}`}>
              <label className="attack-top">
                <input type="checkbox" checked={on} onChange={(e) => act({ type: 'toggle', attack: a.id as AttackId, on: e.target.checked })} />
                <span className="attack-name">{a.label}</span>
                {fired > 0 && <span className="attack-count mono">{fired}</span>}
              </label>
              <p className="attack-blurb">{a.blurb}</p>
              <button className="btn btn-xs" onClick={() => act({ type: 'burst', attack: a.id as AttackId })} disabled={a.id === 'reconnectStorm'}>
                Fire once
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const { state: s, logs, setLogs, connected, send, toasts } = useLiveSocket<RogueState>();
  const act = (a: RogueAction) => send(a);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);

  if (!s) {
    return (
      <div className="loading">
        <div className="brand-logo big">☠️</div>
        <p>{connected ? 'Loading rogue node…' : 'Connecting to the rogue charger…'}</p>
      </div>
    );
  }

  const enabledCount = ATTACKS.filter((a) => s.attacks[a.id]).length;

  return (
    <div className={`rogue-shell ${s.armed ? 'armed' : ''}`}>
      <Toasts toasts={toasts} />
      <header className="rogue-banner">
        <div className="banner-main">
          <span className="skull">☠️</span>
          <div>
            <h1>
              ROGUE / TEST CHARGER <span className="tag">SIMULATED</span>
            </h1>
            <p className="muted">
              A deliberately misbehaving OCPP node for stress-testing your CSMS sandbox. Not a real charger — every frame here is an attack probe.
            </p>
          </div>
        </div>
        <button className={`arm-btn ${s.armed ? 'armed' : ''}`} onClick={() => act({ type: 'arm', on: !s.armed })}>
          {s.armed ? '■ ARMED — click to disarm' : '▶ DISARMED — click to arm'}
        </button>
      </header>

      <div className="rogue-grid">
        <div className="col">
          <section className="panel">
            <header className="panel-head">
              <h2>🎯 Target CSMS</h2>
              <ConnBadge s={s} />
            </header>
            <div className="panel-body">
              <TargetEditor s={s} act={act} />
              <div className="kv">
                <span>Identity</span>
                <code>{s.config.chargePointId}</code>
                <span>Subprotocol</span>
                <code>{s.config.version}</code>
                <span>Socket opens</span>
                <code>{s.connection.socketOpens}</code>
                {s.connection.error && (
                  <>
                    <span>Last error</span>
                    <code className="err">{s.connection.error}</code>
                  </>
                )}
              </div>
              <div className="conn-actions">
                {s.connection.state === 'disconnected' ? (
                  <button className="btn btn-sm btn-primary" onClick={() => act({ type: 'connect' })}>
                    Connect
                  </button>
                ) : (
                  <button className="btn btn-sm" onClick={() => act({ type: 'disconnect' })}>
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>📊 Attack telemetry</h2>
            </header>
            <div className="panel-body stat-row">
              <div className="stat">
                <div className="stat-n mono">{s.stats.framesSent}</div>
                <div className="stat-l">frames sent</div>
              </div>
              <div className="stat">
                <div className="stat-n mono">{enabledCount}</div>
                <div className="stat-l">modes on</div>
              </div>
              <div className="stat">
                <div className="stat-n mono">{s.stats.injectionProbes}</div>
                <div className="stat-l">injection probes</div>
              </div>
              <div className="stat">
                <div className="stat-n mono">{s.stats.lastAttack ? ago(s.stats.lastAttack.at) : '—'}</div>
                <div className="stat-l">last probe</div>
              </div>
            </div>
            <div className="panel-body intensity">
              <span className="muted small">Intensity</span>
              <div className="seg">
                {INTENSITIES.map((v) => (
                  <button key={v} className={`seg-btn ${s.config.intensity === v ? 'active' : ''}`} onClick={() => act({ type: 'intensity', value: v })}>
                    ×{v}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <AttackRow s={s} act={act} />
        </div>

        <div className="col">
          <MessageInspector logs={logs} perspective="charger" onClear={() => setLogs([])} title="Rogue → CSMS traffic" />
        </div>
      </div>
    </div>
  );
}
