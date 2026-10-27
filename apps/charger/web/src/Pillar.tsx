import { versionLabel } from '@sim/ocpp';
import type { ChargerState } from '../../server/types.ts';

/** The charger itself: a tall pillar with a screen and an LED strip. */
export function Pillar({ s }: { s: ChargerState }) {
  const charging = s.connectors.some((c) => c.status === 'Charging');
  const fault = s.connectors.some((c) => c.faulted);
  const online = s.connection.state === 'connected' && s.connection.bootStatus === 'Accepted';
  const led = fault ? 'led-bad' : charging ? 'led-charge' : online ? 'led-ok' : 'led-off';
  return (
    <div className="pillar-wrap">
      <div className={`pillar ${led}`}>
        <div className="pillar-top">
          <span className="pillar-brand">{s.config.vendor}</span>
          <span className="pillar-model">{s.config.model}</span>
        </div>
        <div className="screen">
          <div className="screen-row">
            <span>{s.config.chargePointId}</span>
            <span className={online ? 'ok' : 'off'}>{online ? '● online' : s.connection.state === 'connecting' ? '◌ connecting' : '○ offline'}</span>
          </div>
          <div className="screen-proto">{versionLabel(s.config.version)}</div>
          {s.connectors.map((c) => (
            <div key={c.id} className="screen-line">
              <b>{c.id}</b> {c.display}
            </div>
          ))}
        </div>
        <div className="nfc-pad">
          <span>)))</span>
          <small>RFID</small>
        </div>
        <div className="led-strip" />
        <div className="holsters">
          {s.connectors.map((c) => (
            <div key={c.id} className={`holster ${c.car ? 'out' : ''}`}>
              {c.type}
            </div>
          ))}
        </div>
      </div>
      <div className="pillar-base" />
    </div>
  );
}
