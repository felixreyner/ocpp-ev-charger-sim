import { errorCodes, FrameParseError, kindOf, parseFrame, type FrameKind, type OcppVersion } from './framing.ts';
import { validateRequest } from './schemas.ts';

/** One line in the message inspector. */
export interface LogEntry {
  seq: number;
  ts: number;
  dir: 'in' | 'out';
  kind: FrameKind;
  messageId: string;
  action: string;
  payload: unknown;
  errorCode?: string;
  errorDescription?: string;
  raw: string;
  /** For responses: how long after the request this arrived/was sent. */
  latencyMs?: number;
  version: OcppVersion;
  /** Who is on the other side (charge point id), filled in by the CSMS. */
  peer?: string;
}

export class OcppError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

type Handler = (payload: any) => unknown | Promise<unknown>;

interface Pending {
  action: string;
  sentAt: number;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let globalSeq = 0;

export interface RpcOptions {
  version: OcppVersion;
  send: (raw: string) => void;
  onLog?: (entry: LogEntry) => void;
  peer?: string;
  callTimeoutMs?: number;
}

/**
 * A transport-agnostic OCPP-J RPC endpoint. Both the charger and the CSMS use
 * this: you feed it raw strings from the socket with `receive()`, and it hands
 * you outgoing strings through `send`.
 *
 * The spec says each side may only have ONE outstanding CALL at a time, so
 * outgoing calls are queued until the previous one is answered.
 */
export class RpcEndpoint {
  private handlers = new Map<string, Handler>();
  private pending = new Map<string, Pending>();
  private incomingStarted = new Map<string, { action: string; at: number }>();
  private queue: Array<() => void> = [];
  private busy = false;
  private closed = false;
  private idCounter = 0;

  constructor(private opts: RpcOptions) {}

  get version() {
    return this.opts.version;
  }

  handle(action: string, fn: Handler) {
    this.handlers.set(action, fn);
    return this;
  }

  call<T = any>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Not connected'));
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        if (this.closed) {
          reject(new Error('Not connected'));
          return this.next();
        }
        const id = `${Date.now().toString(36)}-${(++this.idCounter).toString(36)}`;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${action} timed out`));
          this.next();
        }, this.opts.callTimeoutMs ?? 30_000);
        this.pending.set(id, { action, sentAt: Date.now(), resolve, reject, timer });
        this.write([2, id, action, payload], { kind: 'CALL', messageId: id, action, payload });
      };
      this.queue.push(run);
      if (!this.busy) this.next();
    });
  }

  private next() {
    const job = this.queue.shift();
    this.busy = !!job;
    job?.();
  }

  async receive(raw: string) {
    let frame;
    try {
      frame = parseFrame(raw);
    } catch (e) {
      const err = e as FrameParseError;
      this.log({ dir: 'in', kind: 'CALLERROR', messageId: err.messageId ?? '?', action: '?', payload: raw, raw, errorCode: 'ProtocolError', errorDescription: err.message });
      if (err.messageId) this.sendError(err.messageId, '?', errorCodes(this.version).protocolError, err.message);
      return;
    }

    if (frame[0] === 2) {
      const [, id, action, payload] = frame;
      this.log({ dir: 'in', kind: 'CALL', messageId: id, action, payload, raw });
      this.incomingStarted.set(id, { action, at: Date.now() });
      const handler = this.handlers.get(action);
      if (!handler) return this.sendError(id, action, errorCodes(this.version).notImplemented, `${action} is not implemented by this simulator`);
      const problem = validateRequest(this.version, action, payload);
      if (problem) return this.sendError(id, action, errorCodes(this.version).formatViolation, problem);
      try {
        const result = await handler(payload);
        this.write([3, id, (result ?? {}) as Record<string, unknown>], { kind: 'CALLRESULT', messageId: id, action, payload: result ?? {} });
      } catch (e) {
        if (e instanceof OcppError) this.sendError(id, action, e.code, e.message, e.details);
        else this.sendError(id, action, errorCodes(this.version).internalError, (e as Error).message);
      }
      return;
    }

    const id = frame[1];
    const p = this.pending.get(id);
    const action = p?.action ?? '?';
    const latencyMs = p ? Date.now() - p.sentAt : undefined;
    if (frame[0] === 3) {
      this.log({ dir: 'in', kind: 'CALLRESULT', messageId: id, action, payload: frame[2], raw, latencyMs });
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(frame[2]);
        this.next();
      }
    } else {
      const [, , code, desc, details] = frame;
      this.log({ dir: 'in', kind: 'CALLERROR', messageId: id, action, payload: details, raw, errorCode: code, errorDescription: desc, latencyMs });
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new OcppError(code, desc ? `${code}: ${desc}` : code, details));
        this.next();
      }
    }
  }

  close() {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
      this.pending.delete(id);
    }
    const q = this.queue;
    this.queue = [];
    q.forEach((job) => job());
    this.busy = false;
  }

  private sendError(id: string, action: string, code: string, description: string, details: Record<string, unknown> = {}) {
    this.write([4, id, code, description, details], { kind: 'CALLERROR', messageId: id, action, payload: details, errorCode: code, errorDescription: description });
  }

  private write(frame: unknown[], meta: Omit<LogEntry, 'seq' | 'ts' | 'dir' | 'raw' | 'version'>) {
    if (this.closed) return;
    const raw = JSON.stringify(frame);
    let latencyMs: number | undefined;
    if (meta.kind !== 'CALL') {
      const started = this.incomingStarted.get(meta.messageId);
      if (started) latencyMs = Date.now() - started.at;
      this.incomingStarted.delete(meta.messageId);
    }
    this.log({ ...meta, dir: 'out', raw, latencyMs });
    this.opts.send(raw);
  }

  private log(e: Omit<LogEntry, 'seq' | 'ts' | 'version'>) {
    this.opts.onLog?.({ ...e, seq: ++globalSeq, ts: Date.now(), version: this.version, peer: this.opts.peer });
  }
}

export { kindOf };
