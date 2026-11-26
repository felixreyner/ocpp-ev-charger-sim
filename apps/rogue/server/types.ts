import type { LogEntry, OcppVersion } from '@sim/ocpp';

/**
 * The attack modes a rogue / faulty charger can exhibit against a CSMS.
 * Every mode is independently toggleable (env var at boot, buttons in the GUI).
 *
 * Two families:
 *  - Handshake-abuse modes break the gateway contract in
 *    `specs/openapi/ocpp-csms-gateway.openapi.yaml` at the HTTP upgrade (wrong
 *    path, bad id, bad subprotocol, disallowed method/query/body/header). These
 *    are exactly what FortiWeb's OpenAPI gateway validation sees and rejects
 *    before the WebSocket is established.
 *  - In-frame modes ride an established WebSocket, so OpenAPI validation can't
 *    see them; they are caught by rate/connection limits (flood, reconnectStorm),
 *    the WebSocket frame/message size cap (oversized) or signature scanning
 *    (injection). Schema-only modes (malformed, bogus meter, wrong type) were
 *    removed, since FortiWeb can't apply a schema inside the WebSocket.
 */

/** Modes that abuse the HTTP WebSocket handshake itself (gateway OpenAPI layer). */
export const HANDSHAKE_ATTACK_IDS = ['badHandshakePath', 'badChargePointId', 'badSubprotocol', 'handshakeExtras'] as const;
export type HandshakeAttackId = (typeof HANDSHAKE_ATTACK_IDS)[number];

export type AttackId =
  | 'flood'
  | 'reconnectStorm'
  | 'oversized'
  | 'sqlInjection'
  | 'xssPayload'
  | 'pathTraversal'
  | HandshakeAttackId;

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
    id: 'badHandshakePath',
    label: 'Bad handshake path',
    blurb: 'Opens the WebSocket on a wrong path (/admin, /ocpp with no id, extra segments, ..%2f traversal) — rejected by the gateway OpenAPI path rule.',
    everyMs: 7000,
  },
  {
    id: 'badChargePointId',
    label: 'Illegal charge-point id',
    blurb: 'Handshake with an id that breaks the gateway pattern: over 48 chars, spaces, illegal symbols, non-ASCII or empty.',
    everyMs: 7500,
  },
  {
    id: 'badSubprotocol',
    label: 'Wrong/missing subprotocol',
    blurb: 'Offers a bogus Sec-WebSocket-Protocol (ocpp9.9, chat, empty) or none at all, instead of ocpp1.6 / ocpp2.0.1.',
    everyMs: 8000,
  },
  {
    id: 'handshakeExtras',
    label: 'Disallowed upgrade extras',
    blurb: 'Upgrade carrying a query string, an HTTP body, a non-GET method (POST/DELETE) or a bad Sec-WebSocket-Version the gateway spec forbids.',
    everyMs: 8500,
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
    blurb: 'Floods the gateway with back-to-back WebSocket handshakes — parallel bursts of short-lived connections, ~20 new connections/sec per intensity step (≈20/sec at ×1, ≈160/sec at ×8) to blow past a connections-per-second limit.',
    everyMs: 2200,
  },
  {
    id: 'oversized',
    label: 'Oversized payloads',
    blurb: 'Several-hundred-kilobyte frames that blow past any WebSocket frame / message size cap.',
    everyMs: 6000,
  },
  {
    id: 'sqlInjection',
    label: 'SQL injection strings',
    blurb: "SQL payloads (' OR 1=1--, UNION SELECT, DROP TABLE) smuggled into idTag / vendor fields.",
    everyMs: 4000,
  },
  {
    id: 'xssPayload',
    label: 'XSS / script payloads',
    blurb: '<script>, <img onerror> and javascript: URIs planted in idTag and vendor strings.',
    everyMs: 4500,
  },
  {
    id: 'pathTraversal',
    label: 'Path traversal strings',
    blurb: '../../etc/passwd and encoded ..%2f sequences in idTag, vendor and transaction ids.',
    everyMs: 4800,
  },
];

export type AttackFlags = Record<AttackId, boolean>;

/**
 * Reconnect-storm rate model, shared by the engine (which drives it) and the GUI
 * (which labels it). Each 100 ms tick opens `2 × intensity` parallel short-lived
 * handshakes, so the new-connection rate is ~20 × intensity per second.
 */
export const STORM_TICK_MS = 100;
export const STORM_BURST_PER_INTENSITY = 2;
/** Approximate new connections/sec the reconnect storm produces at an intensity. */
export const stormRatePerSecond = (intensity: number): number =>
  Math.round((1000 / STORM_TICK_MS) * STORM_BURST_PER_INTENSITY * Math.min(8, Math.max(1, intensity || 1)));

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
  /** The CSMS URL the node booted with (from CSMS_URL), for "reset to default". */
  defaultCsmsUrl: string;
  /** Master switch: when off, the node sits connected but behaves. */
  armed: boolean;
  attacks: AttackFlags;
  /** Rolling counters, handy for the GUI. */
  stats: {
    framesSent: number;
    attacksFired: Record<AttackId, number>;
    /** Frames carrying an injection signature (SQLi / XSS / path traversal). */
    injectionProbes: number;
    /** Malformed WebSocket handshakes attempted against the gateway. */
    handshakeProbes: number;
    /** Handshake probes the gateway/CSMS rejected (non-101). */
    handshakeBlocked: number;
    lastAttack: { id: AttackId; at: number } | null;
  };
}

export type RogueAction =
  | { type: 'arm'; on: boolean }
  | { type: 'toggle'; attack: AttackId; on: boolean }
  | { type: 'all'; on: boolean }
  | { type: 'intensity'; value: number }
  | { type: 'setTarget'; csmsUrl: string }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'burst'; attack: AttackId };

export type ServerToUi =
  | { type: 'state'; state: RogueState }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'toast'; level: 'info' | 'error' | 'success'; text: string };
