import type { LogEntry, OcppVersion } from '@sim/ocpp';

/** The detailed (OCPP 1.6 style) connector state. 2.0.1 maps it down to Available/Occupied/... */
export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEV'
  | 'SuspendedEVSE'
  | 'Finishing'
  | 'Unavailable'
  | 'Faulted';

export interface CarPreset {
  name: string;
  capacityKWh: number;
  maxAcKW: number;
  maxDcKW: number;
  color: string;
}

export interface ConnectorView {
  id: number;
  label: string;
  type: 'DC' | 'AC';
  maxPowerW: number;
  status: ConnectorStatus;
  car: (CarPreset & { soc: number }) | null;
  powerW: number;
  meterWh: number;
  limitW: number | null;
  operative: boolean;
  faulted: boolean;
  pendingIdTag: string | null;
  transaction: {
    id: string;
    idTag: string;
    startedAt: number;
    meterStartWh: number;
    energyWh: number;
    remote: boolean;
  } | null;
  /** Last message shown on the charger's little screen. */
  display: string;
}

export interface ChargerConfig {
  csmsUrl: string;
  chargePointId: string;
  version: OcppVersion;
  vendor: string;
  model: string;
  serial: string;
  firmware: string;
}

export interface ChargerState {
  config: ChargerConfig;
  connection: {
    state: 'disconnected' | 'connecting' | 'connected';
    bootStatus: 'None' | 'Pending' | 'Accepted' | 'Rejected';
    heartbeatIntervalS: number;
    lastHeartbeat: number | null;
    connectedAt: number | null;
    error: string | null;
  };
  connectors: ConnectorView[];
  simSpeed: number;
  meterIntervalS: number;
  cars: CarPreset[];
  cards: string[];
}

export type ChargerAction =
  | { type: 'plug'; connectorId: number; car: number }
  | { type: 'unplug'; connectorId: number }
  | { type: 'tap'; connectorId: number; idTag: string }
  | { type: 'stop'; connectorId: number }
  | { type: 'fault'; connectorId: number; on: boolean }
  | { type: 'speed'; value: number }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'config'; config: Partial<ChargerConfig> };

export type ServerToUi =
  | { type: 'state'; state: ChargerState }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };
