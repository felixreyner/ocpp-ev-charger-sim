import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { OcppError, RpcEndpoint, versionLabel, type LogEntry, type V16, type V201 } from '@sim/ocpp';
import type { CarPreset, ChargerConfig, ChargerState, ConnectorStatus, ConnectorView } from './types.ts';

export const CAR_PRESETS: CarPreset[] = [
  { name: 'Tesla Model 3', capacityKWh: 75, maxAcKW: 11, maxDcKW: 250, color: '#ff3b6b' },
  { name: 'VW ID.4', capacityKWh: 77, maxAcKW: 11, maxDcKW: 135, color: '#38bdf8' },
  { name: 'Hyundai Ioniq 5', capacityKWh: 77.4, maxAcKW: 11, maxDcKW: 235, color: '#a3e635' },
  { name: 'Nissan Leaf', capacityKWh: 40, maxAcKW: 6.6, maxDcKW: 50, color: '#fbbf24' },
  { name: 'Porsche Taycan', capacityKWh: 93.4, maxAcKW: 22, maxDcKW: 270, color: '#c084fc' },
];

export const RFID_CARDS = ['ALICE-0001', 'BOB-0002', 'CAROL-0003', 'BLOCKED-6666', 'UNKNOWN-9999'];

const PENDING_AUTH_TIMEOUT_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;

type StopReason = 'Local' | 'Remote' | 'EVDisconnected' | 'HardReset' | 'SoftReset' | 'UnlockCommand' | 'DeAuthorized' | 'Other';

interface Tx {
  /** 1.6: integer assigned by the CSMS (as a string, null until answered). 2.0.1: UUID we generate. */
  id: string | null;
  idTag: string;
  startedAt: number;
  meterStartWh: number;
  remote: boolean;
  remoteStartId?: number;
  seqNo: number;
  chargingState: string;
  /** Set once the start message is queued, so nothing about this tx is sent before it. */
  announced: boolean;
  stopping: boolean;
}

interface Connector {
  id: number;
  label: string;
  type: 'DC' | 'AC';
  maxPowerW: number;
  car: (CarPreset & { soc: number }) | null;
  powerW: number;
  targetW: number;
  meterWh: number;
  limitW: number | null;
  operative: boolean;
  scheduledInoperative: boolean;
  faulted: boolean;
  pending: { idTag: string; expires: number; remote: boolean; remoteStartId?: number } | null;
  tx: Tx | null;
  finishing: boolean;
  lastSentStatus: string | null;
  display: string;
}

const makeConnector = (id: number, label: string, type: 'DC' | 'AC', maxPowerW: number): Connector => ({
  id,
  label,
  type,
  maxPowerW,
  car: null,
  powerW: 0,
  targetW: 0,
  meterWh: Math.round(1_000_000 + Math.random() * 400_000),
  limitW: null,
  operative: true,
  scheduledInoperative: false,
  faulted: false,
  pending: null,
  tx: null,
  finishing: false,
  lastSentStatus: null,
  display: 'Plug in to start',
});

/** How hard a car accepts power at a given state of charge (0..1 of its max). */
function chargeCurve(type: 'DC' | 'AC', soc: number) {
  if (soc >= 100) return 0;
  if (type === 'AC') return soc < 92 ? 1 : 1 - ((soc - 92) / 8) * 0.8;
  if (soc <= 50) return 1;
  if (soc <= 80) return 1 - ((soc - 50) / 30) * 0.45;
  return 0.55 - ((soc - 80) / 20) * 0.48;
}

const now = () => new Date().toISOString();
const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

export class Station extends EventEmitter {
  config: ChargerConfig;
  connectors: Connector[] = [makeConnector(1, 'CCS2 · DC 150 kW', 'DC', 150_000), makeConnector(2, 'Type 2 · AC 22 kW', 'AC', 22_000)];
  simSpeed = 1;
  meterIntervalS = 5;
  logs: LogEntry[] = [];

  private ws: WebSocket | null = null;
  private rpc: RpcEndpoint | null = null;
  private wantConnected = true;
  private connState: ChargerState['connection'] = {
    state: 'disconnected',
    bootStatus: 'None',
    heartbeatIntervalS: 0,
    lastHeartbeat: null,
    connectedAt: null,
    error: null,
  };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private bootRetryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private meterTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout;
  private nextBootReason: V201['BootNotification']['reason'] = 'PowerUp';
  private scheduledReset = false;

  constructor(config: ChargerConfig) {
    super();
    this.config = config;
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.restartMeterTimer();
  }

  private get v16() {
    return this.config.version === 'ocpp1.6';
  }

  private get online() {
    return this.connState.state === 'connected' && this.connState.bootStatus === 'Accepted';
  }

  // ------------------------------------------------------------------ connection

  connect() {
    this.wantConnected = true;
    this.openSocket();
  }

  disconnect() {
    this.wantConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'Disconnected from GUI');
  }

  async reconfigure(patch: Partial<ChargerConfig>) {
    const reconnect = ['csmsUrl', 'chargePointId', 'version', 'vendor', 'model'].some(
      (k) => k in patch && (patch as any)[k] !== (this.config as any)[k],
    );
    // Switching protocol mid-session would orphan transactions on the CSMS, so end them cleanly first.
    if (reconnect) await this.stopAll('Other');
    this.config = { ...this.config, ...patch };
    if (reconnect) {
      // a different CSMS (or protocol) knows nothing about the old charging profiles
      this.connectors.forEach((c) => (c.limitW = null));
      this.ws?.close(1000, 'Reconfigured');
      this.wantConnected = true;
      if (!this.ws) this.openSocket();
    }
    this.emitState();
  }

  private openSocket() {
    if (this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const url = `${this.config.csmsUrl.replace(/\/+$/, '')}/${encodeURIComponent(this.config.chargePointId)}`;
    this.connState = { ...this.connState, state: 'connecting', error: null };
    this.emitState();

    // The OCPP version is negotiated with the WebSocket subprotocol header.
    const ws = new WebSocket(url, [this.config.version]);
    this.ws = ws;

    ws.on('open', () => {
      if (ws.protocol !== this.config.version) {
        this.toast('error', `CSMS did not accept ${this.config.version} (got "${ws.protocol || 'none'}")`);
        ws.close(1002, 'Subprotocol mismatch');
        return;
      }
      this.rpc = new RpcEndpoint({
        version: this.config.version,
        send: (raw) => ws.send(raw),
        onLog: (e) => this.pushLog(e),
      });
      this.registerHandlers(this.rpc);
      this.connState = { ...this.connState, state: 'connected', connectedAt: Date.now(), bootStatus: 'None' };
      this.emitState();
      this.boot();
    });
    ws.on('message', (data) => this.rpc?.receive(data.toString()));
    ws.on('error', (err) => {
      this.connState = { ...this.connState, error: err.message };
    });
    ws.on('close', () => {
      this.rpc?.close();
      this.rpc = null;
      this.ws = null;
      this.clearSessionTimers();
      this.connectors.forEach((c) => (c.lastSentStatus = null));
      this.connState = { ...this.connState, state: 'disconnected', bootStatus: 'None', connectedAt: null };
      this.emitState();
      if (this.wantConnected) this.reconnectTimer = setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS);
    });
  }

  private clearSessionTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.bootRetryTimer) clearTimeout(this.bootRetryTimer);
    this.heartbeatTimer = this.bootRetryTimer = null;
  }

  private async boot() {
    const rpc = this.rpc;
    if (!rpc) return;
    try {
      const res: { status: 'Accepted' | 'Pending' | 'Rejected'; interval: number } = this.v16
        ? await rpc.call('BootNotification', {
            chargePointVendor: this.config.vendor,
            chargePointModel: this.config.model,
            chargePointSerialNumber: this.config.serial,
            firmwareVersion: this.config.firmware,
          })
        : await rpc.call('BootNotification', {
            reason: this.nextBootReason,
            chargingStation: {
              vendorName: this.config.vendor,
              model: this.config.model,
              serialNumber: this.config.serial,
              firmwareVersion: this.config.firmware,
            },
          });
      this.nextBootReason = 'PowerUp';
      this.connState = { ...this.connState, bootStatus: res.status, heartbeatIntervalS: res.interval };
      if (res.status === 'Accepted') {
        this.startHeartbeat(res.interval);
        if (this.v16) {
          // connectorId 0 = the charge point as a whole
          await rpc.call('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Available', timestamp: now() });
        }
        this.connectors.forEach((c) => (c.lastSentStatus = null));
        this.refresh();
        this.toast('success', `Booted on ${versionLabel(this.config.version)}`);
      } else {
        // Pending / Rejected: try again after the interval the CSMS told us.
        this.bootRetryTimer = setTimeout(() => this.boot(), Math.max(res.interval, 5) * 1000);
      }
      this.emitState();
    } catch (e) {
      this.toast('error', `BootNotification failed: ${(e as Error).message}`);
      this.bootRetryTimer = setTimeout(() => this.boot(), 10_000);
    }
  }

  private startHeartbeat(intervalS: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), Math.max(intervalS, 1) * 1000);
  }

  private async heartbeat() {
    try {
      await this.rpc?.call('Heartbeat', {});
      this.connState = { ...this.connState, lastHeartbeat: Date.now() };
      this.emitState();
    } catch {
      /* logged by the RPC layer */
    }
  }

  restartMeterTimer() {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      for (const c of this.connectors) if (c.tx?.id && c.tx.announced && !c.tx.stopping) this.sendMeter(c, 'Periodic').catch(() => {});
    }, this.meterIntervalS * 1000);
  }

  // ------------------------------------------------------------------ simulation

  /** Advance the physics by dtS simulated seconds (0 = just recompute). */
  private tick(dtS = this.simSpeed) {
    for (const c of this.connectors) {
      const car = c.car;
      let target = 0;
      if (c.tx && car && !c.faulted) {
        const carMax = (c.type === 'DC' ? car.maxDcKW : car.maxAcKW) * 1000;
        target = Math.min(c.maxPowerW, carMax * chargeCurve(c.type, car.soc), c.limitW ?? Infinity);
      }
      c.targetW = target;
      c.powerW = target > 0 ? target * (0.985 + Math.random() * 0.02) : 0;
      if (c.powerW > 0 && car) {
        const wh = (c.powerW * dtS) / 3600;
        c.meterWh += wh;
        car.soc = Math.min(100, car.soc + (wh / (car.capacityKWh * 1000)) * 100);
      }
      if (c.pending && Date.now() > c.pending.expires) {
        c.pending = null;
        c.display = 'Timed out. Tap again';
      }
      if (c.tx) {
        const kw = c.powerW / 1000;
        c.display = kw > 0 ? `Charging ${kw.toFixed(1)} kW` : car && car.soc >= 100 ? 'Battery full' : c.limitW === 0 ? 'Paused by operator' : 'Waiting for car';
      }
    }
    if (this.scheduledReset && this.connectors.every((c) => !c.tx)) {
      this.scheduledReset = false;
      this.reboot('OnIdle');
    }
    this.refresh();
  }

  private statusOf(c: Connector): ConnectorStatus {
    if (c.faulted) return 'Faulted';
    if (c.tx) {
      if (c.targetW > 0) return 'Charging';
      return c.limitW === 0 ? 'SuspendedEVSE' : 'SuspendedEV';
    }
    if (!c.operative) return 'Unavailable';
    if (c.car) return c.finishing ? 'Finishing' : 'Preparing';
    return 'Available';
  }

  private chargingStateOf(c: Connector) {
    if (!c.car) return 'Idle';
    const s = this.statusOf(c);
    return s === 'Charging' ? 'Charging' : s === 'SuspendedEV' ? 'SuspendedEV' : s === 'SuspendedEVSE' ? 'SuspendedEVSE' : 'EVConnected';
  }

  /** Detect state changes and tell the CSMS about them. */
  private refresh() {
    if (this.online) {
      for (const c of this.connectors) {
        if (c.tx && !c.tx.announced) continue;
        const status = this.statusOf(c);
        const wire = this.v16 ? status : this.toV201Status(c, status);
        if (wire !== c.lastSentStatus) {
          c.lastSentStatus = wire;
          this.sendStatus(c, status).catch(() => (c.lastSentStatus = null));
        }
        if (!this.v16 && c.tx && !c.tx.stopping) {
          const cs = this.chargingStateOf(c);
          if (cs !== c.tx.chargingState) {
            c.tx.chargingState = cs;
            this.txEvent(c, 'Updated', 'ChargingStateChanged').catch(() => {});
          }
        }
      }
    }
    this.emitState();
  }

  private toV201Status(c: Connector, s: ConnectorStatus) {
    if (s === 'Faulted' || s === 'Unavailable' || s === 'Available') return s;
    return c.car ? 'Occupied' : 'Available';
  }

  // ------------------------------------------------------------------ OCPP messages we send

  private requireRpc() {
    if (!this.rpc || !this.online) throw new Error('Charger is offline');
    return this.rpc;
  }

  private sendStatus(c: Connector, status: ConnectorStatus) {
    const rpc = this.requireRpc();
    if (this.v16) {
      return rpc.call('StatusNotification', {
        connectorId: c.id,
        errorCode: c.faulted ? 'OtherError' : 'NoError',
        status,
        timestamp: now(),
      } satisfies V16['StatusNotification']);
    }
    return rpc.call('StatusNotification', {
      timestamp: now(),
      connectorStatus: this.toV201Status(c, status) as V201['StatusNotification']['connectorStatus'],
      evseId: c.id,
      connectorId: 1,
    } satisfies V201['StatusNotification']);
  }

  private async authorize(idTag: string): Promise<string> {
    const rpc = this.requireRpc();
    if (this.v16) {
      const res = await rpc.call('Authorize', { idTag });
      return res.idTagInfo?.status ?? 'Invalid';
    }
    const res = await rpc.call('Authorize', { idToken: { idToken: idTag, type: 'ISO14443' } });
    return res.idTokenInfo?.status ?? 'Invalid';
  }

  private sampled(c: Connector) {
    const values = [
      { measurand: 'Energy.Active.Import.Register', unit: 'Wh', value: Math.round(c.meterWh) },
      { measurand: 'Power.Active.Import', unit: 'W', value: Math.round(c.powerW) },
    ];
    if (c.car) values.push({ measurand: 'SoC', unit: 'Percent', value: round(c.car.soc, 1) });
    return values;
  }

  private meterValueV201(c: Connector, context = 'Sample.Periodic') {
    return [
      {
        timestamp: now(),
        sampledValue: this.sampled(c).map((s) => ({ value: s.value, measurand: s.measurand, context, unitOfMeasure: { unit: s.unit } })),
      },
    ];
  }

  private async sendMeter(c: Connector, why: 'Periodic' | 'Trigger') {
    const rpc = this.requireRpc();
    if (this.v16) {
      return rpc.call('MeterValues', {
        connectorId: c.id,
        ...(c.tx?.id ? { transactionId: Number(c.tx.id) } : {}),
        meterValue: [
          {
            timestamp: now(),
            sampledValue: this.sampled(c).map((s) => ({
              value: String(s.value),
              measurand: s.measurand,
              unit: s.unit,
              context: why === 'Periodic' ? 'Sample.Periodic' : 'Trigger',
            })),
          },
        ],
      });
    }
    if (c.tx?.id) return this.txEvent(c, 'Updated', why === 'Periodic' ? 'MeterValuePeriodic' : 'Trigger');
    return rpc.call('MeterValues', { evseId: c.id, meterValue: this.meterValueV201(c, 'Trigger') });
  }

  /** 2.0.1 only: the one message that covers a whole transaction lifecycle. */
  private txEvent(c: Connector, eventType: 'Started' | 'Updated' | 'Ended', triggerReason: string, stoppedReason?: string) {
    const rpc = this.requireRpc();
    const tx = c.tx!;
    const payload: V201['TransactionEvent'] = {
      eventType,
      timestamp: now(),
      triggerReason,
      seqNo: tx.seqNo++,
      transactionInfo: {
        transactionId: tx.id!,
        chargingState: (eventType === 'Ended' ? (c.car ? 'EVConnected' : 'Idle') : this.chargingStateOf(c)) as any,
        ...(stoppedReason ? { stoppedReason } : {}),
        ...(eventType === 'Started' && tx.remoteStartId !== undefined ? { remoteStartId: tx.remoteStartId } : {}),
      },
      ...(eventType !== 'Updated' || triggerReason === 'Trigger' ? { idToken: { idToken: tx.idTag, type: 'ISO14443' } } : {}),
      ...(eventType === 'Started' ? { evse: { id: c.id, connectorId: 1 } } : {}),
      meterValue: this.meterValueV201(c, eventType === 'Started' ? 'Transaction.Begin' : eventType === 'Ended' ? 'Transaction.End' : 'Sample.Periodic'),
    };
    return rpc.call('TransactionEvent', payload);
  }

  private async startTx(c: Connector, idTag: string, opts: { remote: boolean; remoteStartId?: number }) {
    const tx: Tx = {
      id: this.v16 ? null : randomUUID(),
      idTag,
      startedAt: Date.now(),
      meterStartWh: c.meterWh,
      remote: opts.remote,
      remoteStartId: opts.remoteStartId,
      seqNo: 0,
      chargingState: 'Charging',
      announced: false,
      stopping: false,
    };
    c.tx = tx;
    c.pending = null;
    c.finishing = false;
    c.display = 'Starting…';
    this.tick(0);
    try {
      const rpc = this.requireRpc();
      tx.announced = true;
      if (this.v16) {
        const res = await rpc.call('StartTransaction', {
          connectorId: c.id,
          idTag,
          meterStart: Math.round(tx.meterStartWh),
          timestamp: new Date(tx.startedAt).toISOString(),
        } satisfies V16['StartTransaction']);
        tx.id = String(res.transactionId);
        if (res.idTagInfo?.status !== 'Accepted') {
          this.toast('error', `CSMS rejected the transaction (${res.idTagInfo?.status})`);
          return this.stopTx(c, 'DeAuthorized');
        }
      } else {
        tx.chargingState = this.chargingStateOf(c);
        const res = await this.txEvent(c, 'Started', opts.remote ? 'RemoteStart' : 'Authorized');
        const status = res?.idTokenInfo?.status;
        if (status && status !== 'Accepted') {
          this.toast('error', `CSMS rejected the transaction (${status})`);
          return this.stopTx(c, 'DeAuthorized');
        }
      }
      this.toast('success', `Transaction ${tx.id} started on connector ${c.id}`);
    } catch (e) {
      this.toast('error', `Could not start transaction: ${(e as Error).message}`);
      if (c.tx === tx && !tx.id) c.tx = null;
    }
    this.refresh();
  }

  private async stopTx(c: Connector, reason: StopReason) {
    const tx = c.tx;
    if (!tx || tx.stopping) return;
    tx.stopping = true;
    const energyKWh = (c.meterWh - tx.meterStartWh) / 1000;
    c.powerW = 0;
    try {
      if (this.v16) {
        if (tx.id) {
          await this.requireRpc().call('StopTransaction', {
            transactionId: Number(tx.id),
            idTag: tx.idTag,
            meterStop: Math.round(c.meterWh),
            timestamp: now(),
            reason,
          } satisfies V16['StopTransaction']);
        }
      } else {
        const trigger: Record<StopReason, string> = {
          Local: 'StopAuthorized',
          Remote: 'RemoteStop',
          EVDisconnected: 'EVCommunicationLost',
          HardReset: 'ResetCommand',
          SoftReset: 'ResetCommand',
          UnlockCommand: 'UnlockCommand',
          DeAuthorized: 'Deauthorized',
          Other: 'AbnormalCondition',
        };
        const stopped: Record<StopReason, string> = {
          Local: 'Local',
          Remote: 'Remote',
          EVDisconnected: 'EVDisconnected',
          HardReset: 'ImmediateReset',
          SoftReset: 'ImmediateReset',
          UnlockCommand: 'Other',
          DeAuthorized: 'DeAuthorized',
          Other: 'Other',
        };
        await this.txEvent(c, 'Ended', trigger[reason], stopped[reason]);
      }
    } catch (e) {
      this.toast('error', `Stop message failed: ${(e as Error).message}`);
    }
    c.tx = null;
    c.finishing = !!c.car;
    c.display = reason === 'DeAuthorized' ? 'Not authorized' : `Thank you! ${energyKWh.toFixed(2)} kWh`;
    if (c.scheduledInoperative) {
      c.scheduledInoperative = false;
      c.operative = false;
    }
    this.refresh();
  }

  private async stopAll(reason: StopReason) {
    await Promise.all(this.connectors.filter((c) => c.tx).map((c) => this.stopTx(c, reason)));
  }

  private reboot(kind: string) {
    this.toast('info', `Rebooting (${kind})…`);
    this.nextBootReason = 'RemoteReset';
    this.connectors.forEach((c) => {
      c.pending = null;
      c.limitW = null;
      if (!c.tx) c.display = 'Rebooting…';
    });
    this.ws?.close(1012, 'Reset');
  }

  // ------------------------------------------------------------------ messages the CSMS sends us

  private findConnector(id: number | undefined) {
    return this.connectors.find((c) => c.id === id);
  }

  private pickConnectorForRemoteStart(id?: number) {
    if (id) return this.findConnector(id);
    return this.connectors.find((c) => c.car && !c.tx) ?? this.connectors.find((c) => !c.tx && c.operative && !c.faulted);
  }

  private remoteStart(idTag: string, connectorId: number | undefined, limitW: number | null, remoteStartId?: number) {
    const c = this.pickConnectorForRemoteStart(connectorId);
    if (!c || c.tx || !c.operative || c.faulted) return false;
    if (limitW !== null) c.limitW = limitW;
    // Reply first, then act: the transaction messages must come after our CALLRESULT.
    setTimeout(() => {
      if (c.car) this.startTx(c, idTag, { remote: true, remoteStartId });
      else {
        c.pending = { idTag, expires: Date.now() + PENDING_AUTH_TIMEOUT_MS, remote: true, remoteStartId };
        c.display = 'Remote start: plug in your car';
        this.emitState();
      }
    }, 20);
    return true;
  }

  private remoteStop(txId: string) {
    const c = this.connectors.find((x) => x.tx?.id === txId);
    if (!c) return false;
    setTimeout(() => this.stopTx(c, 'Remote'), 20);
    return true;
  }

  private changeAvailability(target: Connector[], operative: boolean) {
    let scheduled = false;
    for (const c of target) {
      if (!operative && c.tx) {
        c.scheduledInoperative = true;
        scheduled = true;
      } else {
        c.operative = operative;
        c.scheduledInoperative = false;
        c.display = operative ? 'Plug in to start' : 'Out of service';
      }
    }
    setTimeout(() => this.refresh(), 20);
    return scheduled ? 'Scheduled' : 'Accepted';
  }

  private profileLimitW(c: Connector, unit: 'W' | 'A', limit: number) {
    // Simplified: A -> W at 230 V three-phase for AC, 400 V for DC.
    return unit === 'W' ? limit : c.type === 'AC' ? limit * 230 * 3 : limit * 400;
  }

  private applyLimit(connectorId: number, unit: 'W' | 'A', limit: number) {
    const targets = connectorId === 0 ? this.connectors : this.connectors.filter((c) => c.id === connectorId);
    if (!targets.length) return false;
    targets.forEach((c) => (c.limitW = this.profileLimitW(c, unit, limit)));
    this.toast('info', `Charging limit set: ${limit} ${unit}${connectorId ? ` on connector ${connectorId}` : ''}`);
    setTimeout(() => this.tick(0), 20);
    return true;
  }

  private clearLimit(connectorId?: number) {
    const targets = !connectorId ? this.connectors : this.connectors.filter((c) => c.id === connectorId);
    const had = targets.some((c) => c.limitW !== null);
    targets.forEach((c) => (c.limitW = null));
    setTimeout(() => this.tick(0), 20);
    return had;
  }

  private trigger(message: string, connectorId?: number) {
    const targets = connectorId ? this.connectors.filter((c) => c.id === connectorId) : this.connectors;
    const run = () => {
      switch (message) {
        case 'BootNotification':
          return this.boot();
        case 'Heartbeat':
          return this.heartbeat();
        case 'StatusNotification':
          return targets.forEach((c) => this.sendStatus(c, this.statusOf(c)).catch(() => {}));
        case 'MeterValues':
          return targets.forEach((c) => this.sendMeter(c, 'Trigger').catch(() => {}));
        case 'TransactionEvent':
          return targets.filter((c) => c.tx).forEach((c) => this.txEvent(c, 'Updated', 'Trigger').catch(() => {}));
      }
    };
    const supported = ['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues', 'TransactionEvent'];
    if (!supported.includes(message)) return 'NotImplemented';
    setTimeout(run, 20);
    return 'Accepted';
  }

  private registerHandlers(rpc: RpcEndpoint) {
    if (this.v16) {
      rpc
        .handle('RemoteStartTransaction', (p: V16['RemoteStartTransaction']) => {
          const period = p.chargingProfile?.chargingSchedule.chargingSchedulePeriod[0];
          const c = this.pickConnectorForRemoteStart(p.connectorId);
          const limit = period && c ? this.profileLimitW(c, p.chargingProfile!.chargingSchedule.chargingRateUnit, period.limit) : null;
          return { status: this.remoteStart(p.idTag, p.connectorId, limit) ? 'Accepted' : 'Rejected' };
        })
        .handle('RemoteStopTransaction', (p: V16['RemoteStopTransaction']) => ({
          status: this.remoteStop(String(p.transactionId)) ? 'Accepted' : 'Rejected',
        }))
        .handle('Reset', (p: V16['Reset']) => {
          setTimeout(async () => {
            await this.stopAll(p.type === 'Hard' ? 'HardReset' : 'SoftReset');
            this.reboot(p.type);
          }, 50);
          return { status: 'Accepted' };
        })
        .handle('UnlockConnector', (p: V16['UnlockConnector']) => {
          const c = this.findConnector(p.connectorId);
          if (!c) return { status: 'NotSupported' };
          setTimeout(async () => {
            if (c.tx) await this.stopTx(c, 'UnlockCommand');
            this.unplugCable(c);
          }, 20);
          return { status: 'Unlocked' };
        })
        .handle('ChangeAvailability', (p: V16['ChangeAvailability']) => {
          const targets = p.connectorId === 0 ? this.connectors : this.connectors.filter((c) => c.id === p.connectorId);
          if (!targets.length) return { status: 'Rejected' };
          return { status: this.changeAvailability(targets, p.type === 'Operative') };
        })
        .handle('SetChargingProfile', (p: V16['SetChargingProfile']) => {
          const s = p.csChargingProfiles.chargingSchedule;
          return { status: this.applyLimit(p.connectorId, s.chargingRateUnit, s.chargingSchedulePeriod[0].limit) ? 'Accepted' : 'Rejected' };
        })
        .handle('ClearChargingProfile', (p: V16['ClearChargingProfile']) => ({ status: this.clearLimit(p.connectorId) ? 'Accepted' : 'Unknown' }))
        .handle('TriggerMessage', (p: V16['TriggerMessage']) => {
          const status = this.trigger(p.requestedMessage, p.connectorId);
          if (status === 'NotImplemented') return { status: 'NotImplemented' };
          return { status };
        });
    } else {
      rpc
        .handle('RequestStartTransaction', (p: V201['RequestStartTransaction']) => {
          const period = p.chargingProfile?.chargingSchedule[0]?.chargingSchedulePeriod[0];
          const c = this.pickConnectorForRemoteStart(p.evseId);
          const limit = period && c ? this.profileLimitW(c, p.chargingProfile!.chargingSchedule[0].chargingRateUnit, period.limit) : null;
          return { status: this.remoteStart(p.idToken.idToken, p.evseId, limit, p.remoteStartId) ? 'Accepted' : 'Rejected' };
        })
        .handle('RequestStopTransaction', (p: V201['RequestStopTransaction']) => ({
          status: this.remoteStop(p.transactionId) ? 'Accepted' : 'Rejected',
        }))
        .handle('Reset', (p: V201['Reset']) => {
          const busy = this.connectors.some((c) => c.tx);
          if (p.type === 'OnIdle' && busy) {
            this.scheduledReset = true;
            return { status: 'Scheduled' };
          }
          setTimeout(async () => {
            await this.stopAll('HardReset');
            this.reboot(p.type);
          }, 50);
          return { status: 'Accepted' };
        })
        .handle('UnlockConnector', (p: V201['UnlockConnector']) => {
          const c = this.findConnector(p.evseId);
          if (!c) return { status: 'UnknownConnector' };
          // 2.0.1 refuses to unlock under a running authorized transaction: stop it first.
          if (c.tx) return { status: 'OngoingAuthorizedTransaction' };
          setTimeout(() => this.unplugCable(c), 20);
          return { status: 'Unlocked' };
        })
        .handle('ChangeAvailability', (p: V201['ChangeAvailability']) => {
          const targets = !p.evse || p.evse.id === 0 ? this.connectors : this.connectors.filter((c) => c.id === p.evse!.id);
          if (!targets.length) return { status: 'Rejected' };
          return { status: this.changeAvailability(targets, p.operationalStatus === 'Operative') };
        })
        .handle('SetChargingProfile', (p: V201['SetChargingProfile']) => {
          const s = p.chargingProfile.chargingSchedule[0];
          return { status: this.applyLimit(p.evseId, s.chargingRateUnit, s.chargingSchedulePeriod[0].limit) ? 'Accepted' : 'Rejected' };
        })
        .handle('ClearChargingProfile', (p: V201['ClearChargingProfile']) => ({
          status: this.clearLimit(p.chargingProfileCriteria?.evseId) ? 'Accepted' : 'Unknown',
        }))
        .handle('TriggerMessage', (p: V201['TriggerMessage']) => {
          const status = this.trigger(p.requestedMessage, p.evse?.id);
          if (status === 'NotImplemented') return { status: 'NotImplemented' };
          return { status };
        });
    }
  }

  private unplugCable(c: Connector) {
    c.car = null;
    c.finishing = false;
    c.display = 'Cable unlocked';
    this.refresh();
  }

  // ------------------------------------------------------------------ things you do in the GUI

  async plug(connectorId: number, carIndex: number) {
    const c = this.findConnector(connectorId);
    const preset = CAR_PRESETS[carIndex] ?? CAR_PRESETS[0];
    if (!c || c.car) return;
    c.car = { ...preset, soc: Math.round(10 + Math.random() * 30) };
    c.finishing = false;
    c.display = c.faulted || !c.operative ? 'Out of service' : 'Tap your card to start';
    this.refresh();
    if (c.pending && c.operative && !c.faulted) {
      const p = c.pending;
      await this.startTx(c, p.idTag, { remote: p.remote, remoteStartId: p.remoteStartId });
    }
  }

  async unplug(connectorId: number) {
    const c = this.findConnector(connectorId);
    if (!c || !c.car) return;
    if (c.tx) await this.stopTx(c, 'EVDisconnected');
    c.car = null;
    c.finishing = false;
    c.display = c.operative && !c.faulted ? 'Plug in to start' : 'Out of service';
    this.refresh();
  }

  async tap(connectorId: number, idTag: string) {
    const c = this.findConnector(connectorId);
    if (!c) return;
    if (c.faulted || !c.operative) {
      c.display = 'Out of service';
      return this.emitState();
    }
    if (c.tx) {
      if (c.tx.idTag === idTag) return this.stopTx(c, 'Local');
      c.display = 'Card not linked to this session';
      return this.emitState();
    }
    c.display = 'Authorizing…';
    this.emitState();
    let status: string;
    try {
      status = await this.authorize(idTag);
    } catch (e) {
      c.display = 'Offline: cannot authorize';
      this.toast('error', (e as Error).message);
      return this.emitState();
    }
    if (status !== 'Accepted') {
      c.display = `Card rejected: ${status}`;
      this.toast('error', `${idTag} was ${status}`);
      return this.emitState();
    }
    if (c.car) return this.startTx(c, idTag, { remote: false });
    c.pending = { idTag, expires: Date.now() + PENDING_AUTH_TIMEOUT_MS, remote: false };
    c.display = 'Authorized. Plug in your car';
    this.emitState();
  }

  async stopButton(connectorId: number) {
    const c = this.findConnector(connectorId);
    if (c?.tx) await this.stopTx(c, 'Local');
  }

  async setFault(connectorId: number, on: boolean) {
    const c = this.findConnector(connectorId);
    if (!c) return;
    c.faulted = on;
    if (on && c.tx) await this.stopTx(c, 'Other');
    c.display = on ? 'Fault detected' : c.car ? 'Tap your card to start' : 'Plug in to start';
    this.refresh();
  }

  setSpeed(v: number) {
    this.simSpeed = Math.min(Math.max(v, 1), 600);
    this.emitState();
  }

  // ------------------------------------------------------------------ state for the GUI

  private pushLog(e: LogEntry) {
    this.logs.push(e);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', e);
  }

  private toast(level: 'info' | 'error' | 'success', text: string) {
    this.emit('toast', { level, text });
  }

  private emitState() {
    this.emit('state', this.state());
  }

  state(): ChargerState {
    return {
      config: this.config,
      connection: this.connState,
      connectors: this.connectors.map(
        (c): ConnectorView => ({
          id: c.id,
          label: c.label,
          type: c.type,
          maxPowerW: c.maxPowerW,
          status: this.statusOf(c),
          car: c.car ? { ...c.car } : null,
          powerW: Math.round(c.powerW),
          meterWh: Math.round(c.meterWh),
          limitW: c.limitW,
          operative: c.operative,
          faulted: c.faulted,
          pendingIdTag: c.pending?.idTag ?? null,
          transaction: c.tx
            ? {
                id: c.tx.id ?? '…',
                idTag: c.tx.idTag,
                startedAt: c.tx.startedAt,
                meterStartWh: Math.round(c.tx.meterStartWh),
                energyWh: Math.round(c.meterWh - c.tx.meterStartWh),
                remote: c.tx.remote,
              }
            : null,
          display: c.display,
        }),
      ),
      simSpeed: this.simSpeed,
      meterIntervalS: this.meterIntervalS,
      cars: CAR_PRESETS,
      cards: RFID_CARDS,
    };
  }

  shutdown() {
    clearInterval(this.tickTimer);
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.disconnect();
  }
}

export { OcppError };
