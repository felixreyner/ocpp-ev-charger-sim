import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { RpcEndpoint, SUPPORTED_VERSIONS, type LogEntry, type OcppVersion, type V16, type V201 } from '@sim/ocpp';
import type { ChargerInfo, Command, ConnectorInfo, CsmsState, IdTag, Settings, Transaction } from './types.ts';

interface Session {
  ws: WebSocket;
  rpc: RpcEndpoint;
}

const MAX_SAMPLES = 240;
const now = () => new Date().toISOString();

/**
 * The Charging Station Management System (CSMS), a.k.a. "Central System" in
 * OCPP 1.6. It accepts WebSocket connections from chargers on
 * ws://<host>:<port>/ocpp/<chargePointId> and speaks 1.6J or 2.0.1 depending
 * on the subprotocol the charger asks for.
 */
export class Central extends EventEmitter {
  chargers = new Map<string, ChargerInfo>();
  sessions = new Map<string, Session>();
  transactions: Transaction[] = [];
  logs: LogEntry[] = [];
  tags: IdTag[] = [
    { idTag: 'ALICE-0001', label: 'Alice (fleet card)', status: 'Accepted' },
    { idTag: 'BOB-0002', label: 'Bob', status: 'Accepted' },
    { idTag: 'CAROL-0003', label: 'Carol (expired subscription)', status: 'Expired' },
    { idTag: 'BLOCKED-6666', label: 'Stolen card', status: 'Blocked' },
  ];
  settings: Settings = { heartbeatIntervalS: 30, bootPolicy: 'Accepted', acceptUnknownTags: false };

  private nextTxId = 1001;
  private nextRemoteStartId = 1;
  private wss: WebSocketServer;

  constructor(public port: number) {
    super();
    this.wss = new WebSocketServer({
      port,
      host: '0.0.0.0',
      // Pick the first OCPP version the charger offers that we support.
      handleProtocols: (offered) => {
        for (const p of offered) if ((SUPPORTED_VERSIONS as string[]).includes(p)) return p;
        return false;
      },
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const parts = (req.url ?? '/').split('?')[0].split('/').filter(Boolean);
    const id = decodeURIComponent(parts[parts.length - 1] ?? '');
    if (!id || id === 'ocpp') {
      ws.close(1008, 'Charge point id missing from URL');
      return;
    }
    // A charger that sends no subprotocol is treated as 1.6J (many older devices do this).
    const version = (ws.protocol || 'ocpp1.6') as OcppVersion;

    const old = this.sessions.get(id);
    if (old) old.ws.close(1000, 'Replaced by new connection');

    const prev = this.chargers.get(id);
    const charger: ChargerInfo = {
      id,
      version,
      connected: true,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      remoteAddress: req.socket.remoteAddress ?? null,
      bootStatus: 'None',
      vendor: prev?.vendor ?? null,
      model: prev?.model ?? null,
      serial: prev?.serial ?? null,
      firmware: prev?.firmware ?? null,
      stationStatus: null,
      connectors: prev && prev.version === version ? prev.connectors : [],
    };
    this.chargers.set(id, charger);

    const rpc = new RpcEndpoint({ version, peer: id, send: (raw) => ws.send(raw), onLog: (e) => this.pushLog(e) });
    if (version === 'ocpp1.6') this.handlers16(rpc, charger);
    else this.handlers201(rpc, charger);
    const session = { ws, rpc };
    this.sessions.set(id, session);

    ws.on('message', (data) => {
      charger.lastSeen = Date.now();
      rpc.receive(data.toString());
    });
    ws.on('close', () => {
      rpc.close();
      if (this.sessions.get(id) === session) {
        this.sessions.delete(id);
        charger.connected = false;
        this.toast('info', `${id} disconnected`);
        this.changed();
      }
    });
    this.toast('success', `${id} connected using ${version}`);
    this.changed();
  }

  // ------------------------------------------------------------------ helpers

  private connector(charger: ChargerInfo, id: number): ConnectorInfo {
    let c = charger.connectors.find((x) => x.id === id);
    if (!c) {
      c = { id, status: 'Unknown', errorCode: null, updatedAt: Date.now(), powerW: 0, soc: null, meterWh: null, txId: null };
      charger.connectors.push(c);
      charger.connectors.sort((a, b) => a.id - b.id);
    }
    return c;
  }

  private tagStatus(idTag: string, chargerId?: string, connectorId?: number): string {
    const tag = this.tags.find((t) => t.idTag === idTag);
    if (!tag) return this.settings.acceptUnknownTags ? 'Accepted' : 'Invalid';
    if (tag.status !== 'Accepted') return tag.status;
    const busy = this.transactions.find(
      (t) => !t.stoppedAt && t.idTag === idTag && !(t.chargerId === chargerId && t.connectorId === connectorId),
    );
    return busy ? 'ConcurrentTx' : 'Accepted';
  }

  private findTx(chargerId: string, id: string) {
    return this.transactions.find((t) => t.chargerId === chargerId && t.id === id);
  }

  private openTx(charger: ChargerInfo, id: string, connectorId: number, idTag: string, meterStartWh: number, startedAt: number, remoteStartId: number | null) {
    const tx: Transaction = {
      id,
      chargerId: charger.id,
      connectorId,
      idTag,
      version: charger.version,
      startedAt,
      stoppedAt: null,
      meterStartWh,
      energyWh: 0,
      powerW: 0,
      soc: null,
      stopReason: null,
      remoteStartId,
      samples: [{ t: startedAt, powerW: 0, energyWh: 0 }],
    };
    this.transactions.unshift(tx);
    if (this.transactions.length > 100) this.transactions.pop();
    const c = this.connector(charger, connectorId);
    c.txId = id;
    c.meterWh = meterStartWh;
    this.toast('success', `Session ${id} started on ${charger.id} #${connectorId} (${idTag})`);
    return tx;
  }

  private closeTx(charger: ChargerInfo, tx: Transaction, meterStopWh: number | null, reason: string | null) {
    if (meterStopWh !== null) tx.energyWh = Math.max(0, meterStopWh - tx.meterStartWh);
    tx.stoppedAt = Date.now();
    tx.stopReason = reason ?? 'Local';
    tx.powerW = 0;
    const c = this.connector(charger, tx.connectorId);
    if (c.txId === tx.id) {
      c.txId = null;
      c.powerW = 0;
    }
    this.toast('info', `Session ${tx.id} ended: ${(tx.energyWh / 1000).toFixed(2)} kWh (${tx.stopReason})`);
  }

  /** Normalise sampled values from either version into numbers. */
  private applyMeter(charger: ChargerInfo, connectorId: number, values: Array<{ value: string | number; measurand?: string; unit?: string }>, tx?: Transaction) {
    const c = this.connector(charger, connectorId);
    for (const v of values) {
      const n = Number(v.value);
      if (Number.isNaN(n)) continue;
      const measurand = v.measurand ?? 'Energy.Active.Import.Register';
      if (measurand === 'Energy.Active.Import.Register') c.meterWh = v.unit === 'kWh' ? n * 1000 : n;
      else if (measurand === 'Power.Active.Import') c.powerW = v.unit === 'kW' ? n * 1000 : n;
      else if (measurand === 'SoC') c.soc = n;
    }
    if (tx && !tx.stoppedAt) {
      if (c.meterWh !== null) tx.energyWh = Math.max(0, c.meterWh - tx.meterStartWh);
      tx.powerW = c.powerW;
      tx.soc = c.soc;
      tx.samples.push({ t: Date.now(), powerW: c.powerW, energyWh: tx.energyWh });
      if (tx.samples.length > MAX_SAMPLES) tx.samples.shift();
    }
  }

  private bootResponse(charger: ChargerInfo) {
    charger.bootStatus = this.settings.bootPolicy;
    return { currentTime: now(), interval: this.settings.heartbeatIntervalS, status: this.settings.bootPolicy };
  }

  // ------------------------------------------------------------------ OCPP 1.6J handlers

  private handlers16(rpc: RpcEndpoint, charger: ChargerInfo) {
    rpc
      .handle('BootNotification', (p: V16['BootNotification']) => {
        Object.assign(charger, { vendor: p.chargePointVendor, model: p.chargePointModel, serial: p.chargePointSerialNumber ?? null, firmware: p.firmwareVersion ?? null });
        const res = this.bootResponse(charger);
        this.changed();
        return res;
      })
      .handle('Heartbeat', () => ({ currentTime: now() }))
      .handle('StatusNotification', (p: V16['StatusNotification']) => {
        if (p.connectorId === 0) charger.stationStatus = p.status;
        else {
          const c = this.connector(charger, p.connectorId);
          Object.assign(c, { status: p.status, errorCode: p.errorCode === 'NoError' ? null : p.errorCode, updatedAt: Date.now() });
          if (p.status !== 'Charging') c.powerW = 0;
        }
        this.changed();
        return {};
      })
      .handle('Authorize', (p: V16['Authorize']) => ({ idTagInfo: { status: this.tagStatus(p.idTag, charger.id) } }))
      .handle('StartTransaction', (p: V16['StartTransaction']) => {
        const status = this.tagStatus(p.idTag, charger.id, p.connectorId);
        const id = String(this.nextTxId++);
        // We record the session even if not accepted; the charger will stop it straight away.
        this.openTx(charger, id, p.connectorId, p.idTag, p.meterStart, Date.parse(p.timestamp), null);
        this.changed();
        return { transactionId: Number(id), idTagInfo: { status } };
      })
      .handle('StopTransaction', (p: V16['StopTransaction']) => {
        const tx = this.findTx(charger.id, String(p.transactionId));
        if (tx) this.closeTx(charger, tx, p.meterStop, p.reason ?? null);
        this.changed();
        return p.idTag ? { idTagInfo: { status: this.tagStatus(p.idTag) === 'Blocked' ? 'Blocked' : 'Accepted' } } : {};
      })
      .handle('MeterValues', (p: V16['MeterValues']) => {
        const tx = p.transactionId !== undefined ? this.findTx(charger.id, String(p.transactionId)) : undefined;
        for (const mv of p.meterValue) this.applyMeter(charger, p.connectorId, mv.sampledValue, tx);
        this.changed();
        return {};
      });
  }

  // ------------------------------------------------------------------ OCPP 2.0.1 handlers

  private handlers201(rpc: RpcEndpoint, charger: ChargerInfo) {
    const flat = (mvs: V201['TransactionEvent']['meterValue']) =>
      (mvs ?? []).flatMap((mv) => mv.sampledValue.map((s) => ({ value: s.value, measurand: s.measurand, unit: s.unitOfMeasure?.unit })));

    rpc
      .handle('BootNotification', (p: V201['BootNotification']) => {
        const cs = p.chargingStation;
        Object.assign(charger, { vendor: cs.vendorName, model: cs.model, serial: cs.serialNumber ?? null, firmware: cs.firmwareVersion ?? null });
        const res = this.bootResponse(charger);
        this.changed();
        return res;
      })
      .handle('Heartbeat', () => ({ currentTime: now() }))
      .handle('StatusNotification', (p: V201['StatusNotification']) => {
        const c = this.connector(charger, p.evseId);
        Object.assign(c, { status: p.connectorStatus, errorCode: p.connectorStatus === 'Faulted' ? 'Faulted' : null, updatedAt: Date.now() });
        this.changed();
        return {};
      })
      .handle('Authorize', (p: V201['Authorize']) => ({ idTokenInfo: { status: this.tagStatus(p.idToken.idToken, charger.id) } }))
      .handle('MeterValues', (p: V201['MeterValues']) => {
        this.applyMeter(charger, p.evseId, flat(p.meterValue));
        this.changed();
        return {};
      })
      .handle('TransactionEvent', (p: V201['TransactionEvent']) => {
        const id = p.transactionInfo.transactionId;
        let tx = this.findTx(charger.id, id);
        const values = flat(p.meterValue);
        const energy = values.find((v) => (v.measurand ?? 'Energy.Active.Import.Register') === 'Energy.Active.Import.Register');
        const meterWh = energy ? Number(energy.value) * (energy.unit === 'kWh' ? 1000 : 1) : null;
        let response: Record<string, unknown> = {};

        if (!tx && p.eventType !== 'Ended') {
          // evse is only required in the first event of a transaction
          const evseId = p.evse?.id ?? 1;
          tx = this.openTx(charger, id, evseId, p.idToken?.idToken ?? 'unknown', meterWh ?? 0, Date.parse(p.timestamp), p.transactionInfo.remoteStartId ?? null);
        }
        if (p.idToken) response = { idTokenInfo: { status: this.tagStatus(p.idToken.idToken, charger.id, tx?.connectorId) } };
        if (tx) {
          const c = this.connector(charger, tx.connectorId);
          if (p.transactionInfo.chargingState === 'Charging') c.status = 'Occupied';
          this.applyMeter(charger, tx.connectorId, values, tx);
          if (p.transactionInfo.chargingState && p.transactionInfo.chargingState !== 'Charging') c.powerW = 0;
          if (p.eventType === 'Ended') this.closeTx(charger, tx, meterWh, p.transactionInfo.stoppedReason ?? null);
        }
        this.changed();
        return response;
      });
  }

  // ------------------------------------------------------------------ commands from the dashboard

  async command(chargerId: string, cmd: Command): Promise<{ action: string; result: unknown }> {
    const session = this.sessions.get(chargerId);
    const charger = this.chargers.get(chargerId);
    if (!session || !charger) throw new Error(`${chargerId} is not connected`);
    const v16 = charger.version === 'ocpp1.6';
    const [action, payload] = this.buildCommand(v16, cmd);
    const result = await session.rpc.call(action, payload);
    return { action, result };
  }

  private buildCommand(v16: boolean, cmd: Command): [string, Record<string, unknown>] {
    switch (cmd.command) {
      case 'remoteStart':
        return v16
          ? ['RemoteStartTransaction', { connectorId: cmd.connectorId, idTag: cmd.idTag }]
          : ['RequestStartTransaction', { idToken: { idToken: cmd.idTag, type: 'ISO14443' }, remoteStartId: this.nextRemoteStartId++, evseId: cmd.connectorId }];
      case 'remoteStop':
        return v16 ? ['RemoteStopTransaction', { transactionId: Number(cmd.transactionId) }] : ['RequestStopTransaction', { transactionId: cmd.transactionId }];
      case 'reset':
        return ['Reset', { type: cmd.type }];
      case 'unlock':
        return v16 ? ['UnlockConnector', { connectorId: cmd.connectorId }] : ['UnlockConnector', { evseId: cmd.connectorId, connectorId: 1 }];
      case 'availability': {
        const type = cmd.operative ? 'Operative' : 'Inoperative';
        return v16
          ? ['ChangeAvailability', { connectorId: cmd.connectorId, type }]
          : ['ChangeAvailability', { operationalStatus: type, ...(cmd.connectorId ? { evse: { id: cmd.connectorId } } : {}) }];
      }
      case 'setLimit': {
        const period = { startPeriod: 0, limit: cmd.limit };
        return v16
          ? [
              'SetChargingProfile',
              {
                connectorId: cmd.connectorId,
                csChargingProfiles: {
                  chargingProfileId: 1,
                  stackLevel: 0,
                  chargingProfilePurpose: 'TxDefaultProfile',
                  chargingProfileKind: 'Relative',
                  chargingSchedule: { chargingRateUnit: cmd.unit, chargingSchedulePeriod: [period] },
                } satisfies V16['SetChargingProfile']['csChargingProfiles'],
              },
            ]
          : [
              'SetChargingProfile',
              {
                evseId: cmd.connectorId,
                chargingProfile: {
                  id: 1,
                  stackLevel: 0,
                  chargingProfilePurpose: 'TxDefaultProfile',
                  chargingProfileKind: 'Relative',
                  chargingSchedule: [{ id: 1, chargingRateUnit: cmd.unit, chargingSchedulePeriod: [period] }],
                } satisfies V201['SetChargingProfile']['chargingProfile'],
              },
            ];
      }
      case 'clearLimit':
        return v16
          ? ['ClearChargingProfile', cmd.connectorId ? { connectorId: cmd.connectorId } : {}]
          : ['ClearChargingProfile', cmd.connectorId ? { chargingProfileCriteria: { evseId: cmd.connectorId } } : {}];
      case 'trigger':
        return v16
          ? ['TriggerMessage', { requestedMessage: cmd.message, ...(cmd.connectorId ? { connectorId: cmd.connectorId } : {}) }]
          : ['TriggerMessage', { requestedMessage: cmd.message, ...(cmd.connectorId ? { evse: { id: cmd.connectorId } } : {}) }];
      case 'raw':
        return [cmd.action, cmd.payload];
    }
  }

  disconnectCharger(id: string) {
    this.sessions.get(id)?.ws.close(1000, 'Disconnected by operator');
  }

  upsertTag(tag: IdTag) {
    const i = this.tags.findIndex((t) => t.idTag === tag.idTag);
    if (i >= 0) this.tags[i] = tag;
    else this.tags.push(tag);
    this.changed();
  }

  deleteTag(idTag: string) {
    this.tags = this.tags.filter((t) => t.idTag !== idTag);
    this.changed();
  }

  updateSettings(s: Partial<Settings>) {
    this.settings = { ...this.settings, ...s };
    this.changed();
  }

  // ------------------------------------------------------------------ state for the dashboard

  private pushLog(e: LogEntry) {
    this.logs.push(e);
    if (this.logs.length > 800) this.logs.shift();
    this.emit('log', e);
  }

  private toast(level: 'info' | 'error' | 'success', text: string) {
    this.emit('toast', { level, text });
  }

  private changed() {
    this.emit('state');
  }

  state(): CsmsState {
    const done = this.transactions.filter((t) => t.stoppedAt);
    return {
      chargers: [...this.chargers.values()],
      tags: this.tags,
      transactions: this.transactions.slice(0, 50),
      settings: this.settings,
      ocppPort: this.port,
      totals: {
        energyWh: this.transactions.reduce((s, t) => s + t.energyWh, 0),
        sessions: done.length,
      },
    };
  }

  close() {
    this.wss.close();
  }
}
