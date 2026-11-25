import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { versionLabel, type FrameKind, type LogEntry, type OcppVersion } from '@sim/ocpp';
import { ATTACKS, type AttackFlags, type AttackId, type RogueConfig, type RogueState } from './types.ts';

const RECONNECT_DELAY_MS = 4000;
const STORM_DELAY_MS = 600;
const MAX_LOGS = 600;

/** Vendor/model strings that make the node obvious on the CSMS dashboard. */
const IDENTITY = {
  vendor: 'ROGUE-TESTNODE',
  model: 'DoNotTrust 666',
  serial: 'RGUE-000666',
  firmware: '0.0.0-evil',
};

const now = () => new Date().toISOString();
let globalSeq = 0;

function blankCounts(): Record<AttackId, number> {
  return Object.fromEntries(ATTACKS.map((a) => [a.id, 0])) as Record<AttackId, number>;
}

const rand = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: T[]): T => xs[rand(xs.length)];

/**
 * A deliberately misbehaving ("rogue" / faulty) OCPP charge point. It connects
 * to a real CSMS and, when armed, exercises the server's robustness with a
 * configurable mix of spec-violating and abusive behaviours.
 *
 * It does NOT use the shared RpcEndpoint on purpose: the whole point is to break
 * the rules that endpoint enforces (one call in flight, valid framing, valid
 * payloads), so it writes raw strings straight onto the socket.
 *
 * Scope: a local testing tool aimed at the user's own CSMS sandbox.
 */
export class RogueCharger extends EventEmitter {
  config: RogueConfig;
  armed: boolean;
  logs: LogEntry[] = [];

  private attacks: AttackFlags;
  private ws: WebSocket | null = null;
  private wantConnected = true;
  private connState: RogueState['connection'] = {
    state: 'disconnected',
    connectedAt: null,
    socketOpens: 0,
    error: null,
  };

  private timers = new Map<AttackId, NodeJS.Timeout>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stormTimer: NodeJS.Timeout | null = null;

  private stats: RogueState['stats'] = {
    framesSent: 0,
    attacksFired: blankCounts(),
    commandsIgnored: 0,
    lastAttack: null,
  };

  /** Pool of messageIds we have used, so `replay` can re-send old ones. */
  private usedIds: string[] = [];
  /** Transaction ids we pretend exist (none of these were ever started). */
  private phantomTxId = 90000;

  constructor(config: RogueConfig, attacks: AttackFlags, armed: boolean) {
    super();
    this.config = config;
    this.attacks = attacks;
    this.armed = armed;
  }

  // ------------------------------------------------------------------ lifecycle

  connect() {
    this.wantConnected = true;
    this.openSocket();
  }

  disconnect() {
    this.wantConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, 'Disconnected from GUI');
  }

  shutdown() {
    this.wantConnected = false;
    this.stopAllTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private openSocket() {
    if (this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const url = `${this.config.csmsUrl.replace(/\/+$/, '')}/${encodeURIComponent(this.config.chargePointId)}`;
    this.connState = { ...this.connState, state: 'connecting', error: null };
    this.emitState();

    const ws = new WebSocket(url, [this.config.version]);
    this.ws = ws;

    ws.on('open', () => {
      this.connState = {
        ...this.connState,
        state: 'connected',
        connectedAt: Date.now(),
        socketOpens: this.connState.socketOpens + 1,
      };
      this.emitState();
      // Boot once so the CSMS registers us (with obviously-rogue identity),
      // then start whatever attacks are armed.
      this.sendBoot();
      this.rescheduleAttacks();
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('error', (err) => {
      this.connState = { ...this.connState, error: err.message };
    });
    ws.on('close', () => {
      this.ws = null;
      this.stopAllTimers();
      this.connState = { ...this.connState, state: 'disconnected', connectedAt: null };
      this.emitState();
      if (this.wantConnected) {
        const delay = this.armed && this.attacks.reconnectStorm ? STORM_DELAY_MS : RECONNECT_DELAY_MS;
        this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
      }
    });
  }

  // ------------------------------------------------------------------ control

  setArmed(on: boolean) {
    this.armed = on;
    this.rescheduleAttacks();
    this.toast(on ? 'error' : 'info', on ? 'Armed — misbehaving against the CSMS' : 'Disarmed — behaving normally');
    this.emitState();
  }

  toggle(attack: AttackId, on: boolean) {
    this.attacks[attack] = on;
    this.rescheduleAttacks();
    this.emitState();
  }

  setAll(on: boolean) {
    for (const a of ATTACKS) this.attacks[a.id] = on;
    this.rescheduleAttacks();
    this.emitState();
  }

  setIntensity(value: number) {
    this.config.intensity = Math.min(8, Math.max(1, value || 1));
    this.rescheduleAttacks();
    this.emitState();
  }

  /** Fire one instance of an attack right now, regardless of its timer. */
  burst(attack: AttackId) {
    this.runAttack(attack);
  }

  // ------------------------------------------------------------------ scheduling

  private rescheduleAttacks() {
    this.stopAllTimers();
    if (!this.armed || this.connState.state !== 'connected') return;

    for (const meta of ATTACKS) {
      if (!this.attacks[meta.id]) continue;
      if (meta.id === 'ignoreCommands') continue; // passive: handled in onMessage
      if (meta.id === 'reconnectStorm') {
        // Slam the socket shut on a cadence; `close` restarts it fast.
        const period = Math.max(400, meta.everyMs / this.config.intensity);
        this.stormTimer = setInterval(() => this.ws?.close(4000, 'rogue reconnect storm'), period);
        continue;
      }
      const period = Math.max(40, meta.everyMs / this.config.intensity);
      this.timers.set(
        meta.id,
        setInterval(() => this.runAttack(meta.id), period),
      );
    }
  }

  private stopAllTimers() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    if (this.stormTimer) clearInterval(this.stormTimer);
    this.stormTimer = null;
  }

  // ------------------------------------------------------------------ attacks

  private runAttack(id: AttackId) {
    if (this.connState.state !== 'connected' || !this.ws) return;
    switch (id) {
      case 'malformed':
        return this.attackMalformed();
      case 'bogusMeter':
        return this.attackBogusMeter();
      case 'flood':
        return this.attackFlood();
      case 'replay':
        return this.attackReplay();
      case 'oversized':
        return this.attackOversized();
      case 'wrongType':
        return this.attackWrongType();
      case 'invalidTx':
        return this.attackInvalidTx();
      default:
        return;
    }
  }

  private note(id: AttackId) {
    this.stats.attacksFired[id]++;
    this.stats.lastAttack = { id, at: Date.now() };
  }

  private attackMalformed() {
    this.note('malformed');
    const variants = [
      () => '}{ not json at all 🙂',
      () => '[2,"only-three-elements"]',
      () => JSON.stringify([2, this.id(), 'Heartbeat']), // CALL missing payload
      () => JSON.stringify([2, this.id(), 'BootNotification', { chargePointVendor: 123 }]), // wrong type
      () => JSON.stringify([2, this.id(), 'StatusNotification', { connectorId: 'not-a-number', status: 'Teapot' }]),
      () => JSON.stringify([2, 42, 'Heartbeat', {}]), // messageId not a string
      () => JSON.stringify({ hello: 'this is an object, not an array' }),
    ];
    this.sendRaw(pick(variants)(), { kind: 'CALL', action: 'Malformed' });
  }

  private attackBogusMeter() {
    this.note('bogusMeter');
    const impossible = pick([-999999, 9.99e14, Number.MAX_SAFE_INTEGER, -1, 1e9]);
    if (this.config.version === 'ocpp1.6') {
      this.sendCall('MeterValues', {
        connectorId: 1,
        transactionId: this.phantomTxId,
        meterValue: [
          {
            timestamp: now(),
            sampledValue: [{ value: String(impossible), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
          },
        ],
      });
    } else {
      this.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: now(),
        triggerReason: 'MeterValuePeriodic',
        seqNo: rand(5),
        transactionInfo: { transactionId: String(this.phantomTxId) },
        meterValue: [{ timestamp: now(), sampledValue: [{ value: impossible, measurand: 'Energy.Active.Import.Register' }] }],
      });
    }
  }

  private attackFlood() {
    this.note('flood');
    // A short burst each tick so the overall rate is high.
    for (let i = 0; i < 5; i++) {
      if (Math.random() < 0.5) this.sendCall('Heartbeat', {});
      else this.sendCall('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: now() });
    }
  }

  private attackReplay() {
    this.note('replay');
    if (Math.random() < 0.5 && this.usedIds.length) {
      // Re-use an old messageId on a brand new CALL.
      const id = pick(this.usedIds);
      this.sendRaw(JSON.stringify([2, id, 'Heartbeat', {}]), { kind: 'CALL', action: 'Heartbeat', messageId: id });
    } else {
      // A CALLRESULT answering a request the CSMS never sent.
      const id = this.id();
      this.sendRaw(JSON.stringify([3, id, { currentTime: now() }]), { kind: 'CALLRESULT', action: 'Unsolicited', messageId: id });
    }
  }

  private attackOversized() {
    this.note('oversized');
    const blob = 'A'.repeat(300_000);
    this.sendCall('BootNotification', buildBoot(this.config.version, { model: blob }));
  }

  private attackWrongType() {
    this.note('wrongType');
    const id = this.id();
    const variants = [
      () => JSON.stringify([9, id, 'Heartbeat', {}]), // unknown message type
      () => JSON.stringify([0, id, {}]), // type 0
      () => JSON.stringify([4, id, 'SomeError', 'a CALLERROR nobody asked for', {}]),
      () => JSON.stringify(['2', id, 'Heartbeat', {}]), // type as string
    ];
    this.sendRaw(pick(variants)(), { kind: 'CALLERROR', action: 'WrongType', messageId: id });
  }

  private attackInvalidTx() {
    this.note('invalidTx');
    const bogusTx = pick([-1, 0, 999999999, this.phantomTxId + rand(1000)]);
    if (this.config.version === 'ocpp1.6') {
      this.sendCall('StopTransaction', {
        transactionId: bogusTx,
        meterStop: rand(100000),
        timestamp: now(),
        reason: 'Local',
      });
    } else {
      this.sendCall('TransactionEvent', {
        eventType: 'Ended',
        timestamp: now(),
        triggerReason: 'StopAuthorized',
        seqNo: rand(5),
        transactionInfo: { transactionId: `phantom-${bogusTx}` },
      });
    }
  }

  // ------------------------------------------------------------------ incoming

  private onMessage(raw: string) {
    const frame = safeParse(raw);
    const isCommand = Array.isArray(frame) && frame[0] === 2 && typeof frame[1] === 'string';
    const isError = Array.isArray(frame) && frame[0] === 4;
    this.pushLog({
      dir: 'in',
      kind: guessKind(raw),
      messageId: Array.isArray(frame) && typeof frame[1] === 'string' ? frame[1] : '?',
      // Surface the CSMS's rejection reason so it shows up in the inspector.
      action: isCommand ? `CSMS: ${frame[2]}` : isError ? 'CSMS rejected' : 'CSMS→rogue',
      payload: frame,
      raw,
      errorCode: isError ? String(frame[2] ?? '') : undefined,
      errorDescription: isError ? String(frame[3] ?? '') : undefined,
    });
    // We never match CSMS responses back to our requests — "ignoring CSMS
    // responses" is itself one of the misbehaviours — so CALLRESULT/CALLERROR
    // frames are simply dropped here.
    if (!isCommand) return;
    // The CSMS has sent us a CALL (Reset, RemoteStart, TriggerMessage, …).
    if (this.armed && this.attacks.ignoreCommands) {
      // Leave it hanging: no answer at all.
      this.stats.commandsIgnored++;
      this.emitState();
      return;
    }
    // Otherwise reply with a bare empty CALLRESULT so the node looks half-alive
    // without actually doing what was asked.
    this.sendRaw(JSON.stringify([3, frame[1], {}]), { kind: 'CALLRESULT', action: String(frame[2] ?? '?'), messageId: frame[1] });
  }

  // ------------------------------------------------------------------ sending

  private id() {
    const id = `${Date.now().toString(36)}-${(globalSeq++).toString(36)}`;
    this.usedIds.push(id);
    if (this.usedIds.length > 50) this.usedIds.shift();
    return id;
  }

  private sendBoot() {
    this.sendCall('BootNotification', buildBoot(this.config.version, {}));
    if (this.config.version === 'ocpp1.6') {
      this.sendCall('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Available', timestamp: now() });
    }
  }

  private sendCall(action: string, payload: Record<string, unknown>) {
    const id = this.id();
    this.sendRaw(JSON.stringify([2, id, action, payload]), { kind: 'CALL', action, messageId: id, payload });
  }

  private sendRaw(raw: string, meta: { kind: FrameKind; action: string; messageId?: string; payload?: unknown }) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(raw);
    } catch {
      return;
    }
    this.stats.framesSent++;
    this.pushLog({ dir: 'out', kind: meta.kind, messageId: meta.messageId ?? '?', action: meta.action, payload: meta.payload ?? safeParse(raw), raw });
  }

  // ------------------------------------------------------------------ state / logs

  state(): RogueState {
    return {
      config: this.config,
      connection: this.connState,
      armed: this.armed,
      attacks: this.attacks,
      stats: this.stats,
    };
  }

  private emitState() {
    this.emit('state', this.state());
  }

  private toast(level: 'info' | 'error' | 'success', text: string) {
    this.emit('toast', { level, text });
  }

  private pushLog(e: {
    dir: 'in' | 'out';
    kind: FrameKind;
    messageId: string;
    action: string;
    payload: unknown;
    raw: string;
    errorCode?: string;
    errorDescription?: string;
  }) {
    const entry: LogEntry = {
      ...e,
      // Keep the biggest raw frames from bloating the GUI/log buffer.
      raw: e.raw.length > 2000 ? e.raw.slice(0, 2000) + `…(+${e.raw.length - 2000} bytes)` : e.raw,
      seq: ++globalSeq,
      ts: Date.now(),
      version: this.config.version,
      peer: this.config.chargePointId,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.emit('log', entry);
  }
}

// ---------------------------------------------------------------------- helpers

function buildBoot(version: OcppVersion, over: { model?: string }): Record<string, unknown> {
  if (version === 'ocpp1.6') {
    return {
      chargePointVendor: IDENTITY.vendor,
      chargePointModel: over.model ?? IDENTITY.model,
      chargePointSerialNumber: IDENTITY.serial,
      firmwareVersion: IDENTITY.firmware,
    };
  }
  return {
    reason: 'PowerUp',
    chargingStation: {
      vendorName: IDENTITY.vendor,
      model: over.model ?? IDENTITY.model,
      serialNumber: IDENTITY.serial,
      firmwareVersion: IDENTITY.firmware,
    },
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function guessKind(raw: string): FrameKind {
  const f = safeParse(raw);
  if (Array.isArray(f)) {
    if (f[0] === 2) return 'CALL';
    if (f[0] === 3) return 'CALLRESULT';
    if (f[0] === 4) return 'CALLERROR';
  }
  return 'CALL';
}

export { ATTACKS, versionLabel };
