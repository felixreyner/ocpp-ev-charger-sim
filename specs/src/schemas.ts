/**
 * Hardened ("WAF profile") JSON Schemas for every OCPP message this simulator's
 * CSMS accepts or sends.
 *
 * Source of truth for the generated files in specs/openapi and specs/json-schema.
 * Run `npm run specs` after editing, and `npm test` checks the output is in sync.
 *
 * How these relate to packages/ocpp/src/schemas.ts (the zod schemas the CSMS
 * really validates with):
 *  - Every action and every field the CSMS reads is here, with the same types,
 *    required fields and enums.
 *  - Optional fields from the official OCPP 1.6J / 2.0.1 schemas are allowed too
 *    (e.g. sampledValue.context, StatusNotification.vendorErrorCode), so a real
 *    charger is not blocked for sending them.
 *  - Then it is tightened for an edge filter: additionalProperties:false on every
 *    object, maxLength/pattern on every string, min/max on every number, maxItems
 *    on every array, official enums instead of free strings, and plausible ranges
 *    for meter readings.
 *
 * Everything here stays inside the subset that both OpenAPI 3.0.3 and JSON
 * Schema 2020-12 understand (no `const`, no type arrays, no `nullable`), so the
 * same objects are emitted into both formats.
 */

export type Schema = Record<string, unknown>;

/** Reference to another named schema. Rewritten to #/$defs/... for JSON Schema output. */
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

// ------------------------------------------------------------------ primitives

const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
  ...extra,
});

const str = (maxLength: number, extra: Schema = {}): Schema => ({ type: 'string', minLength: 0, maxLength, ...extra });
const enumOf = (values: string[], description?: string): Schema => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const int = (minimum: number, maximum: number, description?: string): Schema => ({
  type: 'integer',
  minimum,
  maximum,
  ...(description ? { description } : {}),
});
const arr = (items: Schema, minItems: number, maxItems: number): Schema => ({ type: 'array', items, minItems, maxItems });

/** Signed 32-bit max, what OCPP uses for "integer" ids. */
const INT32 = 2_147_483_647;
/** Highest connector / EVSE number accepted. Real stations have a handful; raise if yours has more. */
const MAX_CONNECTOR = 100;
/**
 * Ceiling for energy registers and power readings: 999,999,999 (just under
 * 1 GWh / 1 GW). A lifetime register on a busy DC charger stays well below it;
 * the rogue node's 1e9, 9.99e14 and 2^53 readings do not.
 */
const MAX_READING = 999_999_999;

const dateTime: Schema = {
  type: 'string',
  format: 'date-time',
  maxLength: 35,
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$',
  description: 'RFC 3339 date-time, e.g. 2026-01-31T12:00:00.000Z',
};

/** Printable ASCII without spaces. Used for identifiers the CSMS looks up. */
const token = (maxLength: number, description: string): Schema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  pattern: `^[\\x21-\\x7E]{1,${maxLength}}$`,
  description,
});

const freeText = (maxLength: number): Schema => ({
  type: 'string',
  maxLength,
  // No control characters (blocks NUL/CR/LF smuggling inside text fields).
  pattern: '^[^\\x00-\\x1F\\x7F]*$',
});

// ------------------------------------------------------------------ shared enums

const MEASURANDS_UNSIGNED = [
  'Current.Export',
  'Current.Import',
  'Current.Offered',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'RPM',
  'Voltage',
];
const MEASURANDS_UNSIGNED_201 = [
  ...MEASURANDS_UNSIGNED.filter((m) => m !== 'RPM'),
  'Energy.Active.Net',
  'Energy.Reactive.Net',
  'Energy.Apparent.Net',
  'Energy.Apparent.Import',
  'Energy.Apparent.Export',
];
/** Measurands that can legitimately go negative. */
const MEASURANDS_SIGNED = ['Power.Factor', 'Temperature'];
const MEASURANDS_SIGNED_201 = ['Power.Factor'];

const READING_CONTEXT = [
  'Interruption.Begin',
  'Interruption.End',
  'Other',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
];
const PHASES = ['L1', 'L2', 'L3', 'N', 'L1-N', 'L2-N', 'L3-N', 'L1-L2', 'L2-L3', 'L3-L1'];
const LOCATIONS = ['Body', 'Cable', 'EV', 'Inlet', 'Outlet'];
const V16_UNITS = ['Wh', 'kWh', 'varh', 'kvarh', 'W', 'kW', 'VA', 'kVA', 'var', 'kvar', 'A', 'V', 'K', 'Celcius', 'Celsius', 'Fahrenheit', 'Percent'];

const V16_AUTH_STATUS = ['Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'];
const V201_AUTH_STATUS = ['Accepted', 'Blocked', 'ConcurrentTx', 'Expired', 'Invalid', 'NoCredit', 'NotAllowedTypeEVSE', 'NotAtThisLocation', 'NotAtThisTime', 'Unknown'];

// Strings for meter readings in 1.6, where `value` is a decimal string.
const DEC_UNSIGNED = '^[0-9]{1,9}(\\.[0-9]{1,6})?$';
const DEC_PERCENT = '^(100(\\.0{1,6})?|[0-9]{1,2}(\\.[0-9]{1,6})?)$';
const DEC_SIGNED = '^-?[0-9]{1,7}(\\.[0-9]{1,6})?$';

/**
 * A sampled value is one of three shapes, picked by measurand:
 *  - energy / power / current / voltage (or no measurand, which means
 *    Energy.Active.Import.Register): 0 .. 999,999,999
 *  - SoC: 0 .. 100
 *  - Power.Factor / Temperature: signed, small
 * This is how negative or absurd energy readings get rejected.
 */
function sampledValueVariants(version: '1.6' | '2.0.1'): Schema {
  const v16 = version === '1.6';
  const common: Record<string, Schema> = v16
    ? {
        context: enumOf(READING_CONTEXT),
        format: enumOf(['Raw', 'SignedData']),
        phase: enumOf(PHASES),
        location: enumOf(LOCATIONS),
        unit: enumOf(V16_UNITS),
      }
    : {
        context: enumOf(READING_CONTEXT),
        phase: enumOf(PHASES),
        location: enumOf(LOCATIONS),
        unitOfMeasure: obj({ unit: token(20, 'Unit of measure, e.g. Wh, W, Percent'), multiplier: int(-3, 3) }),
      };
  const value = (pattern: string, min: number, max: number): Schema =>
    v16 ? { type: 'string', maxLength: 20, pattern, description: 'Decimal number as a string' } : { type: 'number', minimum: min, maximum: max };

  const unsigned = obj(
    { value: value(DEC_UNSIGNED, 0, MAX_READING), measurand: enumOf(v16 ? MEASURANDS_UNSIGNED : MEASURANDS_UNSIGNED_201), ...common },
    ['value'],
    { title: 'Energy, power, current or voltage reading (non-negative)' },
  );
  const soc = obj({ value: value(DEC_PERCENT, 0, 100), measurand: enumOf(['SoC']), ...common }, ['value', 'measurand'], {
    title: 'State of charge in percent (0-100)',
  });
  const signed = obj(
    { value: value(DEC_SIGNED, -9_999_999, 9_999_999), measurand: enumOf(v16 ? MEASURANDS_SIGNED : MEASURANDS_SIGNED_201), ...common },
    ['value', 'measurand'],
    { title: 'Signed reading (power factor, temperature)' },
  );
  return { oneOf: [unsigned, soc, signed] };
}

// ------------------------------------------------------------------ OCPP 1.6J

const v16ChargingProfile = obj(
  {
    chargingProfileId: int(0, INT32),
    transactionId: int(1, INT32),
    stackLevel: int(0, 100),
    chargingProfilePurpose: enumOf(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
    chargingProfileKind: enumOf(['Absolute', 'Recurring', 'Relative']),
    recurrencyKind: enumOf(['Daily', 'Weekly']),
    validFrom: dateTime,
    validTo: dateTime,
    chargingSchedule: obj(
      {
        duration: int(0, INT32),
        startSchedule: dateTime,
        chargingRateUnit: enumOf(['W', 'A']),
        chargingSchedulePeriod: arr(
          obj({ startPeriod: int(0, INT32), limit: { type: 'number', minimum: 0, maximum: 10_000_000 }, numberPhases: int(1, 3) }, ['startPeriod', 'limit']),
          1,
          48,
        ),
        minChargingRate: { type: 'number', minimum: 0, maximum: 10_000_000 },
      },
      ['chargingRateUnit', 'chargingSchedulePeriod'],
    ),
  },
  ['chargingProfileId', 'stackLevel', 'chargingProfilePurpose', 'chargingProfileKind', 'chargingSchedule'],
);

const v16IdTag = token(20, 'RFID card / token id (CiString20)');
const v16IdTagInfo = obj({ status: enumOf(V16_AUTH_STATUS), expiryDate: dateTime, parentIdTag: v16IdTag }, ['status']);
const v16MeterValue = obj({ timestamp: dateTime, sampledValue: arr(ref('V16_SampledValue'), 1, 30) }, ['timestamp', 'sampledValue']);

/** Messages a charge point sends to the CSMS (the traffic a WAF in front of the CSMS inspects). */
export const V16_CHARGER_TO_CSMS: Record<string, { request: Schema; response: Schema }> = {
  BootNotification: {
    request: obj(
      {
        chargePointVendor: str(20, { minLength: 1, pattern: '^[^\\x00-\\x1F\\x7F]{1,20}$' }),
        chargePointModel: str(20, { minLength: 1, pattern: '^[^\\x00-\\x1F\\x7F]{1,20}$' }),
        chargePointSerialNumber: freeText(25),
        chargeBoxSerialNumber: freeText(25),
        firmwareVersion: freeText(50),
        iccid: freeText(20),
        imsi: freeText(20),
        meterType: freeText(25),
        meterSerialNumber: freeText(25),
      },
      ['chargePointVendor', 'chargePointModel'],
    ),
    response: obj({ status: enumOf(['Accepted', 'Pending', 'Rejected']), currentTime: dateTime, interval: int(0, 86_400) }, ['status', 'currentTime', 'interval']),
  },
  Heartbeat: {
    request: obj({}, [], { maxProperties: 0 }),
    response: obj({ currentTime: dateTime }, ['currentTime']),
  },
  StatusNotification: {
    request: obj(
      {
        connectorId: int(0, MAX_CONNECTOR, '0 = the whole charge point'),
        errorCode: enumOf([
          'ConnectorLockFailure',
          'EVCommunicationError',
          'GroundFailure',
          'HighTemperature',
          'InternalError',
          'LocalListConflict',
          'NoError',
          'OtherError',
          'OverCurrentFailure',
          'PowerMeterFailure',
          'PowerSwitchFailure',
          'ReaderFailure',
          'ResetFailure',
          'UnderVoltage',
          'OverVoltage',
          'WeakSignal',
        ]),
        status: enumOf(['Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Reserved', 'Unavailable', 'Faulted']),
        timestamp: dateTime,
        info: freeText(50),
        vendorId: freeText(255),
        vendorErrorCode: freeText(50),
      },
      ['connectorId', 'errorCode', 'status'],
    ),
    response: obj({}, [], { maxProperties: 0 }),
  },
  Authorize: {
    request: obj({ idTag: v16IdTag }, ['idTag']),
    response: obj({ idTagInfo: v16IdTagInfo }, ['idTagInfo']),
  },
  StartTransaction: {
    request: obj(
      {
        connectorId: int(1, MAX_CONNECTOR),
        idTag: v16IdTag,
        meterStart: int(0, MAX_READING, 'Meter register at start, in Wh'),
        timestamp: dateTime,
        reservationId: int(0, INT32),
      },
      ['connectorId', 'idTag', 'meterStart', 'timestamp'],
    ),
    response: obj({ transactionId: int(1, INT32), idTagInfo: v16IdTagInfo }, ['transactionId', 'idTagInfo']),
  },
  StopTransaction: {
    request: obj(
      {
        transactionId: int(1, INT32, 'Must be a positive id the CSMS issued in StartTransaction.conf'),
        meterStop: int(0, MAX_READING, 'Meter register at stop, in Wh'),
        timestamp: dateTime,
        idTag: v16IdTag,
        reason: enumOf(['EmergencyStop', 'EVDisconnected', 'HardReset', 'Local', 'Other', 'PowerLoss', 'Reboot', 'Remote', 'SoftReset', 'UnlockCommand', 'DeAuthorized']),
        transactionData: arr(v16MeterValue, 0, 50),
      },
      ['transactionId', 'meterStop', 'timestamp'],
    ),
    response: obj({ idTagInfo: v16IdTagInfo }),
  },
  MeterValues: {
    request: obj(
      { connectorId: int(0, MAX_CONNECTOR), transactionId: int(1, INT32), meterValue: arr(v16MeterValue, 1, 20) },
      ['connectorId', 'meterValue'],
    ),
    response: obj({}, [], { maxProperties: 0 }),
  },
};

const v16Status = (values: string[]) => obj({ status: enumOf(values) }, ['status']);

/** Commands the CSMS sends to a charge point, and the CALLRESULT the charge point answers with. */
export const V16_CSMS_TO_CHARGER: Record<string, { request: Schema; response: Schema }> = {
  RemoteStartTransaction: {
    request: obj({ connectorId: int(1, MAX_CONNECTOR), idTag: v16IdTag, chargingProfile: v16ChargingProfile }, ['idTag']),
    response: v16Status(['Accepted', 'Rejected']),
  },
  RemoteStopTransaction: {
    request: obj({ transactionId: int(1, INT32) }, ['transactionId']),
    response: v16Status(['Accepted', 'Rejected']),
  },
  Reset: { request: obj({ type: enumOf(['Hard', 'Soft']) }, ['type']), response: v16Status(['Accepted', 'Rejected']) },
  UnlockConnector: {
    request: obj({ connectorId: int(1, MAX_CONNECTOR) }, ['connectorId']),
    response: v16Status(['Unlocked', 'UnlockFailed', 'NotSupported']),
  },
  ChangeAvailability: {
    request: obj({ connectorId: int(0, MAX_CONNECTOR), type: enumOf(['Inoperative', 'Operative']) }, ['connectorId', 'type']),
    response: v16Status(['Accepted', 'Rejected', 'Scheduled']),
  },
  SetChargingProfile: {
    request: obj({ connectorId: int(0, MAX_CONNECTOR), csChargingProfiles: v16ChargingProfile }, ['connectorId', 'csChargingProfiles']),
    response: v16Status(['Accepted', 'Rejected', 'NotSupported']),
  },
  ClearChargingProfile: {
    request: obj({
      id: int(0, INT32),
      connectorId: int(0, MAX_CONNECTOR),
      chargingProfilePurpose: enumOf(['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile']),
      stackLevel: int(0, 100),
    }),
    response: v16Status(['Accepted', 'Unknown']),
  },
  TriggerMessage: {
    request: obj(
      {
        requestedMessage: enumOf(['BootNotification', 'DiagnosticsStatusNotification', 'FirmwareStatusNotification', 'Heartbeat', 'MeterValues', 'StatusNotification']),
        connectorId: int(0, MAX_CONNECTOR),
      },
      ['requestedMessage'],
    ),
    response: v16Status(['Accepted', 'Rejected', 'NotImplemented']),
  },
};

// ------------------------------------------------------------------ OCPP 2.0.1

const v201IdToken = obj(
  {
    idToken: token(36, 'Token value (IdentifierString36)'),
    type: enumOf(['Central', 'eMAID', 'ISO14443', 'ISO15693', 'KeyCode', 'Local', 'MacAddress', 'NoAuthorization']),
  },
  ['idToken', 'type'],
);
const v201IdTokenInfo = obj(
  { status: enumOf(V201_AUTH_STATUS), cacheExpiryDateTime: dateTime, chargingPriority: int(-9, 9), language1: freeText(8), language2: freeText(8) },
  ['status'],
);
const v201Evse = obj({ id: int(0, MAX_CONNECTOR), connectorId: int(0, MAX_CONNECTOR) }, ['id']);
const v201MeterValue = obj({ timestamp: dateTime, sampledValue: arr(ref('V201_SampledValue'), 1, 30) }, ['timestamp', 'sampledValue']);
const v201StatusInfo = obj({ reasonCode: token(20, 'Reason code'), additionalInfo: freeText(512) }, ['reasonCode']);
const v201ChargingProfile = obj(
  {
    id: int(0, INT32),
    stackLevel: int(0, 100),
    chargingProfilePurpose: enumOf(['ChargingStationExternalConstraints', 'ChargingStationMaxProfile', 'TxDefaultProfile', 'TxProfile']),
    chargingProfileKind: enumOf(['Absolute', 'Recurring', 'Relative']),
    recurrencyKind: enumOf(['Daily', 'Weekly']),
    validFrom: dateTime,
    validTo: dateTime,
    transactionId: token(36, 'Transaction id'),
    chargingSchedule: arr(
      obj(
        {
          id: int(0, INT32),
          startSchedule: dateTime,
          duration: int(0, INT32),
          chargingRateUnit: enumOf(['W', 'A']),
          chargingSchedulePeriod: arr(
            obj({ startPeriod: int(0, INT32), limit: { type: 'number', minimum: 0, maximum: 10_000_000 }, numberPhases: int(1, 3), phaseToUse: int(1, 3) }, [
              'startPeriod',
              'limit',
            ]),
            1,
            1024,
          ),
          minChargingRate: { type: 'number', minimum: 0, maximum: 10_000_000 },
        },
        ['id', 'chargingRateUnit', 'chargingSchedulePeriod'],
      ),
      1,
      3,
    ),
  },
  ['id', 'stackLevel', 'chargingProfilePurpose', 'chargingProfileKind', 'chargingSchedule'],
);

export const V201_CHARGER_TO_CSMS: Record<string, { request: Schema; response: Schema }> = {
  BootNotification: {
    request: obj(
      {
        reason: enumOf(['ApplicationReset', 'FirmwareUpdate', 'LocalReset', 'PowerUp', 'RemoteReset', 'ScheduledReset', 'Triggered', 'Unknown', 'Watchdog']),
        chargingStation: obj(
          {
            model: str(20, { minLength: 1, pattern: '^[^\\x00-\\x1F\\x7F]{1,20}$' }),
            vendorName: str(50, { minLength: 1, pattern: '^[^\\x00-\\x1F\\x7F]{1,50}$' }),
            serialNumber: freeText(25),
            firmwareVersion: freeText(50),
            modem: obj({ iccid: freeText(20), imsi: freeText(20) }),
          },
          ['model', 'vendorName'],
        ),
      },
      ['reason', 'chargingStation'],
    ),
    response: obj(
      { currentTime: dateTime, interval: int(0, 86_400), status: enumOf(['Accepted', 'Pending', 'Rejected']), statusInfo: v201StatusInfo },
      ['currentTime', 'interval', 'status'],
    ),
  },
  Heartbeat: {
    request: obj({}, [], { maxProperties: 0 }),
    response: obj({ currentTime: dateTime }, ['currentTime']),
  },
  StatusNotification: {
    request: obj(
      {
        timestamp: dateTime,
        connectorStatus: enumOf(['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted']),
        evseId: int(0, MAX_CONNECTOR),
        connectorId: int(0, MAX_CONNECTOR),
      },
      ['timestamp', 'connectorStatus', 'evseId', 'connectorId'],
    ),
    response: obj({}, [], { maxProperties: 0 }),
  },
  Authorize: {
    request: obj({ idToken: v201IdToken }, ['idToken']),
    response: obj({ idTokenInfo: v201IdTokenInfo }, ['idTokenInfo']),
  },
  TransactionEvent: {
    request: obj(
      {
        eventType: enumOf(['Started', 'Updated', 'Ended']),
        timestamp: dateTime,
        triggerReason: enumOf([
          'Authorized',
          'CablePluggedIn',
          'ChargingRateChanged',
          'ChargingStateChanged',
          'Deauthorized',
          'EnergyLimitReached',
          'EVCommunicationLost',
          'EVConnectTimeout',
          'MeterValueClock',
          'MeterValuePeriodic',
          'TimeLimitReached',
          'Trigger',
          'UnlockCommand',
          'StopAuthorized',
          'EVDeparted',
          'EVDetected',
          'RemoteStop',
          'RemoteStart',
          'AbnormalCondition',
          'SignedDataReceived',
          'ResetCommand',
        ]),
        seqNo: int(0, INT32),
        offline: { type: 'boolean' },
        numberOfPhasesUsed: int(1, 3),
        cableMaxCurrent: int(0, 10_000),
        reservationId: int(0, INT32),
        transactionInfo: obj(
          {
            transactionId: token(36, 'Station-generated transaction id (IdentifierString36)'),
            chargingState: enumOf(['Charging', 'EVConnected', 'SuspendedEV', 'SuspendedEVSE', 'Idle']),
            timeSpentCharging: int(0, INT32),
            stoppedReason: enumOf([
              'DeAuthorized',
              'EmergencyStop',
              'EnergyLimitReached',
              'EVDisconnected',
              'GroundFault',
              'ImmediateReset',
              'Local',
              'LocalOutOfCredit',
              'MasterPass',
              'Other',
              'OvercurrentFault',
              'PowerLoss',
              'PowerQuality',
              'Reboot',
              'Remote',
              'SOCLimitReached',
              'StoppedByEV',
              'TimeLimitReached',
              'Timeout',
            ]),
            remoteStartId: int(0, INT32),
          },
          ['transactionId'],
        ),
        idToken: v201IdToken,
        evse: v201Evse,
        meterValue: arr(v201MeterValue, 1, 20),
      },
      ['eventType', 'timestamp', 'triggerReason', 'seqNo', 'transactionInfo'],
    ),
    response: obj({ totalCost: { type: 'number', minimum: 0, maximum: 1_000_000 }, chargingPriority: int(-9, 9), idTokenInfo: v201IdTokenInfo }),
  },
  MeterValues: {
    request: obj({ evseId: int(0, MAX_CONNECTOR), meterValue: arr(v201MeterValue, 1, 20) }, ['evseId', 'meterValue']),
    response: obj({}, [], { maxProperties: 0 }),
  },
};

const v201Status = (values: string[]) => obj({ status: enumOf(values), statusInfo: v201StatusInfo }, ['status']);

export const V201_CSMS_TO_CHARGER: Record<string, { request: Schema; response: Schema }> = {
  RequestStartTransaction: {
    request: obj(
      { idToken: v201IdToken, remoteStartId: int(0, INT32), evseId: int(1, MAX_CONNECTOR), groupIdToken: v201IdToken, chargingProfile: v201ChargingProfile },
      ['idToken', 'remoteStartId'],
    ),
    response: obj(
      { status: enumOf(['Accepted', 'Rejected']), transactionId: token(36, 'Transaction id'), statusInfo: v201StatusInfo },
      ['status'],
    ),
  },
  RequestStopTransaction: {
    request: obj({ transactionId: token(36, 'Transaction id') }, ['transactionId']),
    response: v201Status(['Accepted', 'Rejected']),
  },
  Reset: {
    request: obj({ type: enumOf(['Immediate', 'OnIdle']), evseId: int(0, MAX_CONNECTOR) }, ['type']),
    response: v201Status(['Accepted', 'Rejected', 'Scheduled']),
  },
  UnlockConnector: {
    request: obj({ evseId: int(0, MAX_CONNECTOR), connectorId: int(0, MAX_CONNECTOR) }, ['evseId', 'connectorId']),
    response: v201Status(['Unlocked', 'UnlockFailed', 'OngoingAuthorizedTransaction', 'UnknownConnector']),
  },
  ChangeAvailability: {
    request: obj({ operationalStatus: enumOf(['Inoperative', 'Operative']), evse: v201Evse }, ['operationalStatus']),
    response: v201Status(['Accepted', 'Rejected', 'Scheduled']),
  },
  SetChargingProfile: {
    request: obj({ evseId: int(0, MAX_CONNECTOR), chargingProfile: v201ChargingProfile }, ['evseId', 'chargingProfile']),
    response: v201Status(['Accepted', 'Rejected']),
  },
  ClearChargingProfile: {
    request: obj({
      chargingProfileId: int(0, INT32),
      chargingProfileCriteria: obj({
        evseId: int(0, MAX_CONNECTOR),
        chargingProfilePurpose: enumOf(['ChargingStationExternalConstraints', 'ChargingStationMaxProfile', 'TxDefaultProfile', 'TxProfile']),
        stackLevel: int(0, 100),
      }),
    }),
    response: v201Status(['Accepted', 'Unknown']),
  },
  TriggerMessage: {
    request: obj(
      {
        requestedMessage: enumOf([
          'BootNotification',
          'LogStatusNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'SignChargingStationCertificate',
          'SignV2GCertificate',
          'StatusNotification',
          'TransactionEvent',
          'SignCombinedCertificate',
          'PublishFirmwareStatusNotification',
        ]),
        evse: v201Evse,
      },
      ['requestedMessage'],
    ),
    response: v201Status(['Accepted', 'Rejected', 'NotImplemented']),
  },
};

// ------------------------------------------------------------------ framing

/** OCPP-J messageId: max 36 chars (spec), restricted here to printable ASCII. */
export const messageId: Schema = token(36, 'Unique message id; a response repeats the id of the request it answers');

export const ERROR_CODES = {
  '1.6': [
    'NotImplemented',
    'NotSupported',
    'InternalError',
    'ProtocolError',
    'SecurityError',
    'FormationViolation',
    'PropertyConstraintViolation',
    'OccurenceConstraintViolation',
    'TypeConstraintViolation',
    'GenericError',
  ],
  '2.0.1': [
    'FormatViolation',
    'GenericError',
    'InternalError',
    'MessageTypeNotSupported',
    'NotImplemented',
    'NotSupported',
    'OccurrenceConstraintViolation',
    'PropertyConstraintViolation',
    'ProtocolError',
    'RpcFrameworkError',
    'SecurityError',
    'TypeConstraintViolation',
  ],
} as const;

/** Small named schemas shared by both output formats. */
export const SHARED_SCHEMAS: Record<string, Schema> = {
  MessageId: messageId,
  V16_SampledValue: sampledValueVariants('1.6'),
  V201_SampledValue: sampledValueVariants('2.0.1'),
  V16_ErrorCode: enumOf([...ERROR_CODES['1.6']]),
  V201_ErrorCode: enumOf([...ERROR_CODES['2.0.1']]),
  ErrorDescription: freeText(255),
  ErrorDetails: { type: 'object', maxProperties: 20, description: 'Free-form error details object' },
};

export const VERSIONS = {
  'ocpp1.6': { tag: 'V16', label: 'OCPP 1.6J', fromCharger: V16_CHARGER_TO_CSMS, fromCsms: V16_CSMS_TO_CHARGER },
  'ocpp2.0.1': { tag: 'V201', label: 'OCPP 2.0.1', fromCharger: V201_CHARGER_TO_CSMS, fromCsms: V201_CSMS_TO_CHARGER },
} as const;

/** Largest single WebSocket text message a legitimate charger sends to this CSMS, with headroom. */
export const MAX_MESSAGE_BYTES = 16_384;
/** chargePointId in the URL: OCPP 2.0.1 limits the identity to 48 chars of unreserved characters. */
export const CHARGE_POINT_ID_PATTERN = '^[A-Za-z0-9._~:\\-]{1,48}$';
