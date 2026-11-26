import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LiveSocketBase, MessageInspector, Toasts, ago, kw, kwh, useLiveSocket, type Toast } from '@sim/ui';
import type { LogEntry, OcppVersion } from '@sim/ocpp';

// The real apps and their building blocks, reused as-is.
import { App as CsmsApp } from '../../../csms/web/src/App.tsx';
import { App as ChargerApp } from '../../../charger/web/src/App.tsx';
import { App as RogueApp } from '../../../rogue/web/src/App.tsx';
import { ChargersPanel, RemoteControl, type CommandResult } from '../../../csms/web/src/Panels.tsx';
import { PowerChart, colorFor } from '../../../csms/web/src/Charts.tsx';
import { ConnectorCard } from '../../../charger/web/src/ConnectorCard.tsx';
import { Pillar } from '../../../charger/web/src/Pillar.tsx';
import type { Command, CsmsState, UiToServer } from '../../../csms/server/types.ts';
import type { ChargerAction, ChargerState } from '../../../charger/server/types.ts';
import { ATTACKS, type RogueAction, type RogueState } from '../../../rogue/server/types.ts';

type View = 'overview' | 'csms' | 'charger' | 'rogue';
const VIEWS: { id: View; label: string; icon: string; key: string }[] = [
  { id: 'overview', label: 'Mission control', icon: '🎬', key: '1' },
  { id: 'csms', label: 'CSMS', icon: '🛰', key: '2' },
  { id: 'charger', label: 'Charger', icon: '⚡', key: '3' },
  { id: 'rogue', label: 'Rogue', icon: '☠️', key: '4' },
];
const SPEEDS = [1, 10, 60, 300];
const INTENSITIES = [1, 2, 4, 8];

const viewFromHash = (): View => {
  const h = location.hash.replace('#', '') as View;
  return VIEWS.some((v) => v.id === h) ? h : 'overview';
};

/** True for a moment every time `key` changes (after the first value). */
function useFlash(key: unknown, ms = 700) {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (key == null) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return on;
}

const tagToasts = (icon: string, toasts: Toast[]) => toasts.map((t) => ({ ...t, text: `${icon} ${t.text}` }));

// ======================================================================== app

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const go = (v: View) => {
    setView(v);
    history.replaceState(null, '', v === 'overview' ? location.pathname : `#${v}`);
    window.scrollTo({ top: 0 });
  };

  // ---- one live socket per backend, kept open whatever view is showing
  const [lastCmd, setLastCmd] = useState<CommandResult | null>(null);
  const csms = useLiveSocket<CsmsState>(
    (msg) => {
      if (msg.type !== 'commandResult') return;
      setLastCmd({ ok: msg.ok, action: msg.action, result: msg.result, error: msg.error, at: Date.now() });
      const status = (msg.result as any)?.status;
      if (!msg.ok) csms.pushToast('error', `${msg.action}: ${msg.error}`);
      else csms.pushToast(status && !['Accepted', 'Unlocked'].includes(status) ? 'info' : 'success', `${msg.action} → ${status ?? 'OK'}`);
    },
    { base: '/csms' },
  );
  const charger = useLiveSocket<ChargerState>(undefined, { base: '/charger' });
  const rogue = useLiveSocket<RogueState>(undefined, { base: '/rogue' });

  const rogueAct = (a: RogueAction) => rogue.send(a);

  // ---- keyboard: 1-4 switch views, A arms / disarms the rogue node
  const rogueRef = useRef(rogue);
  rogueRef.current = rogue;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      const v = VIEWS.find((x) => x.key === e.key);
      if (v) return go(v.id);
      if (e.key.toLowerCase() === 'a' && rogueRef.current.state) {
        rogueRef.current.send({ type: 'arm', on: !rogueRef.current.state.armed });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- re-render every second for "x s ago" labels and the clock
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const live = {
    csms: csms.connected && !!csms.state,
    charger: charger.connected && !!charger.state,
    rogue: rogue.connected && !!rogue.state,
  };
  const armed = !!rogue.state?.armed;

  return (
    <div className={`demo ${armed ? 'is-armed' : ''}`}>
      <nav className="demo-nav">
        <div className="demo-brand">
          <div className="demo-logo">⚡</div>
          <div>
            OCPP Live Demo
            <small>CSMS · charger · rogue node</small>
          </div>
        </div>
        <div className="demo-tabs" role="tablist">
          {VIEWS.map((v) => {
            const isLive = v.id === 'overview' ? live.csms && live.charger && live.rogue : live[v.id];
            return (
              <button key={v.id} role="tab" aria-selected={view === v.id} className={`demo-tab ${view === v.id ? 'on' : ''} tab-${v.id}`} onClick={() => go(v.id)}>
                <span className="tab-icon">{v.icon}</span>
                {v.label}
                <i className={`tab-dot ${isLive ? 'live' : ''}`} />
                <kbd>{v.key}</kbd>
              </button>
            );
          })}
        </div>
        <div className="spacer" />
        {rogue.state && (
          <button className={`arm-chip ${armed ? 'armed' : ''}`} onClick={() => rogueAct({ type: 'arm', on: !armed })} title="Arm / disarm the rogue node (A)">
            {armed ? '☠ Rogue ARMED' : '☠ Rogue idle'}
            <kbd>A</kbd>
          </button>
        )}
        <span className="demo-clock mono">{new Date().toLocaleTimeString([], { hour12: false })}</span>
      </nav>

      {view === 'overview' ? (
        <Overview csms={csms} charger={charger} rogue={rogue} lastCmd={lastCmd} live={live} go={go} />
      ) : (
        <FullView key={view} view={view} />
      )}

      {view === 'overview' && (
        <Toasts toasts={[...tagToasts('🛰', csms.toasts), ...tagToasts('⚡', charger.toasts), ...tagToasts('☠️', rogue.toasts)].sort((a, b) => a.id - b.id).slice(-5)} />
      )}
    </div>
  );
}

/** One of the original apps, full size, inside the dashboard. */
function FullView({ view }: { view: Exclude<View, 'overview'> }) {
  const app = { csms: <CsmsApp />, charger: <ChargerApp />, rogue: <RogueApp /> }[view];
  return (
    <LiveSocketBase.Provider value={`/${view}`}>
      <div className={`scope-${view} is-page full-view`}>{app}</div>
    </LiveSocketBase.Provider>
  );
}

// =================================================================== overview

type Sock<S> = ReturnType<typeof useLiveSocket<S>>;

function Overview({
  csms,
  charger,
  rogue,
  lastCmd,
  live,
  go,
}: {
  csms: Sock<CsmsState>;
  charger: Sock<ChargerState>;
  rogue: Sock<RogueState>;
  lastCmd: CommandResult | null;
  live: Record<'csms' | 'charger' | 'rogue', boolean>;
  go: (v: View) => void;
}) {
  const cs = csms.state;
  const ch = charger.state;
  const rg = rogue.state;

  // CSMS: which station the remote-control panel targets. Prefer the real charger.
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!cs) return;
    const exists = cs.chargers.find((c) => c.id === selected);
    if (!exists || (!exists.connected && cs.chargers.some((c) => c.connected))) {
      const preferred = cs.chargers.find((c) => c.connected && c.id === ch?.config.chargePointId);
      setSelected(preferred?.id ?? cs.chargers.find((c) => c.connected)?.id ?? cs.chargers[0]?.id ?? null);
    }
  }, [cs, selected, ch?.config.chargePointId]);
  const reqId = useRef(0);
  const run = (cmd: Command) => {
    if (!selected) return;
    csms.send({ type: 'command', reqId: ++reqId.current, chargerId: selected, cmd } satisfies UiToServer);
  };

  const act = (a: ChargerAction) => charger.send(a);
  const liveTxs = cs?.transactions.filter((t) => !t.stoppedAt) ?? [];
  const livePower = liveTxs.reduce((sum, t) => sum + t.powerW, 0);
  const chOnline = !!ch && ch.connection.state === 'connected' && ch.connection.bootStatus === 'Accepted';
  const attackFlash = useFlash(rg?.stats.lastAttack?.at);

  // Message flow: the CSMS sees every station; or zoom into one side's own view.
  const [flow, setFlow] = useState<'csms' | 'charger' | 'rogue'>('csms');
  const flowLogs: { logs: LogEntry[]; perspective: 'csms' | 'charger'; clear: () => void; title: string } = {
    csms: { logs: csms.logs, perspective: 'csms' as const, clear: () => csms.setLogs([]), title: 'OCPP traffic · all stations' },
    charger: { logs: charger.logs, perspective: 'charger' as const, clear: () => charger.setLogs([]), title: `OCPP traffic · ${ch?.config.chargePointId ?? 'charger'}` },
    rogue: { logs: rogue.logs, perspective: 'charger' as const, clear: () => rogue.setLogs([]), title: `OCPP traffic · ${rg?.config.chargePointId ?? 'rogue'}` },
  }[flow];

  return (
    <main className={`mc ${attackFlash ? 'hit' : ''}`}>
      {/* ------------------------------------------------------------ KPIs */}
      <div className="kpis">
        <Kpi label="Stations online" value={cs ? cs.chargers.filter((c) => c.connected).length : '–'} unit={cs ? `/ ${cs.chargers.length}` : ''} />
        <Kpi label="Live power" value={kw(livePower)} unit="kW" tone="charge" glow={livePower > 0} />
        <Kpi label="Live sessions" value={liveTxs.length} />
        <Kpi label="Energy delivered" value={cs ? kwh(cs.totals.energyWh) : '–'} unit="kWh" />
        <Kpi
          label={`${ch?.config.chargePointId ?? 'Charger'} status`}
          value={!ch ? 'offline' : chOnline ? (ch.connectors.some((c) => c.transaction) ? 'charging' : 'online') : ch.connection.state}
          tone={chOnline ? 'ok' : 'bad'}
          note={rg?.armed && chOnline ? 'still serving under attack' : undefined}
        />
        <Kpi
          label={`${rg?.config.chargePointId ?? 'Rogue'} probes`}
          value={rg ? rg.stats.framesSent.toLocaleString() : '–'}
          unit="frames"
          tone={rg?.armed ? 'danger' : undefined}
          glow={attackFlash}
          note={rg ? (rg.armed ? `armed · last ${ago(rg.stats.lastAttack?.at ?? null)}` : 'disarmed') : undefined}
        />
      </div>

      <div className="mc-grid">
        {/* -------------------------------------------------- charger side */}
        <div className="mc-col mc-charger scope-charger">
          <Zone
            icon="⚡"
            title="Charging station"
            sub={ch ? `${ch.config.chargePointId} · ${ch.config.vendor} ${ch.config.model}` : 'charger simulator'}
            live={live.charger}
            onExpand={() => go('charger')}
            tools={
              ch && (
                <>
                  <span className={`badge tone-${chOnline ? 'ok' : ch.connection.state === 'disconnected' ? 'bad' : 'warn'}`}>
                    {chOnline ? 'Online' : ch.connection.state === 'connected' ? `Boot ${ch.connection.bootStatus}` : ch.connection.state === 'connecting' ? 'Connecting' : 'Offline'}
                  </span>
                  <div className="seg" title="OCPP protocol version">
                    {(['ocpp1.6', 'ocpp2.0.1'] as OcppVersion[]).map((v) => (
                      <button key={v} className={ch.config.version === v ? 'on' : ''} onClick={() => v !== ch.config.version && act({ type: 'config', config: { version: v } })}>
                        {v === 'ocpp1.6' ? '1.6J' : '2.0.1'}
                      </button>
                    ))}
                  </div>
                  <div className="seg" title="Simulation speed">
                    {SPEEDS.map((v) => (
                      <button key={v} className={ch.simSpeed === v ? 'on' : ''} onClick={() => act({ type: 'speed', value: v })}>
                        ×{v}
                      </button>
                    ))}
                  </div>
                  {ch.connection.state === 'disconnected' ? (
                    <button className="btn btn-sm btn-primary" onClick={() => act({ type: 'connect' })}>
                      Connect
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => act({ type: 'disconnect' })}>
                      Disconnect
                    </button>
                  )}
                </>
              )
            }
          >
            {ch ? (
              <section className="panel stage">
                <ConnectorCard c={ch.connectors[0]} cars={ch.cars} cards={ch.cards} online={chOnline} act={act} side="left" />
                <Pillar s={ch} />
                <ConnectorCard c={ch.connectors[1]} cars={ch.cars} cards={ch.cards} online={chOnline} act={act} side="right" />
              </section>
            ) : (
              <Waiting what="charger simulator" />
            )}
          </Zone>

          <div className="scope-csms">
            <section className="panel">
              <header className="panel-head">
                <h2>📈 Live power</h2>
                <div className="legend">
                  {liveTxs.length === 0 && <span className="small muted">no session running · plug a car in and tap a card</span>}
                  {liveTxs.map((t) => (
                    <span key={t.id} className="small">
                      <i style={{ background: colorFor(t.connectorId) }} /> {t.chargerId} #{t.connectorId} · {kw(t.powerW)} kW
                      {t.soc !== null ? ` · ${Math.round(t.soc)}%` : ''}
                    </span>
                  ))}
                </div>
              </header>
              <div className="panel-body">
                <PowerChart txs={liveTxs} />
              </div>
            </section>
          </div>
        </div>

        {/* ----------------------------------------------------- CSMS side */}
        <div className={`mc-col mc-csms scope-csms ${attackFlash && rg?.armed ? 'shield' : ''}`}>
          <Zone icon="🛰" title="Central system" sub={cs ? `OCPP endpoint :${cs.ocppPort}/ocpp` : 'CSMS'} live={live.csms} onExpand={() => go('csms')}>
            {cs ? (
              <>
                <ChargersPanel chargers={cs.chargers} selected={selected} onSelect={setSelected} onDisconnect={(id) => csms.send({ type: 'disconnect', chargerId: id } satisfies UiToServer)} />
                <RemoteControl charger={cs.chargers.find((c) => c.id === selected)} state={cs} run={run} last={lastCmd} />
              </>
            ) : (
              <Waiting what="CSMS" />
            )}
          </Zone>
        </div>

        {/* ---------------------------------------------- rogue + traffic */}
        <div className="mc-col mc-side">
          <div className="scope-rogue">
            <Zone icon="☠️" title="Rogue charger" sub={rg ? `${rg.config.chargePointId} · test node` : 'rogue node'} live={live.rogue} onExpand={() => go('rogue')} danger>
              {rg ? <RogueCard s={rg} act={(a) => rogue.send(a)} flash={attackFlash} /> : <Waiting what="rogue charger" />}
            </Zone>
          </div>
          <div className="mc-flow">
            <div className="seg flow-seg">
              <button className={flow === 'csms' ? 'on' : ''} onClick={() => setFlow('csms')}>
                🛰 All (CSMS)
              </button>
              <button className={flow === 'charger' ? 'on' : ''} onClick={() => setFlow('charger')}>
                ⚡ {ch?.config.chargePointId ?? 'Charger'}
              </button>
              <button className={flow === 'rogue' ? 'on' : ''} onClick={() => setFlow('rogue')}>
                ☠️ {rg?.config.chargePointId ?? 'Rogue'}
              </button>
            </div>
            <MessageInspector key={flow} logs={flowLogs.logs} perspective={flowLogs.perspective} onClear={flowLogs.clear} title={flowLogs.title} />
          </div>
        </div>
      </div>

      <footer className="mc-foot muted small">
        Shortcuts: <kbd>1</kbd>–<kbd>4</kbd> switch views · <kbd>A</kbd> arm / disarm the rogue node. Every control here talks to the real simulators — the
        separate GUIs on :8080 / :8081 / :8082 stay in sync.
      </footer>
    </main>
  );
}

// ================================================================= pieces

function Kpi({
  label,
  value,
  unit,
  tone,
  glow,
  note,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: 'charge' | 'ok' | 'bad' | 'danger';
  glow?: boolean;
  note?: string;
}) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''} ${glow ? 'glow' : ''}`}>
      <span className="kpi-label">{label}</span>
      <b className="kpi-value">
        {value}
        {unit && <small> {unit}</small>}
      </b>
      {note && <span className="kpi-note">{note}</span>}
    </div>
  );
}

function Zone({
  icon,
  title,
  sub,
  live,
  tools,
  onExpand,
  danger,
  children,
}: {
  icon: string;
  title: string;
  sub: string;
  live: boolean;
  tools?: ReactNode;
  onExpand: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`zone ${danger ? 'zone-danger' : ''}`}>
      <header className="zone-head">
        <span className="zone-icon">{icon}</span>
        <div className="zone-title">
          <b>{title}</b>
          <span className="mono">{sub}</span>
        </div>
        <i className={`zone-live ${live ? 'on' : ''}`} title={live ? 'connected' : 'not reachable'} />
        <div className="spacer" />
        {tools && <div className="zone-tools">{tools}</div>}
        <button className="zone-expand" onClick={onExpand} title="Open the full GUI here">
          ⤢
        </button>
      </header>
      <div className="zone-body">{children}</div>
    </div>
  );
}

function Waiting({ what }: { what: string }) {
  return (
    <div className="panel waiting">
      <div className="spinner" />
      <p>
        Waiting for the {what}…
        <br />
        <span className="small muted">It reconnects on its own as soon as the container is up.</span>
      </p>
    </div>
  );
}

function RogueTarget({ s, act }: { s: RogueState; act: (a: RogueAction) => void }) {
  const current = s.config.csmsUrl;
  const [draft, setDraft] = useState(current);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(current);
  }, [current, editing]);

  const trimmed = draft.trim();
  const valid = /^wss?:\/\/.+/i.test(trimmed);
  const dirty = trimmed !== current;
  const apply = () => {
    if (!valid || !dirty) return;
    act({ type: 'setTarget', csmsUrl: trimmed });
    setEditing(false);
  };

  return (
    <div className="rc-target">
      <span className="rc-label">🎯 Target</span>
      <input
        className={`rc-target-input mono ${!valid && trimmed ? 'invalid' : ''}`}
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
      <button className="chip-btn" disabled={!valid || !dirty} onClick={apply} title="Reconnect to this CSMS">
        set
      </button>
      {current !== s.defaultCsmsUrl && (
        <button
          className="chip-btn"
          title={`Reset to default (${s.defaultCsmsUrl})`}
          onClick={() => {
            setEditing(false);
            act({ type: 'setTarget', csmsUrl: s.defaultCsmsUrl });
          }}
        >
          reset
        </button>
      )}
    </div>
  );
}

function RogueCard({ s, act, flash }: { s: RogueState; act: (a: RogueAction) => void; flash: boolean }) {
  const enabled = ATTACKS.filter((a) => s.attacks[a.id]).length;
  const c = s.connection;
  const tone = c.state === 'connected' ? 'ok' : c.state === 'connecting' ? 'warn' : 'bad';
  const last = s.stats.lastAttack;
  return (
    <section className={`panel rogue-card ${s.armed ? 'armed' : ''} ${flash ? 'flash' : ''}`}>
      <div className="rc-top">
        <button className={`arm-btn ${s.armed ? 'armed' : ''}`} onClick={() => act({ type: 'arm', on: !s.armed })}>
          {s.armed ? '■ ARMED · click to disarm' : '▶ DISARMED · click to arm'}
        </button>
        <div className="rc-conn">
          <span className={`badge tone-${tone}`}>{c.state === 'connected' ? 'connected' : c.state === 'connecting' ? 'connecting' : 'offline'}</span>
          {c.state === 'disconnected' ? (
            <button className="chip-btn" onClick={() => act({ type: 'connect' })}>
              connect
            </button>
          ) : (
            <button className="chip-btn" onClick={() => act({ type: 'disconnect' })}>
              disconnect
            </button>
          )}
        </div>
      </div>

      <RogueTarget s={s} act={act} />

      <div className="rc-stats">
        <div>
          <b className="mono">{s.stats.framesSent.toLocaleString()}</b>
          <span>frames</span>
        </div>
        <div>
          <b className="mono">
            {enabled}/{ATTACKS.length}
          </b>
          <span>modes on</span>
        </div>
        <div>
          <b className="mono">{s.stats.injectionProbes}</b>
          <span>injection probes</span>
        </div>
        <div>
          <b className="mono">{c.socketOpens}</b>
          <span>socket opens</span>
        </div>
      </div>

      <div className="rc-row">
        <span className="rc-label">Intensity</span>
        <div className="seg">
          {INTENSITIES.map((v) => (
            <button key={v} className={s.config.intensity === v ? 'on' : ''} onClick={() => act({ type: 'intensity', value: v })}>
              ×{v}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="chip-btn" onClick={() => act({ type: 'all', on: true })}>
          all on
        </button>
        <button className="chip-btn" onClick={() => act({ type: 'all', on: false })}>
          all off
        </button>
      </div>

      <ul className="rc-attacks">
        {ATTACKS.map((a) => {
          const on = s.attacks[a.id];
          const fired = s.stats.attacksFired[a.id] ?? 0;
          const hot = last?.id === a.id && Date.now() - last.at < 1500;
          const oneShot = a.id !== 'reconnectStorm';
          return (
            <li key={a.id} className={`${on ? 'on' : ''} ${hot ? 'hot' : ''}`} title={a.blurb}>
              <label className="switch">
                <input type="checkbox" checked={on} onChange={(e) => act({ type: 'toggle', attack: a.id, on: e.target.checked })} />
                <span />
              </label>
              <span className="rc-name">{a.label}</span>
              <span className="rc-count mono">{fired || ''}</span>
              <button className="rc-fire" disabled={!oneShot} onClick={() => act({ type: 'burst', attack: a.id })} title={oneShot ? 'Fire once' : 'Continuous mode only'}>
                ⚡
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
