import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Central } from './central.ts';
import type { ServerToUi, UiToServer } from './types.ts';

const UI_PORT = Number(process.env.PORT ?? 8080);
const OCPP_PORT = Number(process.env.OCPP_PORT ?? 9000);
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');

const central = new Central(OCPP_PORT);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(central.state()));
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = path.join(STATIC_DIR, rel || 'index.html');
  if (!file.startsWith(STATIC_DIR)) file = path.join(STATIC_DIR, 'index.html');
  try {
    const body = await readFile(file).catch(() => readFile(path.join(STATIC_DIR, 'index.html')));
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? MIME['.html'] });
    res.end(body);
  } catch {
    res.writeHead(404).end('GUI not built. Run `npm run build` or use `npm run dev`.');
  }
});

const wss = new WebSocketServer({ server, path: '/ui' });
const send = (ws: WebSocket, msg: ServerToUi) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerToUi) => wss.clients.forEach((c) => send(c, msg));

let stateQueued = false;
central.on('state', () => {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => {
    stateQueued = false;
    broadcast({ type: 'state', state: central.state() });
  }, 80);
});
central.on('log', (entry) => broadcast({ type: 'log', entry }));
central.on('toast', (t) => broadcast({ type: 'toast', ...t }));

wss.on('connection', (ws) => {
  send(ws, { type: 'state', state: central.state() });
  send(ws, { type: 'logs', entries: central.logs });
  ws.on('message', async (data) => {
    let msg: UiToServer;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'command':
        try {
          const { action, result } = await central.command(msg.chargerId, msg.cmd);
          send(ws, { type: 'commandResult', reqId: msg.reqId, ok: true, action, result });
        } catch (e) {
          send(ws, { type: 'commandResult', reqId: msg.reqId, ok: false, action: msg.cmd.command, error: (e as Error).message });
        }
        break;
      case 'tag:upsert':
        central.upsertTag(msg.tag);
        break;
      case 'tag:delete':
        central.deleteTag(msg.idTag);
        break;
      case 'settings':
        central.updateSettings(msg.settings);
        break;
      case 'disconnect':
        central.disconnectCharger(msg.chargerId);
        break;
    }
  });
});

server.listen(UI_PORT, () => {
  console.log(`🛰  CSMS dashboard on http://localhost:${UI_PORT}`);
  console.log(`   OCPP endpoint  ws://0.0.0.0:${OCPP_PORT}/ocpp/<chargePointId>  (ocpp1.6, ocpp2.0.1)`);
});

const shutdown = () => {
  central.close();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
