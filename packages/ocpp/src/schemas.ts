import { z } from 'zod';
import type { OcppVersion } from './framing.ts';

/**
 * Runtime validation of incoming requests. These are trimmed-down versions of
 * the official JSON schemas: they check the fields this simulator relies on.
 * Send a bad payload and you'll get a FormationViolation / FormatViolation
 * CALLERROR back, just like a real implementation would.
 */

const dateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an RFC 3339 date-time');
const int = z.number().int();

// ---------- OCPP 1.6J ----------
const v16ChargingProfile = z.object({
  chargingProfileId: int,
  stackLevel: int.min(0),
  chargingProfilePurpose: z.enum(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
  chargingProfileKind: z.enum(['Absolute', 'Recurring', 'Relative']),
  transactionId: int.optional(),
  chargingSchedule: z.object({
    chargingRateUnit: z.enum(['W', 'A']),
    chargingSchedulePeriod: z.array(z.object({ startPeriod: int, limit: z.number(), numberPhases: int.optional() })).min(1),
    duration: int.optional(),
  }),
});

const v16SampledValue = z.object({ value: z.string(), measurand: z.string().optional(), unit: z.string().optional() });

export const v16 = {
  // Charge point -> Central system
  BootNotification: z.object({
    chargePointVendor: z.string().max(20),
    chargePointModel: z.string().max(20),
    chargePointSerialNumber: z.string().max(25).optional(),
    firmwareVersion: z.string().max(50).optional(),
  }),
  Heartbeat: z.object({}),
  StatusNotification: z.object({
    connectorId: int.min(0),
    errorCode: z.string(),
    status: z.enum(['Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Reserved', 'Unavailable', 'Faulted']),
    timestamp: dateTime.optional(),
    info: z.string().optional(),
  }),
  Authorize: z.object({ idTag: z.string().max(20) }),
  StartTransaction: z.object({
    connectorId: int.min(1),
    idTag: z.string().max(20),
    meterStart: int,
    timestamp: dateTime,
    reservationId: int.optional(),
  }),
  StopTransaction: z.object({
    transactionId: int,
    meterStop: int,
    timestamp: dateTime,
    idTag: z.string().max(20).optional(),
    reason: z.string().optional(),
  }),
  MeterValues: z.object({
    connectorId: int.min(0),
    transactionId: int.optional(),
    meterValue: z.array(z.object({ timestamp: dateTime, sampledValue: z.array(v16SampledValue).min(1) })).min(1),
  }),
  // Central system -> Charge point
  RemoteStartTransaction: z.object({ connectorId: int.min(1).optional(), idTag: z.string().max(20), chargingProfile: v16ChargingProfile.optional() }),
  RemoteStopTransaction: z.object({ transactionId: int }),
  Reset: z.object({ type: z.enum(['Hard', 'Soft']) }),
  UnlockConnector: z.object({ connectorId: int.min(1) }),
  ChangeAvailability: z.object({ connectorId: int.min(0), type: z.enum(['Inoperative', 'Operative']) }),
  SetChargingProfile: z.object({ connectorId: int.min(0), csChargingProfiles: v16ChargingProfile }),
  ClearChargingProfile: z.object({ id: int.optional(), connectorId: int.optional(), chargingProfilePurpose: z.string().optional(), stackLevel: int.optional() }),
  TriggerMessage: z.object({
    requestedMessage: z.enum(['BootNotification', 'DiagnosticsStatusNotification', 'FirmwareStatusNotification', 'Heartbeat', 'MeterValues', 'StatusNotification']),
    connectorId: int.optional(),
  }),
} as const;

// ---------- OCPP 2.0.1 ----------
const idToken = z.object({ idToken: z.string().max(36), type: z.string() });
const evse = z.object({ id: int, connectorId: int.optional() });
const v201SampledValue = z.object({ value: z.number(), measurand: z.string().optional(), unitOfMeasure: z.object({ unit: z.string().optional() }).optional() });
const v201MeterValue = z.object({ timestamp: dateTime, sampledValue: z.array(v201SampledValue).min(1) });
const v201ChargingProfile = z.object({
  id: int,
  stackLevel: int.min(0),
  chargingProfilePurpose: z.enum(['ChargingStationExternalConstraints', 'ChargingStationMaxProfile', 'TxDefaultProfile', 'TxProfile']),
  chargingProfileKind: z.enum(['Absolute', 'Recurring', 'Relative']),
  transactionId: z.string().optional(),
  chargingSchedule: z
    .array(
      z.object({
        id: int,
        chargingRateUnit: z.enum(['W', 'A']),
        chargingSchedulePeriod: z.array(z.object({ startPeriod: int, limit: z.number(), numberPhases: int.optional() })).min(1),
      }),
    )
    .min(1)
    .max(3),
});

export const v201 = {
  // Charging station -> CSMS
  BootNotification: z.object({
    reason: z.enum(['ApplicationReset', 'FirmwareUpdate', 'LocalReset', 'PowerUp', 'RemoteReset', 'ScheduledReset', 'Triggered', 'Unknown', 'Watchdog']),
    chargingStation: z.object({
      model: z.string().max(20),
      vendorName: z.string().max(50),
      serialNumber: z.string().max(25).optional(),
      firmwareVersion: z.string().max(50).optional(),
    }),
  }),
  Heartbeat: z.object({}),
  StatusNotification: z.object({
    timestamp: dateTime,
    connectorStatus: z.enum(['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted']),
    evseId: int,
    connectorId: int,
  }),
  Authorize: z.object({ idToken }),
  TransactionEvent: z.object({
    eventType: z.enum(['Started', 'Updated', 'Ended']),
    timestamp: dateTime,
    triggerReason: z.string(),
    seqNo: int.min(0),
    offline: z.boolean().optional(),
    transactionInfo: z.object({
      transactionId: z.string().max(36),
      chargingState: z.enum(['Charging', 'EVConnected', 'SuspendedEV', 'SuspendedEVSE', 'Idle']).optional(),
      stoppedReason: z.string().optional(),
      remoteStartId: int.optional(),
    }),
    idToken: idToken.optional(),
    evse: evse.optional(),
    meterValue: z.array(v201MeterValue).optional(),
  }),
  MeterValues: z.object({ evseId: int, meterValue: z.array(v201MeterValue).min(1) }),
  // CSMS -> Charging station
  RequestStartTransaction: z.object({ idToken, remoteStartId: int, evseId: int.optional(), chargingProfile: v201ChargingProfile.optional() }),
  RequestStopTransaction: z.object({ transactionId: z.string().max(36) }),
  Reset: z.object({ type: z.enum(['Immediate', 'OnIdle']), evseId: int.optional() }),
  UnlockConnector: z.object({ evseId: int, connectorId: int }),
  ChangeAvailability: z.object({ operationalStatus: z.enum(['Inoperative', 'Operative']), evse: evse.optional() }),
  SetChargingProfile: z.object({ evseId: int.min(0), chargingProfile: v201ChargingProfile }),
  ClearChargingProfile: z.object({
    chargingProfileId: int.optional(),
    chargingProfileCriteria: z.object({ evseId: int.optional(), chargingProfilePurpose: z.string().optional(), stackLevel: int.optional() }).optional(),
  }),
  TriggerMessage: z.object({
    requestedMessage: z.enum(['BootNotification', 'LogStatusNotification', 'FirmwareStatusNotification', 'Heartbeat', 'MeterValues', 'SignChargingStationCertificate', 'SignV2GCertificate', 'StatusNotification', 'TransactionEvent', 'SignCombinedCertificate', 'PublishFirmwareStatusNotification']),
    evse: evse.optional(),
  }),
} as const;

export type V16 = { [K in keyof typeof v16]: z.infer<(typeof v16)[K]> };
export type V201 = { [K in keyof typeof v201]: z.infer<(typeof v201)[K]> };

/** Returns a human readable problem, or null when the payload is OK (or we have no schema for it). */
export function validateRequest(version: OcppVersion, action: string, payload: unknown): string | null {
  const table: Record<string, z.ZodType> = version === 'ocpp1.6' ? v16 : v201;
  const schema = table[action];
  if (!schema) return null;
  const res = schema.safeParse(payload);
  if (res.success) return null;
  return res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}
