import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import type { OcppVersion } from '@sim/ocpp';
import type { HandshakeAttackId } from './types.ts';

/**
 * Handshake-abuse probes.
 *
 * Unlike the frame-level modes (flood / oversized / injection), these do NOT
 * ride an established WebSocket. They open a *throwaway* HTTP upgrade request to
 * the CSMS whose handshake deliberately breaks the gateway contract in
 * `specs/openapi/ocpp-csms-gateway.openapi.yaml` — a wrong path, a bad
 * charge-point id, a wrong/missing subprotocol, or a disallowed method / query
 * string / body / header.
 *
 * This is exactly the layer FortiWeb's OpenAPI gateway validation *can* see: the
 * HTTP upgrade. A WAF loaded with the gateway spec in "reject anything not
 * described" mode denies every one of these before the WebSocket is ever
 * established. Without the WAF, the permissive CSMS accepts most of them (101),
 * which the probe reports back so the demo shows the difference.
 *
 * We craft the request with node's raw http(s) client (not the `ws` client) so
 * we can control the method, path, query, headers and body the `ws` client would
 * otherwise fix for us.
 */

export interface HandshakeCase {
  /** Short id for this concrete variant (shown in the inspector). */
  variant: string;
  /** Which gateway rule it breaks, in plain English. */
  why: string;
  /** HTTP method (default GET). */
  method?: string;
  /** Absolute pathname, overriding the normal `${base}/${id}` entirely. */
  rawPathname?: string;
  /** Replace just the charge-point id segment (percent-encoded onto the path). */
  idOverride?: string;
  /** Raw query string (without the leading `?`). */
  query?: string;
  /** Subprotocol: undefined = the node's real version, null = omit the header, else that literal. */
  subprotocol?: string | null;
  /** Extra / overriding request headers. */
  extraHeaders?: Record<string, string>;
  /** Request body bytes to send on the upgrade. */
  body?: string;
}

export interface HandshakeTarget {
  csmsUrl: string;
  chargePointId: string;
  version: OcppVersion;
}

export interface HandshakeRequest {
  method: string;
  pathname: string;
  query?: string;
  body?: string;
  subprotocol: string | null;
  headers: Record<string, string>;
  /** e.g. `GET /ocpp/CP%20001?debug=1` */
  requestLine: string;
}

export interface HandshakeProbeResult {
  variant: string;
  why: string;
  requestLine: string;
  subprotocol: string | null;
  /** HTTP status from the gateway/CSMS (101 = handshake accepted, i.e. NOT blocked). */
  status: number | null;
  /** True only when the upgrade succeeded (101). */
  accepted: boolean;
  error?: string;
}

const randomKey = () => crypto.randomBytes(16).toString('base64');

/** Build the concrete (network-free) HTTP upgrade request for a handshake case. */
export function buildHandshakeRequest(target: HandshakeTarget, kase: HandshakeCase): HandshakeRequest {
  const base = new URL(target.csmsUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const pathname =
    kase.rawPathname != null ? kase.rawPathname : `${basePath}/${encodeURIComponent(kase.idOverride ?? target.chargePointId)}`;
  const subprotocol = kase.subprotocol === undefined ? target.version : kase.subprotocol;
  const headers: Record<string, string> = {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomKey(),
    ...(subprotocol != null ? { 'Sec-WebSocket-Protocol': subprotocol } : {}),
    ...(kase.extraHeaders ?? {}),
  };
  const method = kase.method ?? 'GET';
  const target_ = pathname + (kase.query ? `?${kase.query}` : '');
  return { method, pathname, query: kase.query, body: kase.body, subprotocol, headers, requestLine: `${method} ${target_}` };
}

/** Open a single malformed upgrade request and report whether the gateway let it through. */
export function sendHandshakeProbe(
  target: HandshakeTarget,
  kase: HandshakeCase,
  done: (result: HandshakeProbeResult) => void,
  timeoutMs = 4000,
): void {
  const req = buildHandshakeRequest(target, kase);
  const base = new URL(target.csmsUrl);
  const secure = base.protocol === 'wss:';
  const lib = secure ? https : http;

  let settled = false;
  const finish = (partial: { status: number | null; accepted: boolean; error?: string }) => {
    if (settled) return;
    settled = true;
    done({ variant: kase.variant, why: kase.why, requestLine: req.requestLine, subprotocol: req.subprotocol, ...partial });
  };

  let r: http.ClientRequest;
  try {
    r = lib.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: base.hostname,
      port: base.port ? Number(base.port) : secure ? 443 : 80,
      method: req.method,
      path: req.pathname + (req.query ? `?${req.query}` : ''),
      headers: req.headers,
      timeout: timeoutMs,
    });
  } catch (err) {
    finish({ status: null, accepted: false, error: (err as Error).message });
    return;
  }

  r.on('upgrade', (res, socket) => {
    socket.destroy();
    finish({ status: res.statusCode ?? 101, accepted: true });
  });
  r.on('response', (res) => {
    res.resume();
    finish({ status: res.statusCode ?? null, accepted: false });
  });
  r.on('error', (err) => finish({ status: null, accepted: false, error: err.message }));
  r.on('timeout', () => {
    r.destroy();
    finish({ status: null, accepted: false, error: 'timeout' });
  });

  if (req.body != null) r.write(req.body);
  r.end();
}

/**
 * The concrete handshake violations, grouped by mode. One is picked at random
 * each time the mode fires. Every case here is something the gateway OpenAPI spec
 * describes as *not allowed*, so a WAF in reject-unknown mode denies it.
 */
export const HANDSHAKE_CASES: Record<HandshakeAttackId, HandshakeCase[]> = {
  badHandshakePath: [
    { variant: 'root', rawPathname: '/', why: 'root path, not /ocpp/{id}' },
    { variant: 'admin', rawPathname: '/admin', why: 'undocumented path /admin' },
    { variant: 'no-id', rawPathname: '/ocpp', why: '/ocpp with no charge-point id' },
    { variant: 'extra-segment', rawPathname: '/ocpp/CP-001/config', why: 'extra path segment after the id' },
    { variant: 'traversal', rawPathname: '/ocpp/..%2f..%2fadmin', why: 'path traversal in the id segment' },
  ],
  badChargePointId: [
    { variant: 'too-long', idOverride: 'C'.repeat(60), why: 'id longer than the 48-char limit' },
    { variant: 'space', idOverride: 'CP 001', why: 'space in id (outside the id pattern)' },
    { variant: 'symbols', idOverride: 'CP#001$', why: 'illegal characters in id' },
    { variant: 'unicode', idOverride: '充電器-666', why: 'non-ASCII id' },
    { variant: 'empty', idOverride: '', why: 'empty charge-point id' },
  ],
  badSubprotocol: [
    { variant: 'ocpp9.9', subprotocol: 'ocpp9.9', why: 'unsupported subprotocol ocpp9.9' },
    { variant: 'ocpp3.0', subprotocol: 'ocpp3.0', why: 'unsupported subprotocol ocpp3.0' },
    { variant: 'missing', subprotocol: null, why: 'no Sec-WebSocket-Protocol header' },
    { variant: 'chat', subprotocol: 'chat', why: 'non-OCPP subprotocol' },
    { variant: 'empty', subprotocol: '', why: 'empty subprotocol value' },
  ],
  handshakeExtras: [
    { variant: 'query', query: 'debug=1&cmd=reset', why: 'query string on the upgrade' },
    { variant: 'body', method: 'GET', body: '{"inject":"rogue"}', why: 'request body on the upgrade' },
    { variant: 'post', method: 'POST', why: 'non-GET method (POST) on the upgrade' },
    { variant: 'delete', method: 'DELETE', why: 'non-GET method (DELETE) on the upgrade' },
    { variant: 'bad-ws-version', extraHeaders: { 'Sec-WebSocket-Version': '8' }, why: 'unsupported Sec-WebSocket-Version' },
  ],
};
