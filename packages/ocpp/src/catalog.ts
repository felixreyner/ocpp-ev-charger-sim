import type { OcppVersion } from './framing.ts';

/**
 * Plain-English explanations of every message the simulator uses. The web
 * GUIs show these in the message inspector so you can learn while you click.
 */
export interface ActionInfo {
  /** Who sends the request. */
  from: 'charger' | 'csms';
  versions: OcppVersion[];
  summary: string;
  details: string;
}

const both: OcppVersion[] = ['ocpp1.6', 'ocpp2.0.1'];
const v16: OcppVersion[] = ['ocpp1.6'];
const v201: OcppVersion[] = ['ocpp2.0.1'];

export const ACTIONS: Record<string, ActionInfo> = {
  BootNotification: {
    from: 'charger',
    versions: both,
    summary: 'The charger says hello after it powers up or reconnects.',
    details:
      'Carries vendor, model, serial and firmware. The CSMS answers Accepted, Pending or Rejected plus a heartbeat interval. Until it is Accepted, the charger may not start transactions.',
  },
  Heartbeat: {
    from: 'charger',
    versions: both,
    summary: '"I am still alive." Sent every heartbeat interval.',
    details: 'The response contains the CSMS clock (currentTime), which the charger can use to keep its own clock in sync.',
  },
  StatusNotification: {
    from: 'charger',
    versions: both,
    summary: 'A connector changed state (Available, Charging, Faulted...).',
    details:
      'In 1.6 the status is detailed (Preparing, Charging, SuspendedEV, Finishing...) and connectorId 0 means the whole charge point. In 2.0.1 it is simplified to Available / Occupied / Reserved / Unavailable / Faulted per EVSE + connector; the charging details move into TransactionEvent.',
  },
  Authorize: {
    from: 'charger',
    versions: both,
    summary: 'Someone tapped an RFID card. May they charge?',
    details: '1.6 sends an idTag string; 2.0.1 sends an idToken object with a type (ISO14443 for RFID). The CSMS replies with a status such as Accepted, Blocked, Expired or Invalid.',
  },
  StartTransaction: {
    from: 'charger',
    versions: v16,
    summary: 'Charging session started (1.6).',
    details: 'Includes the connector, idTag and starting meter reading in Wh. The CSMS assigns the transactionId (an integer) in its response.',
  },
  StopTransaction: {
    from: 'charger',
    versions: v16,
    summary: 'Charging session ended (1.6).',
    details: 'Includes the final meter reading and a reason (Local, Remote, EVDisconnected, HardReset...). Energy delivered = meterStop - meterStart.',
  },
  MeterValues: {
    from: 'charger',
    versions: both,
    summary: 'Periodic measurements: energy, power, state of charge.',
    details:
      'In 1.6 values are strings with a measurand (Energy.Active.Import.Register, Power.Active.Import, SoC). In 2.0.1, meter values during a transaction travel inside TransactionEvent(Updated) instead, and values are numbers.',
  },
  TransactionEvent: {
    from: 'charger',
    versions: v201,
    summary: 'All-in-one transaction message (2.0.1): Started, Updated or Ended.',
    details:
      'Replaces StartTransaction, StopTransaction and transaction MeterValues from 1.6. The charger generates the transactionId (a UUID), every event has an increasing seqNo, and triggerReason explains why it was sent (Authorized, CablePluggedIn, MeterValuePeriodic, StopAuthorized, EVCommunicationLost, RemoteStop...).',
  },
  RemoteStartTransaction: {
    from: 'csms',
    versions: v16,
    summary: 'The CSMS asks the charger to start charging (e.g. from a mobile app).',
    details: 'Carries an idTag and optionally a connector. The charger answers Accepted or Rejected, then (if accepted) starts a normal transaction.',
  },
  RemoteStopTransaction: {
    from: 'csms',
    versions: v16,
    summary: 'The CSMS asks the charger to stop a transaction.',
    details: 'The charger answers Accepted and then sends StopTransaction with reason Remote.',
  },
  RequestStartTransaction: {
    from: 'csms',
    versions: v201,
    summary: 'The CSMS asks the charging station to start charging (2.0.1).',
    details: 'Like 1.6 RemoteStartTransaction, but with an idToken object and a remoteStartId that comes back in TransactionEvent so the CSMS can match them up.',
  },
  RequestStopTransaction: {
    from: 'csms',
    versions: v201,
    summary: 'The CSMS asks the charging station to stop a transaction (2.0.1).',
    details: 'Refers to the station-generated transactionId string. The station follows up with TransactionEvent(Ended) with stoppedReason Remote.',
  },
  Reset: {
    from: 'csms',
    versions: both,
    summary: 'Reboot the charger.',
    details: '1.6 has Soft / Hard; 2.0.1 has Immediate / OnIdle. Running transactions are stopped, then the charger reconnects and sends a new BootNotification.',
  },
  UnlockConnector: {
    from: 'csms',
    versions: both,
    summary: 'Release a stuck cable.',
    details: 'Used by support desks when a driver cannot unplug. Any running transaction on that connector is stopped first.',
  },
  ChangeAvailability: {
    from: 'csms',
    versions: both,
    summary: 'Take a connector (or the whole charger) in or out of service.',
    details: 'Inoperative makes the connector Unavailable; Operative brings it back. If a session is running the change is Scheduled for when it ends.',
  },
  SetChargingProfile: {
    from: 'csms',
    versions: both,
    summary: 'Smart charging: limit how much power a connector may deliver.',
    details:
      'A charging profile is a schedule of power (W) or current (A) limits. This simulator uses the first period of the schedule as the live limit, so you can watch the power drop on the charger right away.',
  },
  ClearChargingProfile: {
    from: 'csms',
    versions: both,
    summary: 'Remove charging limits.',
    details: 'The charger goes back to delivering as much power as the car and hardware allow.',
  },
  TriggerMessage: {
    from: 'csms',
    versions: both,
    summary: '"Send me that message now."',
    details: 'The CSMS can ask for a BootNotification, Heartbeat, StatusNotification or MeterValues on demand, which is handy when debugging.',
  },
};

export const describeAction = (action: string): ActionInfo | undefined => ACTIONS[action];
