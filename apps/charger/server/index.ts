import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { OcppVersion } from '@sim/ocpp';
import { Station } from './station.ts';
import type { ChargerAction, ServerToUi } from './types.ts';

const PORT = Number(process.env.PORT ?? 8081);
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');

const station = new Station({
  csmsUrl: process.env.CSMS_URL ?? 'ws://localhost:9000/ocpp',
  chargePointId: process.env.CHARGE_POINT_ID ?? 'CP-001',
  version: (process.env.OCPP_VERSION as OcppVersion) ?? 'ocpp1.6',
  vendor: 'VoltForge',
  model: 'Hypercharger X2',
  serial: 'VF-X2-000731',
  firmware: '2.4.1',
});
station.connect();

// ---------- static GUI (production build) ----------
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
    return res.end(JSON.stringify(station.state()));
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = path.join(STATIC_DIR, rel || 'index.html');
  if (!file.startsWith(STATIC_DIR)) file = path.join(STATIC_DIR, 'index.html');
  try {
    const body = await readFile(file).catch(() => readFile(path.join(STATIC_DIR, 'index.html')));
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] ?? MIME['.html'] });
    res.end(body);
  } catch {
    res.writeHead(404).end('GUI not built. Run `npm run build` or use `npm run dev`.');
  }
});

// ---------- live connection to the GUI ----------
const wss = new WebSocketServer({ server, path: '/ui' });
const broadcast = (msg: ServerToUi) => {
  const raw = JSON.stringify(msg);
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(raw));
};

let pendingState: ReturnType<Station['state']> | null = null;
station.on('state', (state) => {
  // coalesce bursts of state changes into one frame
  if (!pendingState) setTimeout(() => {
    broadcast({ type: 'state', state: pendingState! });
    pendingState = null;
  }, 50);
  pendingState = state;
});
station.on('log', (entry) => broadcast({ type: 'log', entry }));
station.on('toast', (t) => broadcast({ type: 'toast', ...t }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state: station.state() } satisfies ServerToUi));
  ws.send(JSON.stringify({ type: 'logs', entries: station.logs } satisfies ServerToUi));
  ws.on('message', async (data) => {
    let a: ChargerAction;
    try {
      a = JSON.parse(data.toString());
    } catch {
      return;
    }
    try {
      switch (a.type) {
        case 'plug': return await station.plug(a.connectorId, a.car);
        case 'unplug': return await station.unplug(a.connectorId);
        case 'tap': return await station.tap(a.connectorId, a.idTag);
        case 'stop': return await station.stopButton(a.connectorId);
        case 'fault': return await station.setFault(a.connectorId, a.on);
        case 'speed': return station.setSpeed(a.value);
        case 'connect': return station.connect();
        case 'disconnect': return station.disconnect();
        case 'config': return await station.reconfigure(a.config);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'toast', level: 'error', text: (e as Error).message } satisfies ServerToUi));
    }
  });
});

server.listen(PORT, () => {
  console.log(`⚡ Charger simulator GUI on http://localhost:${PORT}`);
  console.log(`   connecting to ${station.config.csmsUrl}/${station.config.chargePointId} with ${station.config.version}`);
});

const shutdown = () => {
  station.shutdown();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
