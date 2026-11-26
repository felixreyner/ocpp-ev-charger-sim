/**
 * Checks the WAF specs in specs/ against the real code:
 *  - the generated files are up to date and valid OpenAPI,
 *  - they cover exactly the actions the CSMS and charger implement,
 *  - every frame the real charger and CSMS exchange passes,
 *  - frames from the rogue charger's attack modes are rejected (where a schema can tell).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { v16, v201, type LogEntry, type OcppVersion } from '@sim/ocpp';
import { Central } from '../apps/csms/server/central.ts';
import { Station } from '../apps/charger/server/station.ts';
import { RogueCharger } from '../apps/rogue/server/rogue.ts';
import { ATTACKS, HANDSHAKE_ATTACK_IDS, type AttackFlags, type AttackId } from '../apps/rogue/server/types.ts';
import {
  HANDSHAKE_CASES,
  buildHandshakeRequest,
  sendHandshakeProbe,
  type HandshakeCase,
  type HandshakeProbeResult,
  type HandshakeRequest,
  type HandshakeTarget,
} from '../apps/rogue/server/handshake.ts';
import { outputs, inboundFrameSchema, namedSchemas } from '../specs/src/build.ts';
import { MAX_MESSAGE_BYTES, VERSIONS } from '../specs/src/schemas.ts';

const SPECS = new URL('../specs/', import.meta.url);
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(25);
  }
}

const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((f) => f()));
let port = 19300;

function makeAjv() {
  const ajv = new Ajv2020({ allErrors: false, strict: true, strictTuples: false });
  addFormats(ajv);
  return ajv;
}

/** Validator for a whole raw WebSocket message from a charger, the way a WAF/validator would see it. */
function frameValidator(version: OcppVersion) {
  const validate = makeAjv().compile(inboundFrameSchema(version));
  return (raw: string): boolean => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
    return validate(data) as boolean;
  };
}

/** Validators for each named payload schema, e.g. V16_Reset_Request. */
function payloadValidators() {
  const ajv = makeAjv();
  const defs = namedSchemas();
  ajv.addSchema({ $id: 'defs', $defs: JSON.parse(JSON.stringify(defs).replaceAll('#/components/schemas/', 'defs#/$defs/')) });
  return (name: string, payload: unknown) => {
    const v = ajv.getSchema(`defs#/$defs/${name}`);
    assert.ok(v, `no schema ${name}`);
    return v(payload) ? null : JSON.stringify(v.errors?.slice(0, 3));
  };
}

test('generated spec files are up to date', async () => {
  for (const [rel, content] of Object.entries(outputs())) {
    const current = await readFile(new URL(rel, SPECS), 'utf8');
    assert.equal(current, content, `specs/${rel} is stale: run npm run specs`);
  }
});

test('OpenAPI files are valid OpenAPI 3.0', async () => {
  for (const f of ['openapi/ocpp-csms-gateway.openapi.yaml', 'openapi/ocpp-messages.openapi.yaml']) {
    await SwaggerParser.validate(new URL(f, SPECS).pathname);
  }
});

test('specs cover exactly the actions the code implements', () => {
  const both = (v: keyof typeof VERSIONS) => [...Object.keys(VERSIONS[v].fromCharger), ...Object.keys(VERSIONS[v].fromCsms)].sort();
  assert.deepEqual(both('ocpp1.6'), Object.keys(v16).sort());
  assert.deepEqual(both('ocpp2.0.1'), Object.keys(v201).sort());
});

for (const version of ['ocpp1.6', 'ocpp2.0.1'] as OcppVersion[]) {
  test(`every frame of a real charging session passes (${version})`, async () => {
    const p = port++;
    const central = new Central(p);
    const id = `CP-SPEC-${version}`;
    const station = new Station({ csmsUrl: `ws://127.0.0.1:${p}/ocpp`, chargePointId: id, version, vendor: 'VoltForge', model: 'VF-DC150', serial: 'VF-0001', firmware: '1.0.0' });
    cleanups.push(() => station.shutdown(), () => central.close());
    const logs: LogEntry[] = [];
    central.on('log', (e: LogEntry) => logs.push(e));
    station.setSpeed(120);
    station.connect();
    await until(() => central.chargers.get(id)?.bootStatus === 'Accepted');
    await until(() => central.chargers.get(id)!.connectors.length === 2);
    const cmd = (c: Parameters<Central['command']>[1]) => central.command(id, c);

    await station.plug(1, 0);
    await station.tap(1, 'BLOCKED-6666');
    await station.tap(1, 'ALICE-0001');
    await until(() => central.transactions.some((t) => !t.stoppedAt));
    await wait(1200);
    await cmd({ command: 'setLimit', connectorId: 1, limit: 7000, unit: 'W' });
    await cmd({ command: 'trigger', message: 'MeterValues', connectorId: 1 });
    await cmd({ command: 'trigger', message: 'StatusNotification' });
    await cmd({ command: 'trigger', message: 'Heartbeat' });
    await cmd({ command: 'availability', connectorId: 2, operative: false });
    await cmd({ command: 'availability', connectorId: 2, operative: true });
    await cmd({ command: 'clearLimit', connectorId: 1 });
    await wait(600);
    const tx = central.transactions.find((t) => !t.stoppedAt)!;
    await cmd({ command: 'remoteStop', transactionId: tx.id });
    await until(() => !!tx.stoppedAt);
    await cmd({ command: 'remoteStart', connectorId: 2, idTag: 'BOB-0002' });
    await wait(100);
    await station.plug(2, 1);
    await until(() => central.transactions.some((t) => !t.stoppedAt && t.connectorId === 2));
    await wait(600);
    await station.unplug(2);
    await until(() => central.transactions.every((t) => t.stoppedAt));
    await cmd({ command: 'unlock', connectorId: 1 });
    await cmd({ command: 'reset', type: version === 'ocpp1.6' ? 'Soft' : 'Immediate' });
    // The charger reconnects ~5 s after a reset and boots again.
    await until(() => logs.filter((l) => l.action === 'BootNotification' && l.dir === 'in').length >= 2, 12_000);
    await wait(300);

    const tag = VERSIONS[version].tag;
    const okFrame = frameValidator(version);
    const check = payloadValidators();
    const inbound = logs.filter((l) => l.dir === 'in');
    const kinds = new Set(inbound.map((l) => `${l.kind}:${l.action}`));
    assert.ok(inbound.length > 30, `expected plenty of traffic, got ${inbound.length}`);
    for (const k of ['CALL:BootNotification', 'CALL:MeterValues', 'CALL:StatusNotification', 'CALLRESULT:SetChargingProfile']) {
      if (version === 'ocpp2.0.1' && k === 'CALL:MeterValues') continue;
      assert.ok(kinds.has(k), `scenario should include ${k}`);
    }

    const rejected = inbound.filter((l) => !okFrame(l.raw)).map((l) => l.raw);
    assert.deepEqual(rejected, [], 'legitimate charger frames must pass the inbound frame schema');
    const biggest = Math.max(...inbound.map((l) => Buffer.byteLength(l.raw)));
    assert.ok(biggest <= MAX_MESSAGE_BYTES, `largest legit frame is ${biggest} bytes`);

    // What the CSMS sends must match the documented responses and commands too.
    for (const l of logs.filter((x) => x.dir === 'out')) {
      if (l.kind === 'CALL') assert.equal(check(`${tag}_${l.action}_Request`, l.payload), null, `CSMS command ${l.action}`);
      if (l.kind === 'CALLRESULT') assert.equal(check(`${tag}_${l.action}_Response`, l.payload), null, `CSMS response to ${l.action}`);
      assert.notEqual(l.kind, 'CALLERROR', `CSMS rejected a legit frame: ${l.errorDescription}`);
    }
  });
}

/**
 * Fires each rogue attack mode many times from the real RogueCharger and
 * counts how many of its frames the inbound schema rejects.
 */
for (const version of ['ocpp1.6', 'ocpp2.0.1'] as OcppVersion[]) {
  test(`rogue attack frames are rejected by the schema (${version})`, async () => {
    const p = port++;
    const central = new Central(p);
    const flags = Object.fromEntries(ATTACKS.map((a) => [a.id, false])) as AttackFlags;
    const rogue = new RogueCharger({ csmsUrl: `ws://127.0.0.1:${p}/ocpp`, chargePointId: 'ROGUE-666', version, intensity: 1 }, flags, false);
    cleanups.push(() => rogue.shutdown(), () => central.close());
    // Capture what actually arrives at the CSMS (full raw text, unlike the rogue's truncated GUI log).
    let sent: string[] = [];
    central.on('log', (e: LogEntry) => e.dir === 'in' && e.peer === 'ROGUE-666' && sent.push(e.raw));
    rogue.connect();
    await until(() => rogue.state().connection.state === 'connected');
    await wait(200);

    const okFrame = frameValidator(version);
    // The boot the rogue sends is shaped correctly; a schema cannot tell it apart.
    assert.ok(sent.length > 0 && sent.every(okFrame));

    const capture = async (attack: AttackId): Promise<string[]> => {
      sent = [];
      for (let i = 0; i < 60; i++) rogue.burst(attack);
      await until(() => sent.length >= 60);
      await wait(150);
      return sent.slice();
    };

    const blockedShare: Partial<Record<AttackId, number>> = {};
    const sizes: Partial<Record<AttackId, number[]>> = {};
    for (const attack of ['oversized', 'flood'] as AttackId[]) {
      const frames = await capture(attack);
      blockedShare[attack] = frames.filter((raw) => !okFrame(raw)).length / frames.length;
      sizes[attack] = frames.map((raw) => Buffer.byteLength(raw));
    }

    // Oversized frames are also far over the 16 KB WebSocket frame/message cap a WAF
    // enforces on the wire (no schema needed), and the schema rejects them too.
    assert.equal(blockedShare.oversized, 1, `oversized: ${blockedShare.oversized}`);
    assert.ok(sizes.oversized!.every((n) => n > MAX_MESSAGE_BYTES), 'every oversized frame busts the WS size cap');
    // Floods are valid Heartbeats/StatusNotifications: only rate limiting stops them. (In 2.0.1 mode the
    // rogue sends 1.6-shaped StatusNotifications, so that half of the flood is rejected by the schema.)
    if (version === 'ocpp1.6') assert.equal(blockedShare.flood, 0);
    else assert.ok(blockedShare.flood! > 0 && blockedShare.flood! < 1, `flood: ${blockedShare.flood}`);
  });
}

/**
 * The injection modes send structurally-valid OCPP frames whose string fields
 * carry a SQLi / XSS / path-traversal payload. A WAF stops these in two ways and
 * this test checks both: the hardened field patterns/lengths in specs/ reject
 * the long or space-bearing payloads (schema layer), and every frame carries a
 * recognizable attack signature that a signature engine (FortiWeb's, or any WAF
 * with SQLi/XSS/traversal signatures) catches regardless of schema.
 */
const SIGNATURES: Record<'sqlInjection' | 'xssPayload' | 'pathTraversal', RegExp> = {
  sqlInjection: /('|union\s+select|drop\s+table|pg_sleep|waitfor\s+delay|or\s+'?1'?='?1|--)/i,
  xssPayload: /(<script|<svg|<img|onerror=|onload=|javascript:)/i,
  pathTraversal: /(\.\.\/|\.\.\\|%2e%2e|%2f|\.\.%2f|\.\.\.\.\/\/)/i,
};

for (const version of ['ocpp1.6', 'ocpp2.0.1'] as OcppVersion[]) {
  test(`rogue injection frames carry a WAF-detectable signature (${version})`, async () => {
    const p = port++;
    const central = new Central(p);
    const flags = Object.fromEntries(ATTACKS.map((a) => [a.id, false])) as AttackFlags;
    const rogue = new RogueCharger({ csmsUrl: `ws://127.0.0.1:${p}/ocpp`, chargePointId: 'ROGUE-666', version, intensity: 1 }, flags, false);
    cleanups.push(() => rogue.shutdown(), () => central.close());
    let sent: string[] = [];
    central.on('log', (e: LogEntry) => e.dir === 'in' && e.peer === 'ROGUE-666' && sent.push(e.raw));
    rogue.connect();
    await until(() => rogue.state().connection.state === 'connected');
    await wait(200);

    const okFrame = frameValidator(version);

    for (const attack of ['sqlInjection', 'xssPayload', 'pathTraversal'] as const) {
      sent = [];
      for (let i = 0; i < 60; i++) rogue.burst(attack);
      await until(() => sent.length >= 60);
      await wait(150);
      // Only the rogue's own CALLs (the injection probes), not any reply frame.
      const frames = sent.filter((raw) => {
        try {
          return (JSON.parse(raw) as unknown[])[0] === 2;
        } catch {
          return true;
        }
      });
      assert.ok(frames.length >= 50, `${attack}: expected probes, got ${frames.length}`);

      // Every injection frame is content a signature engine can match on.
      const sig = SIGNATURES[attack];
      assert.ok(
        frames.every((raw) => sig.test(raw)),
        `${attack}: every frame should carry a detectable signature`,
      );
      // The schema layer alone catches the long / space-bearing payloads, but not
      // the short pattern-legal ones — those need the signature engine. So the
      // schema rejects some but never all of them.
      const blocked = frames.filter((raw) => !okFrame(raw)).length / frames.length;
      assert.ok(blocked < 1, `${attack}: schema alone should not catch every payload (got ${blocked})`);
    }
  });
}

/**
 * Handshake-abuse modes. These break the gateway contract in
 * `ocpp-csms-gateway.openapi.yaml` at the HTTP upgrade — the one layer FortiWeb's
 * OpenAPI validation actually sees. We build a validator straight from the
 * gateway spec (the same rules a WAF enforces) and check that every handshake
 * case is rejected, while a conforming handshake is accepted.
 */
type GatewayCheck = (req: HandshakeRequest) => string | null;

async function makeGatewayValidator(): Promise<GatewayCheck> {
  const spec = (await SwaggerParser.parse(new URL('openapi/ocpp-csms-gateway.openapi.yaml', SPECS).pathname)) as {
    paths: Record<string, { get?: { parameters: Array<{ in: string; name: string; required?: boolean; schema: object }> } }>;
  };
  const op = spec.paths['/ocpp/{chargePointId}'].get!;
  const ajv = makeAjv();
  let idCheck: (v: unknown) => boolean = () => true;
  const headerChecks: Array<{ name: string; required: boolean; check: (v: unknown) => boolean }> = [];
  for (const pr of op.parameters) {
    if (pr.in === 'path' && pr.name === 'chargePointId') idCheck = ajv.compile(pr.schema) as (v: unknown) => boolean;
    if (pr.in === 'header') headerChecks.push({ name: pr.name.toLowerCase(), required: !!pr.required, check: ajv.compile(pr.schema) as (v: unknown) => boolean });
  }
  return (req) => {
    if (req.method !== 'GET') return `method ${req.method}`;
    const segs = req.pathname.split('/').filter(Boolean);
    if (segs.length !== 2 || segs[0] !== 'ocpp') return `path ${req.pathname}`;
    if (!idCheck(segs[1])) return `id ${segs[1]}`;
    if (req.query && req.query.length) return `query ${req.query}`;
    if (req.body && req.body.length) return 'body';
    const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const hc of headerChecks) {
      const val = h[hc.name];
      if (val === undefined) {
        if (hc.required) return `missing header ${hc.name}`;
        continue;
      }
      if (!hc.check(val)) return `header ${hc.name}=${val}`;
    }
    return null;
  };
}

const probe = (target: HandshakeTarget, kase: HandshakeCase) =>
  new Promise<HandshakeProbeResult>((resolve) => sendHandshakeProbe(target, kase, resolve, 3000));

test('every handshake-abuse case is rejected by the gateway OpenAPI contract', async () => {
  const rejects = await makeGatewayValidator();
  const target: HandshakeTarget = { csmsUrl: 'ws://localhost:9000/ocpp', chargePointId: 'CP-001', version: 'ocpp1.6' };

  // Sanity: a conforming handshake passes the same validator.
  const ok = buildHandshakeRequest(target, { variant: 'conforming', why: '' });
  assert.equal(rejects(ok), null, 'a conforming handshake must pass the gateway contract');

  // Every mode, every variant, must break at least one documented rule.
  assert.deepEqual([...HANDSHAKE_ATTACK_IDS].sort(), Object.keys(HANDSHAKE_CASES).sort());
  for (const id of HANDSHAKE_ATTACK_IDS) {
    const cases = HANDSHAKE_CASES[id];
    assert.ok(cases.length >= 3, `${id}: expected several variants`);
    for (const kase of cases) {
      const req = buildHandshakeRequest(target, kase);
      const reason = rejects(req);
      assert.ok(reason, `${id}/${kase.variant} (${req.requestLine}) should be rejected by the gateway`);
    }
  }
});

test('handshake probes reach the CSMS — showing the WAF gap the gateway spec closes', async () => {
  const rejects = await makeGatewayValidator();
  const p = port++;
  const central = new Central(p);
  cleanups.push(() => central.close());
  const target: HandshakeTarget = { csmsUrl: `ws://127.0.0.1:${p}/ocpp`, chargePointId: 'CP-001', version: 'ocpp1.6' };

  // A conforming upgrade is accepted (101) by the permissive CSMS with no WAF in front.
  const good = await probe(target, { variant: 'conforming', why: '' });
  assert.equal(good.accepted, true, `conforming handshake should connect, got ${good.status ?? good.error}`);

  // Every abusive handshake actually reaches the CSMS and gets a response, and the
  // gateway contract (what FortiWeb enforces) would reject it — the whole point of
  // the mode: without the WAF the bare CSMS lets these through.
  for (const id of HANDSHAKE_ATTACK_IDS) {
    const kase = HANDSHAKE_CASES[id][0];
    const res = await probe(target, kase);
    assert.ok(res.status != null || res.error, `${id}/${kase.variant} should get a response or error`);
    assert.ok(rejects(buildHandshakeRequest(target, kase)), `${id}/${kase.variant} must be rejected by the gateway contract`);
  }
});

test('RogueCharger fires handshake probes and counts them in telemetry', async () => {
  const p = port++;
  const central = new Central(p);
  const flags = Object.fromEntries(ATTACKS.map((a) => [a.id, false])) as AttackFlags;
  const rogue = new RogueCharger({ csmsUrl: `ws://127.0.0.1:${p}/ocpp`, chargePointId: 'CP-001', version: 'ocpp1.6', intensity: 1 }, flags, false);
  cleanups.push(() => rogue.shutdown(), () => central.close());
  rogue.connect();
  await until(() => rogue.state().connection.state === 'connected');

  const before = rogue.state().stats.handshakeProbes;
  for (const id of HANDSHAKE_ATTACK_IDS) for (let i = 0; i < 4; i++) rogue.burst(id);
  const expected = before + HANDSHAKE_ATTACK_IDS.length * 4;
  await until(() => rogue.state().stats.handshakeProbes >= expected, 8000);

  const stats = rogue.state().stats;
  assert.ok(stats.handshakeProbes >= expected, `handshake probes counted: ${stats.handshakeProbes}`);
  for (const id of HANDSHAKE_ATTACK_IDS) assert.ok(stats.attacksFired[id] >= 4, `${id} fired`);
});
