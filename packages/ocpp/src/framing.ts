/**
 * OCPP-J message framing.
 *
 * Every OCPP message on the WebSocket is a JSON array. The first element tells
 * you what kind of message it is:
 *
 *   [2, "<messageId>", "<Action>", {payload}]                 CALL       (a request)
 *   [3, "<messageId>", {payload}]                             CALLRESULT (a successful response)
 *   [4, "<messageId>", "<errorCode>", "<description>", {...}] CALLERROR  (an error response)
 *
 * A response always carries the same messageId as the request it answers.
 * This framing is identical in OCPP 1.6J and 2.0.1; only the actions and
 * payloads differ.
 */

export const MessageType = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 } as const;

export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1';
export const SUPPORTED_VERSIONS: OcppVersion[] = ['ocpp2.0.1', 'ocpp1.6'];

export const versionLabel = (v: OcppVersion) => (v === 'ocpp1.6' ? 'OCPP 1.6J' : 'OCPP 2.0.1');

export type CallFrame = [2, string, string, Record<string, unknown>];
export type CallResultFrame = [3, string, Record<string, unknown>];
export type CallErrorFrame = [4, string, string, string, Record<string, unknown>];
export type Frame = CallFrame | CallResultFrame | CallErrorFrame;

export type FrameKind = 'CALL' | 'CALLRESULT' | 'CALLERROR';

export class FrameParseError extends Error {
  constructor(message: string, public messageId?: string) {
    super(message);
  }
}

export function parseFrame(raw: string): Frame {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new FrameParseError('Message is not valid JSON');
  }
  if (!Array.isArray(data) || data.length < 3) throw new FrameParseError('Message is not an OCPP-J array');
  const [type, id] = data;
  if (typeof id !== 'string') throw new FrameParseError('messageId must be a string');
  const isObj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
  switch (type) {
    case MessageType.CALL:
      if (typeof data[2] !== 'string' || !isObj(data[3])) throw new FrameParseError('Malformed CALL', id);
      return data as CallFrame;
    case MessageType.CALLRESULT:
      if (!isObj(data[2])) throw new FrameParseError('Malformed CALLRESULT', id);
      return data as CallResultFrame;
    case MessageType.CALLERROR:
      return [4, id, String(data[2] ?? 'GenericError'), String(data[3] ?? ''), isObj(data[4]) ? data[4] : {}];
    default:
      throw new FrameParseError(`Unknown message type ${String(type)}`, id);
  }
}

export const kindOf = (f: Frame): FrameKind =>
  f[0] === 2 ? 'CALL' : f[0] === 3 ? 'CALLRESULT' : 'CALLERROR';

/** Error codes differ slightly between versions (1.6 spells one of them "FormationViolation"). */
export const errorCodes = (v: OcppVersion) => ({
  formatViolation: v === 'ocpp1.6' ? 'FormationViolation' : 'FormatViolation',
  notImplemented: 'NotImplemented',
  notSupported: 'NotSupported',
  internalError: 'InternalError',
  protocolError: 'ProtocolError',
  genericError: 'GenericError',
});
