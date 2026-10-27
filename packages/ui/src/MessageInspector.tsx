import { useEffect, useMemo, useRef, useState } from 'react';
import { describeAction, versionLabel, type LogEntry } from '@sim/ocpp';
import { JsonView } from './JsonView.tsx';
import { clock } from './format.ts';

interface Props {
  logs: LogEntry[];
  /** Which side of the wire this GUI is on: decides which way the arrows point. */
  perspective: 'charger' | 'csms';
  onClear?: () => void;
  title?: string;
}

const isFromCharger = (e: LogEntry, perspective: Props['perspective']) =>
  perspective === 'charger' ? e.dir === 'out' : e.dir === 'in';

/**
 * The live OCPP message log, drawn as a sequence diagram: the charger on the
 * left, the CSMS on the right, one arrow per WebSocket frame.
 */
export function MessageInspector({ logs, perspective, onClear, title = 'OCPP message flow' }: Props) {
  const [filter, setFilter] = useState('');
  const [hideHeartbeat, setHideHeartbeat] = useState(false);
  const [paused, setPaused] = useState<LogEntry[] | null>(null);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const source = paused ?? logs;
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return source.filter((e) => {
      if (hideHeartbeat && e.action === 'Heartbeat') return false;
      if (!f) return true;
      return e.action.toLowerCase().includes(f) || e.raw.toLowerCase().includes(f) || (e.peer ?? '').toLowerCase().includes(f);
    });
  }, [source, filter, hideHeartbeat]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const pair = selected ? logs.find((e) => e.messageId === selected.messageId && e.seq !== selected.seq) : undefined;
  const request = selected?.kind === 'CALL' ? selected : pair?.kind === 'CALL' ? pair : undefined;
  const response = selected && selected.kind !== 'CALL' ? selected : pair && pair.kind !== 'CALL' ? pair : undefined;
  const info = selected ? describeAction(selected.action) : undefined;

  return (
    <section className="panel inspector">
      <header className="panel-head">
        <h2>
          <span className="pulse-dot" /> {title}
        </h2>
        <div className="inspector-tools">
          <input className="input input-sm" placeholder="Filter (action, id, text)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className={`chip-btn ${hideHeartbeat ? 'on' : ''}`} onClick={() => setHideHeartbeat((v) => !v)} title="Hide heartbeats">
            ♥ {hideHeartbeat ? 'hidden' : 'shown'}
          </button>
          <button className={`chip-btn ${paused ? 'on' : ''}`} onClick={() => setPaused((p) => (p ? null : logs))}>
            {paused ? '▶ resume' : '❚❚ pause'}
          </button>
          {onClear && (
            <button className="chip-btn" onClick={onClear}>
              clear
            </button>
          )}
        </div>
      </header>

      <div className="lanes-head">
        <span className="lane-label">⚡ Charger</span>
        <span className="lane-label right">CSMS 🛰</span>
      </div>

      <div
        className="seq-list"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {visible.length === 0 && <div className="empty">No messages yet. Things you do will show up here as arrows.</div>}
        {visible.map((e) => {
          const right = isFromCharger(e, perspective);
          return (
            <button
              key={e.seq}
              className={`seq-row k-${e.kind} ${selected?.seq === e.seq ? 'sel' : ''} ${selected && pair?.seq === e.seq ? 'paired' : ''}`}
              onClick={() => setSelected(e)}
            >
              <span className="seq-time">{clock(e.ts)}</span>
              <span className={`seq-track ${right ? 'to-right' : 'to-left'}`}>
                <span className="seq-line" />
                <span className="seq-label">
                  <b>{e.action}</b>
                  <em className={`kind kind-${e.kind}`}>{e.kind === 'CALL' ? 'req' : e.kind === 'CALLRESULT' ? 'res' : e.errorCode}</em>
                </span>
              </span>
              <span className="seq-meta">
                {e.latencyMs !== undefined && e.kind !== 'CALL' ? `${e.latencyMs}ms` : ''}
                {perspective === 'csms' && e.peer ? <i className="peer">{e.peer}</i> : null}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="detail">
          <div className="detail-head">
            <div>
              <div className="detail-title">
                {selected.action} <span className="muted">· {versionLabel(selected.version)}</span>
              </div>
              {info ? (
                <p className="explain">
                  <b>{info.from === 'charger' ? 'Charger → CSMS.' : 'CSMS → Charger.'}</b> {info.summary} <span className="muted">{info.details}</span>
                </p>
              ) : (
                <p className="explain muted">No explanation for this action yet.</p>
              )}
            </div>
            <button className="chip-btn" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <div className="detail-grid">
            <div>
              <div className="detail-sub">
                Request <code>[2, "{request?.messageId ?? selected.messageId}", "{selected.action}", …]</code>
              </div>
              {request ? <JsonView value={request.payload} /> : <div className="muted small">not in log</div>}
            </div>
            <div>
              <div className="detail-sub">
                {response?.kind === 'CALLERROR' ? (
                  <>
                    Error <code>[4, …, "{response.errorCode}", "{response.errorDescription}", …]</code>
                  </>
                ) : (
                  <>
                    Response <code>[3, "{response?.messageId ?? '…'}", …]</code>
                    {response?.latencyMs !== undefined && <span className="muted"> · {response.latencyMs} ms</span>}
                  </>
                )}
              </div>
              {response ? <JsonView value={response.payload} /> : <div className="muted small">waiting…</div>}
            </div>
          </div>
          <details className="raw">
            <summary>Raw WebSocket frame</summary>
            <code>{selected.raw}</code>
          </details>
        </div>
      )}
    </section>
  );
}
