import type { LogEntry } from '@sim/ocpp';
import type { ChargerState } from '../../server/types.ts';

interface Step {
  title: string;
  hint: string;
  done: (logs: LogEntry[]) => boolean;
}

const has = (logs: LogEntry[], pred: (e: LogEntry) => boolean) => logs.some(pred);
const call = (action: string, pred: (p: any) => boolean = () => true) => (logs: LogEntry[]) =>
  has(logs, (e) => e.kind === 'CALL' && e.action === action && pred(e.payload));

function steps(v16: boolean): Step[] {
  return [
    {
      title: 'Boot',
      hint: 'On connect the charger sends BootNotification and waits for Accepted.',
      done: (l) => has(l, (e) => e.kind === 'CALLRESULT' && e.action === 'BootNotification' && (e.payload as any)?.status === 'Accepted'),
    },
    { title: 'Heartbeat', hint: 'Every interval the charger proves it is alive. Wait for it, or trigger one from the CSMS.', done: call('Heartbeat') },
    {
      title: 'Plug in a car',
      hint: v16 ? 'StatusNotification goes from Available to Preparing.' : 'StatusNotification goes from Available to Occupied.',
      done: call('StatusNotification', (p) => (v16 ? p.status === 'Preparing' : p.connectorStatus === 'Occupied')),
    },
    { title: 'Tap a card', hint: 'Authorize asks the CSMS if this RFID card may charge. Try BLOCKED-6666 too.', done: call('Authorize') },
    {
      title: 'Start the session',
      hint: v16 ? 'StartTransaction: the CSMS hands back a transactionId.' : 'TransactionEvent(Started): the charger makes up a UUID transactionId.',
      done: v16 ? call('StartTransaction') : call('TransactionEvent', (p) => p.eventType === 'Started'),
    },
    {
      title: 'Meter values',
      hint: v16 ? 'MeterValues arrive every few seconds with energy, power and SoC.' : 'TransactionEvent(Updated) carries meter values with triggerReason MeterValuePeriodic.',
      done: v16 ? call('MeterValues') : call('TransactionEvent', (p) => p.eventType === 'Updated'),
    },
    {
      title: 'Smart charging',
      hint: 'From the CSMS dashboard, set a power limit. Watch SetChargingProfile arrive and the power drop.',
      done: call('SetChargingProfile'),
    },
    {
      title: 'Stop',
      hint: v16 ? 'Tap the same card, press Stop, or remote stop. StopTransaction closes the session.' : 'Tap the same card, press Stop, or remote stop. TransactionEvent(Ended) closes the session.',
      done: v16 ? call('StopTransaction') : call('TransactionEvent', (p) => p.eventType === 'Ended'),
    },
    {
      title: 'Remote start',
      hint: 'Start a session from the CSMS dashboard instead of with a card.',
      done: v16 ? call('RemoteStartTransaction') : call('RequestStartTransaction'),
    },
  ];
}

export function Learn({ s, logs }: { s: ChargerState; logs: LogEntry[] }) {
  const v16 = s.config.version === 'ocpp1.6';
  const relevant = logs.filter((l) => l.version === s.config.version);
  const list = steps(v16).map((st) => ({ ...st, ok: st.done(relevant) }));
  const doneCount = list.filter((x) => x.ok).length;
  const nextIdx = list.findIndex((x) => !x.ok);
  return (
    <section className="panel learn">
      <header className="panel-head">
        <h2>🎓 Guided session</h2>
        <span className="muted small">
          {doneCount}/{list.length} done
        </span>
      </header>
      <div className="learn-progress">
        <div style={{ width: `${(doneCount / list.length) * 100}%` }} />
      </div>
      <ol className="learn-list">
        {list.map((st, i) => (
          <li key={st.title} className={st.ok ? 'ok' : i === nextIdx ? 'next' : ''}>
            <span className="learn-check">{st.ok ? '✓' : i + 1}</span>
            <div>
              <b>{st.title}</b>
              <p>{st.hint}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
