import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { OcppVersion } from '@sim/ocpp';
import { Central } from '../apps/csms/server/central.ts';
import { Station } from '../apps/charger/server/station.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('timeout');
    await wait(25);
  }
}

let port = 19100;
const cleanups: Array<() => void> = [];
after(() => cleanups.forEach((f) => f()));

for (const version of ['ocpp1.6', 'ocpp2.0.1'] as OcppVersion[]) {
  test(`full charging session over ${version}`, async () => {
    const p = port++;
    const central = new Central(p);
    const station = new Station({
      csmsUrl: `ws://127.0.0.1:${p}/ocpp`,
      chargePointId: `CP-${version}`,
      version,
      vendor: 'Test',
      model: 'T1',
      serial: 'S1',
      firmware: '1',
    });
    cleanups.push(() => station.shutdown(), () => central.close());
    station.setSpeed(120);
    station.connect();

    await until(() => central.chargers.get(`CP-${version}`)?.bootStatus === 'Accepted');
    const charger = central.chargers.get(`CP-${version}`)!;
    assert.equal(charger.version, version);
    await until(() => charger.connectors.length === 2);

    // rejected card
    await station.plug(1, 0);
    await station.tap(1, 'BLOCKED-6666');
    assert.equal(station.state().connectors[0].transaction, null);

    // accepted card starts a session
    await station.tap(1, 'ALICE-0001');
    await until(() => central.transactions.some((t) => !t.stoppedAt));
    await until(() => station.state().connectors[0].status === 'Charging');
    await wait(1500);

    // smart charging limit
    const lim = await central.command(charger.id, { command: 'setLimit', connectorId: 1, limit: 7000, unit: 'W' });
    assert.equal((lim.result as any).status, 'Accepted');
    await wait(1200);
    assert.ok(station.state().connectors[0].powerW <= 7000 * 1.02);

    // remote stop
    const tx = central.transactions.find((t) => !t.stoppedAt)!;
    const stop = await central.command(charger.id, { command: 'remoteStop', transactionId: tx.id });
    assert.equal((stop.result as any).status, 'Accepted');
    await until(() => !!tx.stoppedAt);
    assert.equal(tx.stopReason, 'Remote');
    assert.ok(tx.energyWh > 0, 'energy was delivered');

    // remote start on connector 2, then plug in
    const rs = await central.command(charger.id, { command: 'remoteStart', connectorId: 2, idTag: 'BOB-0002' });
    assert.equal((rs.result as any).status, 'Accepted');
    await wait(100);
    await station.plug(2, 1);
    await until(() => central.transactions.some((t) => !t.stoppedAt && t.connectorId === 2));
    await station.unplug(2);
    await until(() => central.transactions.every((t) => t.stoppedAt));
    assert.equal(central.transactions[0].stopReason, 'EVDisconnected');

    // concurrency and validation errors show up as CALLERROR
    await assert.rejects(central.command(charger.id, { command: 'raw', action: 'Reset', payload: { type: 'Bogus' } }), /Format(ion)?Violation|Violation/);
    await assert.rejects(central.command(charger.id, { command: 'raw', action: 'DataTransfer', payload: { vendorId: 'x' } }), /NotImplemented/);

    // no CALLERRORs from the charger's own messages
    const bad = central.logs.filter((l) => l.kind === 'CALLERROR' && l.dir === 'out');
    assert.deepEqual(bad.map((b) => `${b.action}: ${b.errorDescription}`), []);
  });
}
