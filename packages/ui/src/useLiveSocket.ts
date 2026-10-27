import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@sim/ocpp';

export interface Toast {
  id: number;
  level: 'info' | 'error' | 'success';
  text: string;
}

const MAX_LOGS = 600;
let toastId = 0;

/**
 * Connects to the app's own backend (/ui WebSocket), keeps the latest state
 * snapshot, the OCPP message log, and transient toasts.
 */
export function useLiveSocket<S>(onOther?: (msg: any) => void) {
  const [state, setState] = useState<S | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const otherRef = useRef(onOther);
  otherRef.current = onOther;

  const pushToast = useCallback((level: Toast['level'], text: string) => {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-4), { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ui`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(open, 1500);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case 'state':
            setState(msg.state);
            break;
          case 'logs':
            setLogs(msg.entries.slice(-MAX_LOGS));
            break;
          case 'log':
            setLogs((l) => (l.length >= MAX_LOGS ? [...l.slice(-MAX_LOGS + 1), msg.entry] : [...l, msg.entry]));
            break;
          case 'toast':
            pushToast(msg.level, msg.text);
            break;
          default:
            otherRef.current?.(msg);
        }
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [pushToast]);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { state, logs, setLogs, connected, send, toasts, pushToast };
}
