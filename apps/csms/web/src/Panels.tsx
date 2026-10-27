import { useEffect, useState } from 'react';
import { JsonView, ago, duration, kw, kwh, statusTone } from '@sim/ui';
import { versionLabel } from '@sim/ocpp';
import type { ChargerInfo, Command, CsmsState, IdTag, Settings, TagStatus, Transaction } from '../../server/types.ts';
import { Sparkline, colorFor } from './Charts.tsx';

export interface CommandResult {
  ok: boolean;
  action: string;
  result?: unknown;
  error?: string;
  at: number;
}

// ------------------------------------------------------------------ chargers

export function ChargersPanel({
  chargers,
  selected,
  onSelect,
  onDisconnect,
}: {
  chargers: ChargerInfo[];
  selected: string | null;
  onSelect: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>🔌 Charging stations</h2>
        <span className="muted small">{chargers.filter((c) => c.connected).length} online</span>
      </header>
      <div className="panel-body charger-list">
        {chargers.length === 0 && (
          <div className="empty">
            Waiting for a charger to connect…
            <br />
            <span className="small">Point any OCPP charger at the endpoint shown in the top bar.</span>
          </div>
        )}
        {chargers.map((c) => (
          <div key={c.id} className={`charger-card ${selected === c.id ? 'sel' : ''} ${c.connected ? '' : 'offline'}`} onClick={() => onSelect(c.id)}>
            <div className="charger-head">
              <div className="charger-icon">{c.connected ? '⚡' : '💤'}</div>
              <div className="charger-id">
                <b>{c.id}</b>
                <span className="muted small">
                  {c.vendor ?? '?'} {c.model ?? ''} {c.firmware ? `· fw ${c.firmware}` : ''}
                </span>
              </div>
              <span className={`badge ${c.version === 'ocpp1.6' ? 'tone-busy' : 'tone-charging'} ver`}>{versionLabel(c.version)}</span>
            </div>
            <div className="charger-meta">
              <span>
                <i className={`dot ${c.connected ? 'on' : ''}`} />
                {c.connected ? `online · boot ${c.bootStatus}` : 'offline'}
              </span>
              <span>seen {ago(c.lastSeen)}</span>
              {c.remoteAddress && <span className="mono">{c.remoteAddress.replace('::ffff:', '')}</span>}
              {c.connected && (
                <button
                  className="chip-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDisconnect(c.id);
                  }}
                >
                  drop connection
                </button>
              )}
            </div>
            <div className="evse-grid">
              {c.connectors.map((k) => {
                const tone = statusTone(k.status);
                return (
                  <div key={k.id} className={`evse tone-edge-${tone}`}>
                    <div className="evse-top">
                      <span className="evse-num" style={{ background: colorFor(k.id) }}>
                        {k.id}
                      </span>
                      <span className={`badge tone-${tone}`}>{k.status}</span>
                    </div>
                    <div className="evse-power">
                      {kw(k.powerW)}
                      <small> kW</small>
                    </div>
                    <div className="evse-sub muted small">
                      {k.soc !== null && k.txId ? `SoC ${Math.round(k.soc)}% · ` : ''}
                      {k.txId ? `tx ${k.txId.length > 10 ? k.txId.slice(0, 8) + '…' : k.txId}` : k.errorCode ?? 'idle'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ remote control

const TRIGGERS_16 = ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues'];
const TRIGGERS_201 = ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues', 'TransactionEvent'];

export function RemoteControl({
  charger,
  state,
  run,
  last,
}: {
  charger: ChargerInfo | undefined;
  state: CsmsState;
  run: (cmd: Command) => void;
  last: CommandResult | null;
}) {
  const [connectorId, setConnectorId] = useState(1);
  const [idTag, setIdTag] = useState(state.tags[0]?.idTag ?? '');
  const [limitKw, setLimitKw] = useState(11);
  const [trigger, setTrigger] = useState('StatusNotification');
  const [rawAction, setRawAction] = useState('TriggerMessage');
  const [rawPayload, setRawPayload] = useState('{\n  "requestedMessage": "Heartbeat"\n}');
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'buttons' | 'raw'>('buttons');

  const v16 = charger?.version === 'ocpp1.6';
  const disabled = !charger?.connected;
  const connectors = charger?.connectors.length ? charger.connectors : [{ id: 1 }, { id: 2 }];
  const activeTx = state.transactions.find((t) => !t.stoppedAt && t.chargerId === charger?.id && t.connectorId === connectorId);

  useEffect(() => {
    if (!state.tags.find((t) => t.idTag === idTag) && state.tags[0]) setIdTag(state.tags[0].idTag);
  }, [state.tags, idTag]);

  const sendRaw = () => {
    try {
      const payload = JSON.parse(rawPayload);
      setRawErr(null);
      run({ command: 'raw', action: rawAction.trim(), payload });
    } catch (e) {
      setRawErr((e as Error).message);
    }
  };

  return (
    <section className="panel remote">
      <header className="panel-head">
        <h2>🎛 Remote control {charger && <span className="muted mono small">· {charger.id}</span>}</h2>
        <div className="seg">
          <button className={tab === 'buttons' ? 'on' : ''} onClick={() => setTab('buttons')}>
            Commands
          </button>
          <button className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>
            Raw CALL
          </button>
        </div>
      </header>
      <div className="panel-body">
        {!charger && <div className="muted small">Select a charging station first.</div>}
        {charger && tab === 'buttons' && (
          <div className="cmd-grid">
            <label className="field span2">
              Target connector
              <div className="seg">
                {connectors.map((k) => (
                  <button key={k.id} className={connectorId === k.id ? 'on' : ''} onClick={() => setConnectorId(k.id)}>
                    #{k.id}
                  </button>
                ))}
              </div>
            </label>

            <div className="cmd">
              <div className="cmd-title">Start / stop</div>
              <div className="cmd-row">
                <select className="select" value={idTag} onChange={(e) => setIdTag(e.target.value)}>
                  {state.tags.map((t) => (
                    <option key={t.idTag} value={t.idTag}>
                      {t.idTag}
                    </option>
                  ))}
                </select>
                <button className="btn btn-charge" disabled={disabled || !!activeTx} onClick={() => run({ command: 'remoteStart', connectorId, idTag })}>
                  ▶ Start
                </button>
              </div>
              <button className="btn" disabled={disabled || !activeTx} onClick={() => activeTx && run({ command: 'remoteStop', transactionId: activeTx.id })}>
                ■ Stop {activeTx ? <span className="mono small">tx {activeTx.id.slice(0, 8)}</span> : ''}
              </button>
              <div className="cmd-note">{v16 ? 'RemoteStartTransaction / RemoteStopTransaction' : 'RequestStartTransaction / RequestStopTransaction'}</div>
            </div>

            <div className="cmd">
              <div className="cmd-title">Smart charging</div>
              <div className="cmd-row">
                <input type="range" min={0} max={150} step={1} value={limitKw} onChange={(e) => setLimitKw(Number(e.target.value))} />
                <b className="mono limit-val">{limitKw} kW</b>
              </div>
              <div className="cmd-row">
                <button className="btn btn-primary" disabled={disabled} onClick={() => run({ command: 'setLimit', connectorId, limit: limitKw * 1000, unit: 'W' })}>
                  Set limit
                </button>
                <button className="btn" disabled={disabled} onClick={() => run({ command: 'clearLimit', connectorId })}>
                  Clear
                </button>
              </div>
              <div className="cmd-note">SetChargingProfile (TxDefaultProfile, W)</div>
            </div>

            <div className="cmd">
              <div className="cmd-title">Connector</div>
              <div className="cmd-row">
                <button className="btn" disabled={disabled} onClick={() => run({ command: 'availability', connectorId, operative: false })}>
                  ⛔ Inoperative
                </button>
                <button className="btn" disabled={disabled} onClick={() => run({ command: 'availability', connectorId, operative: true })}>
                  ✅ Operative
                </button>
              </div>
              <button className="btn" disabled={disabled} onClick={() => run({ command: 'unlock', connectorId })}>
                🔓 Unlock connector
              </button>
              <div className="cmd-note">ChangeAvailability · UnlockConnector</div>
            </div>

            <div className="cmd">
              <div className="cmd-title">Station</div>
              <div className="cmd-row">
                <select className="select" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                  {(v16 ? TRIGGERS_16 : TRIGGERS_201).map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <button className="btn" disabled={disabled} onClick={() => run({ command: 'trigger', message: trigger, connectorId })}>
                  Trigger
                </button>
              </div>
              <div className="cmd-row">
                {(v16 ? ['Soft', 'Hard'] : ['OnIdle', 'Immediate']).map((t) => (
                  <button key={t} className="btn btn-danger" disabled={disabled} onClick={() => run({ command: 'reset', type: t })}>
                    ↻ {t}
                  </button>
                ))}
              </div>
              <div className="cmd-note">TriggerMessage · Reset</div>
            </div>
          </div>
        )}
        {charger && tab === 'raw' && (
          <div className="raw-console">
            <p className="muted small">
              Send any CALL to the charger, exactly as you type it. Try a bad payload to see a {v16 ? 'FormationViolation' : 'FormatViolation'}, or an unknown action for
              NotImplemented.
            </p>
            <label className="field">
              Action
              <input className="input mono" value={rawAction} onChange={(e) => setRawAction(e.target.value)} />
            </label>
            <label className="field">
              Payload (JSON)
              <textarea className="input mono" rows={6} value={rawPayload} onChange={(e) => setRawPayload(e.target.value)} />
            </label>
            {rawErr && <div className="err small">{rawErr}</div>}
            <button className="btn btn-primary" disabled={disabled} onClick={sendRaw}>
              Send [2, id, "{rawAction}", …]
            </button>
          </div>
        )}
        {last && (
          <div className={`last-result ${last.ok ? 'ok' : 'bad'}`}>
            <div className="small">
              <b>{last.action}</b> → {last.ok ? 'response' : 'error'} <span className="muted">{ago(last.at)}</span>
            </div>
            {last.ok ? <JsonView value={last.result} /> : <code className="err">{last.error}</code>}
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ sessions

export function SessionsPanel({ txs, tags }: { txs: Transaction[]; tags: IdTag[] }) {
  const label = (idTag: string) => tags.find((t) => t.idTag === idTag)?.label;
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>🧾 Sessions</h2>
        <span className="muted small">{txs.length} recorded</span>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Station</th>
              <th>Driver</th>
              <th>Duration</th>
              <th>Energy</th>
              <th>Power</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {txs.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No sessions yet.
                </td>
              </tr>
            )}
            {txs.map((t) => (
              <tr key={`${t.chargerId}-${t.id}`}>
                <td className="mono" title={t.id}>
                  {t.id.length > 12 ? t.id.slice(0, 8) + '…' : t.id}
                </td>
                <td>
                  {t.chargerId} <span className="conn-dot" style={{ background: colorFor(t.connectorId) }}>{t.connectorId}</span>
                </td>
                <td>
                  <span className="mono">{t.idTag}</span>
                  {label(t.idTag) && <div className="muted small">{label(t.idTag)}</div>}
                </td>
                <td title={new Date(t.startedAt).toLocaleString()}>{duration((t.stoppedAt ?? Date.now()) - t.startedAt)}</td>
                <td className="mono">{kwh(t.energyWh)} kWh</td>
                <td>
                  <Sparkline tx={t} />
                </td>
                <td>{t.stoppedAt ? <span className="badge tone-off">{t.stopReason}</span> : <span className="badge tone-charging">live</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ id tags

const TAG_STATUSES: TagStatus[] = ['Accepted', 'Blocked', 'Expired'];

export function TagsPanel({ tags, upsert, remove }: { tags: IdTag[]; upsert: (t: IdTag) => void; remove: (id: string) => void }) {
  const [idTag, setIdTag] = useState('');
  const [label, setLabel] = useState('');
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>🪪 Authorization list</h2>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>ID tag</th>
              <th>Owner</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.idTag}>
                <td className="mono">{t.idTag}</td>
                <td className="muted">{t.label}</td>
                <td>
                  <select className={`select select-sm st-${t.status}`} value={t.status} onChange={(e) => upsert({ ...t, status: e.target.value as TagStatus })}>
                    {TAG_STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button className="chip-btn" onClick={() => remove(t.idTag)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="panel-body tag-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!idTag.trim()) return;
          upsert({ idTag: idTag.trim().slice(0, 20), label: label.trim() || 'New card', status: 'Accepted' });
          setIdTag('');
          setLabel('');
        }}
      >
        <input className="input mono" placeholder="UNKNOWN-9999" value={idTag} onChange={(e) => setIdTag(e.target.value)} />
        <input className="input" placeholder="Owner" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn">Add</button>
      </form>
      <p className="panel-body muted small tag-hint">
        Unknown cards get <b>Invalid</b>. A card already charging elsewhere gets <b>ConcurrentTx</b>.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ settings

export function SettingsPanel({ settings, update }: { settings: Settings; update: (s: Partial<Settings>) => void }) {
  return (
    <div className="settings-pop panel">
      <label className="field">
        Heartbeat interval (s)
        <input
          className="input"
          type="number"
          min={5}
          value={settings.heartbeatIntervalS}
          onChange={(e) => update({ heartbeatIntervalS: Math.max(5, Number(e.target.value) || 30) })}
        />
      </label>
      <label className="field">
        Answer BootNotification with
        <div className="seg">
          {(['Accepted', 'Pending', 'Rejected'] as const).map((p) => (
            <button key={p} className={settings.bootPolicy === p ? 'on' : ''} onClick={() => update({ bootPolicy: p })}>
              {p}
            </button>
          ))}
        </div>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.acceptUnknownTags} onChange={(e) => update({ acceptUnknownTags: e.target.checked })} />
        Accept unknown RFID cards
      </label>
      <p className="muted small">Boot and heartbeat changes apply the next time a charger boots (try a Reset).</p>
    </div>
  );
}
