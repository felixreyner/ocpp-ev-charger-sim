import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * The unified demo dashboard. It owns no simulation of its own: it serves one
 * GUI and relays that GUI's live sockets to the three existing backends, so a
 * single browser tab can drive the CSMS, the charger and the rogue charger.
 *
 *   browser ── /csms/ui ────▶ CSMS_UI/ui
 *           ── /charger/ui ─▶ CHARGER_UI/ui
 *           ── /rogue/ui ───▶ ROGUE_UI/ui
 */
const PORT = Number(process.env.PORT ?? 8083);
const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');

export const UPSTREAMS = {
  csms: process.env.CSMS_UI ?? 'ws://localhost:8080',
  charger: process.env.CHARGER_UI ?? 'ws://localhost:8081',
  rogue: process.env.ROGUE_UI ?? 'ws://localhost:8082',
} as const;
type Part = keyof typeof UPSTREAMS;

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
  if (url.pathname === '/api/upstreams') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(UPSTREAMS));
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

// ---------- socket relay ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const match = /^\/(csms|charger|rogue)\/ui\/?$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
  if (!match) return socket.destroy();
  const part = match[1] as Part;
  wss.handleUpgrade(req, socket, head, (client) => relay(client, part));
});

function relay(client: WebSocket, part: Part) {
  const upstream = new WebSocket(`${UPSTREAMS[part].replace(/\/+$/, '')}/ui`);
  const queued: string[] = [];
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    client.close();
    upstream.terminate();
  };

  upstream.on('open', () => queued.splice(0).forEach((m) => upstream.send(m)));
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('close', end);
  upstream.on('error', (e) => {
    console.warn(`↯ ${part} backend unreachable at ${UPSTREAMS[part]}: ${e.message}`);
    end();
  });

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push(data.toString());
  });
  client.on('close', end);
  client.on('error', end);
}

server.listen(PORT, () => {
  console.log(`🎬 Unified demo dashboard on http://localhost:${PORT}`);
  for (const [k, v] of Object.entries(UPSTREAMS)) console.log(`   ${k.padEnd(8)}→ ${v}`);
});

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
