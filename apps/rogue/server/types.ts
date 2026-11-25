import type { LogEntry, OcppVersion } from '@sim/ocpp';

/**
 * The attack modes a rogue / faulty charger can exhibit against a CSMS.
 * Every mode is independently toggleable (env var at boot, buttons in the GUI).
 */
export type AttackId =
  | 'malformed'
  | 'bogusMeter'
  | 'flood'
  | 'reconnectStorm'
  | 'replay'
  | 'oversized'
  | 'wrongType'
  | 'invalidTx'
  | 'ignoreCommands';

export interface AttackMeta {
  id: AttackId;
  label: string;
  /** One-line, plain-English description of what the CSMS will see. */
  blurb: string;
  /** Roughly how often this attack fires, in ms, before the intensity multiplier. */
  everyMs: number;
}

export const ATTACKS: AttackMeta[] = [
  {
    id: 'malformed',
    label: 'Malformed frames',
    blurb: 'Non-JSON junk, wrong array shapes, missing required fields and bad field types.',
    everyMs: 3000,
  },
  {
    id: 'bogusMeter',
    label: 'Impossible meter values',
    blurb: 'Negative energy, terawatt readings and counters that run backwards.',
    everyMs: 3500,
  },
  {
    id: 'flood',
    label: 'Message flood',
    blurb: 'Rapid-fire Heartbeat / StatusNotification bursts to stress the CSMS.',
    everyMs: 120,
  },
  {
    id: 'reconnectStorm',
    label: 'Reconnect storm',
    blurb: 'Opens and slams the WebSocket shut again every couple of seconds.',
    everyMs: 2200,
  },
  {
    id: 'replay',
    label: 'Replay & out-of-order',
    blurb: 'Re-uses old messageIds and sends CALLRESULTs for requests that were never made.',
    everyMs: 4000,
  },
  {
    id: 'oversized',
    label: 'Oversized payloads',
    blurb: 'Several-hundred-kilobyte string fields that blow past any sane length limit.',
    everyMs: 6000,
  },
  {
    id: 'wrongType',
    label: 'Bad message types',
    blurb: 'Frames with unknown message-type numbers and stray CALLERRORs.',
    everyMs: 5000,
  },
  {
    id: 'invalidTx',
    label: 'Invalid transaction ids',
    blurb: 'MeterValues and StopTransaction for transactions that were never started.',
    everyMs: 4500,
  },
  {
    id: 'ignoreCommands',
    label: 'Ignore CSMS commands',
    blurb: 'Never answers Reset / remote commands, and keeps many CALLs in flight at once.',
    everyMs: 0,
  },
];

export type AttackFlags = Record<AttackId, boolean>;

export interface RogueConfig {
  csmsUrl: string;
  chargePointId: string;
  version: OcppVersion;
  /** Scales every attack's firing rate: 1 = as listed, 2 = twice as fast. */
  intensity: number;
}

export interface RogueState {
  config: RogueConfig;
  connection: {
    state: 'disconnected' | 'connecting' | 'connected';
    connectedAt: number | null;
    socketOpens: number;
    error: string | null;
  };
  /** Master switch: when off, the node sits connected but behaves. */
  armed: boolean;
  attacks: AttackFlags;
  /** Rolling counters, handy for the GUI. */
  stats: {
    framesSent: number;
    attacksFired: Record<AttackId, number>;
    commandsIgnored: number;
    lastAttack: { id: AttackId; at: number } | null;
  };
}

export type RogueAction =
  | { type: 'arm'; on: boolean }
  | { type: 'toggle'; attack: AttackId; on: boolean }
  | { type: 'all'; on: boolean }
  | { type: 'intensity'; value: number }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'burst'; attack: AttackId };

export type ServerToUi =
  | { type: 'state'; state: RogueState }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };
