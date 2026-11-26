import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { OcppVersion } from '@sim/ocpp';
import { RogueCharger } from './rogue.ts';
import { ATTACKS, type AttackFlags, type AttackId, type RogueAction, type ServerToUi } from './types.ts';

const PORT = Number(process.env.PORT ?? 8082);
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');

/** Default mix: broadly rogue, but the two noisiest modes (flood, reconnect
 *  storm) start off so a fresh `docker compose up` stays legible. Toggle them
 *  in the GUI, or set ROGUE_ATTACKS. */
const DEFAULT_ON: AttackId[] = ['oversized', 'sqlInjection', 'xssPayload', 'pathTraversal'];

function parseAttacks(): AttackFlags {
  const flags = Object.fromEntries(ATTACKS.map((a) => [a.id, false])) as AttackFlags;
  const raw = (process.env.ROGUE_ATTACKS ?? '').trim();
  if (!raw) {
    for (const id of DEFAULT_ON) flags[id] = true;
    return flags;
  }
  if (raw.toLowerCase() === 'all') {
    for (const a of ATTACKS) flags[a.id] = true;
    return flags;
  }
  if (raw.toLowerCase() === 'none') return flags;
  const wanted = new Set(raw.split(',').map((s) => s.trim()));
  const valid = new Set(ATTACKS.map((a) => a.id));
  for (const id of wanted) {
    if (valid.has(id as AttackId)) flags[id as AttackId] = true;
    else console.warn(`⚠ ROGUE_ATTACKS: unknown attack "${id}" ignored`);
  }
  return flags;
}

const armed = (process.env.ROGUE_ARMED ?? 'true').toLowerCase() !== 'false';

const rogue = new RogueCharger(
  {
    csmsUrl: process.env.CSMS_URL ?? 'ws://localhost:9000/ocpp',
    chargePointId: process.env.CHARGE_POINT_ID ?? 'ROGUE-666',
    version: (process.env.OCPP_VERSION as OcppVersion) ?? 'ocpp1.6',
    intensity: Math.min(8, Math.max(1, Number(process.env.ROGUE_INTENSITY ?? 1) || 1)),
  },
  parseAttacks(),
  armed,
);
rogue.connect();

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
    return res.end(JSON.stringify(rogue.state()));
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

let pendingState: ReturnType<RogueCharger['state']> | null = null;
rogue.on('state', (state) => {
  if (!pendingState)
    setTimeout(() => {
      broadcast({ type: 'state', state: pendingState! });
      pendingState = null;
    }, 50);
  pendingState = state;
});
rogue.on('log', (entry) => broadcast({ type: 'log', entry }));
rogue.on('toast', (t) => broadcast({ type: 'toast', ...t }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state: rogue.state() } satisfies ServerToUi));
  ws.send(JSON.stringify({ type: 'logs', entries: rogue.logs } satisfies ServerToUi));
  ws.on('message', (data) => {
    let a: RogueAction;
    try {
      a = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (a.type) {
      case 'arm':
        return rogue.setArmed(a.on);
      case 'toggle':
        return rogue.toggle(a.attack, a.on);
      case 'all':
        return rogue.setAll(a.on);
      case 'intensity':
        return rogue.setIntensity(a.value);
      case 'setTarget':
        return rogue.setTarget(a.csmsUrl);
      case 'connect':
        return rogue.connect();
      case 'disconnect':
        return rogue.disconnect();
      case 'burst':
        return rogue.burst(a.attack);
    }
  });
});

server.listen(PORT, () => {
  console.log(`☠  ROGUE charger GUI on http://localhost:${PORT}`);
  console.log(`   target CSMS: ${rogue.config.csmsUrl}/${rogue.config.chargePointId} (${rogue.config.version}), armed=${rogue.armed}`);
});

const shutdown = () => {
  rogue.shutdown();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
