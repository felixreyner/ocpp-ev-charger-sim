import type { LogEntry, OcppVersion } from '@sim/ocpp';

export interface ConnectorInfo {
  id: number;
  status: string;
  errorCode: string | null;
  updatedAt: number;
  powerW: number;
  soc: number | null;
  meterWh: number | null;
  txId: string | null;
}

export interface ChargerInfo {
  id: string;
  version: OcppVersion;
  connected: boolean;
  connectedAt: number | null;
  lastSeen: number | null;
  remoteAddress: string | null;
  bootStatus: 'None' | 'Accepted' | 'Pending' | 'Rejected';
  vendor: string | null;
  model: string | null;
  serial: string | null;
  firmware: string | null;
  stationStatus: string | null;
  connectors: ConnectorInfo[];
}

export type TagStatus = 'Accepted' | 'Blocked' | 'Expired';

export interface IdTag {
  idTag: string;
  label: string;
  status: TagStatus;
}

export interface Sample {
  t: number;
  powerW: number;
  energyWh: number;
}

export interface Transaction {
  id: string;
  chargerId: string;
  connectorId: number;
  idTag: string;
  version: OcppVersion;
  startedAt: number;
  stoppedAt: number | null;
  meterStartWh: number;
  energyWh: number;
  powerW: number;
  soc: number | null;
  stopReason: string | null;
  remoteStartId: number | null;
  samples: Sample[];
}

export interface Settings {
  heartbeatIntervalS: number;
  bootPolicy: 'Accepted' | 'Pending' | 'Rejected';
  acceptUnknownTags: boolean;
}

export interface CsmsState {
  chargers: ChargerInfo[];
  tags: IdTag[];
  transactions: Transaction[];
  settings: Settings;
  ocppPort: number;
  totals: { energyWh: number; sessions: number };
}

export type Command =
  | { command: 'remoteStart'; connectorId: number; idTag: string }
  | { command: 'remoteStop'; transactionId: string }
  | { command: 'reset'; type: string }
  | { command: 'unlock'; connectorId: number }
  | { command: 'availability'; connectorId: number; operative: boolean }
  | { command: 'setLimit'; connectorId: number; limit: number; unit: 'W' | 'A' }
  | { command: 'clearLimit'; connectorId: number }
  | { command: 'trigger'; message: string; connectorId?: number }
  | { command: 'raw'; action: string; payload: Record<string, unknown> };

export type UiToServer =
  | { type: 'command'; reqId: number; chargerId: string; cmd: Command }
  | { type: 'tag:upsert'; tag: IdTag }
  | { type: 'tag:delete'; idTag: string }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'disconnect'; chargerId: string };

export type ServerToUi =
  | { type: 'state'; state: CsmsState }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'commandResult'; reqId: number; ok: boolean; action: string; result?: unknown; error?: string }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };
