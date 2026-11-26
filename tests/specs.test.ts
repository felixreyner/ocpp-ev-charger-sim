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
import { ATTACKS, type AttackFlags, type AttackId } from '../apps/rogue/server/types.ts';
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

    const blockedShare: Partial<Record<AttackId, number>> = {};
    for (const attack of ['malformed', 'bogusMeter', 'oversized', 'wrongType', 'replay', 'invalidTx', 'flood'] as AttackId[]) {
      sent = [];
      for (let i = 0; i < 60; i++) rogue.burst(attack);
      await until(() => sent.length >= 60);
      await wait(150);
      blockedShare[attack] = sent.filter((raw) => !okFrame(raw)).length / sent.length;
    }

    // Fully caught by the schema.
    for (const a of ['malformed', 'bogusMeter', 'oversized', 'wrongType'] as AttackId[]) assert.equal(blockedShare[a], 1, `${a}: ${blockedShare[a]}`);
    // Partly caught: unsolicited CALLRESULTs and negative/zero ids are; reused ids and unknown-but-valid ids need state.
    assert.ok(blockedShare.replay! > 0 && blockedShare.replay! < 1, `replay: ${blockedShare.replay}`);
    if (version === 'ocpp1.6') assert.ok(blockedShare.invalidTx! > 0 && blockedShare.invalidTx! < 1, `invalidTx: ${blockedShare.invalidTx}`);
    else assert.equal(blockedShare.invalidTx, 0, 'phantom 2.0.1 transaction ids are well-formed strings');
    // Floods are valid Heartbeats/StatusNotifications: only rate limiting stops them. (In 2.0.1 mode the
    // rogue sends 1.6-shaped StatusNotifications, so that half of the flood is rejected by the schema.)
    if (version === 'ocpp1.6') assert.equal(blockedShare.flood, 0);
    else assert.ok(blockedShare.flood! > 0 && blockedShare.flood! < 1, `flood: ${blockedShare.flood}`);
  });
}
