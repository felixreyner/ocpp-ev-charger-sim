# OpenAPI / JSON Schema specs for the CSMS (WAF profile)

These files describe the **only traffic a legitimate charging station sends to this CSMS**, strictly enough that a WAF such as FortiWeb (or any schema validator) can reject what the rogue charger sends.

They come from what the code actually implements (`packages/ocpp/src/schemas.ts`, the CSMS handlers in `apps/csms/server/central.ts`, and the charger in `apps/charger/server/station.ts`). `tests/specs.test.ts` checks this on every CI run.

| File | What it is | Use it for |
| --- | --- | --- |
| [`openapi/ocpp-csms-gateway.openapi.yaml`](openapi/ocpp-csms-gateway.openapi.yaml) | OpenAPI 3.0.3. The CSMS's real HTTP surface: one `GET /ocpp/{chargePointId}` WebSocket upgrade with strict path and header rules. | **Load this into FortiWeb OpenAPI Validation.** It blocks every other path, method, query string and body, and every handshake with a bad station id or subprotocol. |
| [`openapi/ocpp-messages.openapi.yaml`](openapi/ocpp-messages.openapi.yaml) | OpenAPI 3.0.3 catalogue of all 29 OCPP actions (1.6J and 2.0.1, both directions), each as a *virtual* `POST /{subprotocol}/{Action}` with strict request and response schemas. | Reading in Swagger UI, Postman or Redoc, tuning WAF rules, and validating payloads. **Don't** publish these paths on the CSMS: OCPP isn't REST. |
| [`json-schema/ocpp1.6-inbound-frame.schema.json`](json-schema/ocpp1.6-inbound-frame.schema.json)<br>[`json-schema/ocpp2.0.1-inbound-frame.schema.json`](json-schema/ocpp2.0.1-inbound-frame.schema.json) | JSON Schema 2020-12 for one whole WebSocket message from a station: `[2,id,Action,payload]`, `[3,id,payload]` or `[4,id,code,desc,details]`. | Enforcing message content after the upgrade, with any validator that understands JSON Schema (see below). |
| `src/schemas.ts`, `src/build.ts` | Source and generator. | Edit `src/schemas.ts`, then run `npm run specs`. |

## Why there are two layers

OCPP-J is **one WebSocket per station**. After the HTTP upgrade there are no more HTTP requests. Every OCPP message is a WebSocket text frame holding a JSON array. So:

1. **The handshake is HTTP.** An OpenAPI validator can enforce it fully. That's the gateway file.
2. **The messages are WebSocket frames.** A normal OpenAPI validation policy never sees them. Use the JSON Schemas, plus WebSocket size limits and rate limits.

## How strict the schemas are

Compared with what the CSMS checks today, the schemas:

- set `additionalProperties: false` on every object. Optional fields from the official OCPP schemas are still allowed (`sampledValue.context`, `vendorErrorCode`, `meterSerialNumber` …), so real stations aren't blocked.
- put `maxLength` and a character pattern on every string. Ids are printable ASCII and free text has no control characters.
- use official OCPP enums instead of free strings (`errorCode`, `reason`, `triggerReason`, `stoppedReason`, `measurand`, `unit`, idToken `type`, CALLERROR codes).
- put ranges on every number: connector/EVSE 0–100, ids 1–2³¹-1, intervals ≤ 1 day.
- check meter readings by measurand. Energy, power, current and voltage must be 0 to 999,999,999. SoC must be 0–100. Only `Power.Factor` and `Temperature` may be negative. In 1.6 the value is a string, so this check is a regex on the string.
- only accept CALLRESULTs from a station that look like answers to a CSMS command (`{status, statusInfo?}`).
- cap a whole message at **16 KB**. The biggest legitimate frame (a `TransactionEvent`) is under 1 KB.

You can change these in `src/schemas.ts`: `MAX_CONNECTOR`, `MAX_READING`, `MAX_MESSAGE_BYTES` and `CHARGE_POINT_ID_PATTERN`. Two choices are deliberately strict. `Sec-WebSocket-Protocol` is required (the CSMS would fall back to 1.6 without it). OCPP 2.0.1 `customData` isn't allowed. Relax either if a real station needs it.

## What it stops from the rogue charger

These numbers come from `tests/specs.test.ts`. The test fires each attack 60 times from the real `RogueCharger` against a real CSMS, and checks the frames that arrive against the inbound schema.

FortiWeb's OpenAPI / JSON-schema validation only covers the HTTP handshake, not
messages inside the WebSocket. So the rogue menu keeps only modes FortiWeb can stop
on the wire: rate/connection limits, the WebSocket frame/message size cap, and the
attack-signature scan. The schema column shows what a validator one hop behind
FortiWeb would add.

| Rogue mode | Stopped by the schema? | Stopped by the WAF via | Notes |
| --- | --- | --- | --- |
| `oversized` | ✅ 100 % | WS size cap | Every frame is ~300 KB, far over the 16 KB WebSocket max frame / message size, so FortiWeb drops it on the wire. The schema's `maxLength` 20/50 on boot fields also catches it. |
| `flood` | ❌ valid frames | rate limit | Use rate limiting. In 2.0.1 mode the rogue sends 1.6-shaped StatusNotifications, and the schema rejects that half. |
| `reconnectStorm` | ❌ (rate limit) | rate limit | Every reconnect is a new `GET /ocpp/{id}`, so an HTTP request rate limit on that URL stops it. |
| `sqlInjection` | ⚠️ partly | signatures | Payloads ride in idTag / idToken / vendor fields. The hardened field patterns (printable-ASCII tokens, no spaces, short `maxLength`) reject the long or space-bearing variants (`' OR '1'='1' --`, `'; DROP TABLE …`); short pattern-legal ones (`admin'--`) are left for the SQLi signature set. |
| `xssPayload` | ⚠️ partly | signatures | `<script>…</script>` and `<img … onerror=…>` are too long or contain spaces, so the schema drops them; compact ones (`<svg/onload=alert(1)>`, `javascript:alert(1)`) need the XSS signatures. |
| `pathTraversal` | ⚠️ partly (1.6) / ❌ (2.0.1) | signatures | `../../../../etc/passwd` is 22 chars: it busts the 20-char 1.6 `idTag` but fits the 36-char 2.0.1 `idToken`, so in 2.0.1 only the traversal signatures (`../`, `..%2f`, `%2e%2e`) catch it. |

The three injection modes are the reason to enable the **attack-signature scan**, not
just OpenAPI/JSON-schema validation: they send structurally valid OCPP frames, so a
validator that only checks shape and field ranges passes the short, pattern-legal
payloads. `tests/specs.test.ts` checks both halves — every injection frame carries a
detectable signature, and the schema alone never catches all of them.

Modes that **only a frame schema** could catch (`malformed`, `bogusMeter`, `wrongType`)
were removed from the rogue menu, since FortiWeb can't apply the schema inside the
WebSocket. Modes **no WAF can see** (a charger that ignores CSMS commands, or replays
ids only the stateful CSMS recognizes) were removed earlier. The CSMS still defends
against all of them with frame parsing, call timeouts and transaction state.

The rogue's boot frames are well formed, so **no schema can tell `ROGUE-666` apart from a real station by shape.** To keep unknown stations out entirely, allowlist known `chargePointId`s, or better, turn on OCPP security profile 2 or 3 (TLS plus Basic auth or client certificates).

## Loading it into FortiWeb

Menu names below are from the FortiWeb 7.x admin guide. They move around a little between firmware versions.

1. **Server policy.** Put FortiWeb in reverse-proxy mode in front of the CSMS OCPP port (`csms:9000`). Keep the dashboard (8080) on a different virtual server, or don't publish it at all. Chargers never need it.
2. **OpenAPI validation (the handshake).**
   - *Web Protection > OpenAPI Validation > OpenAPI File*: Create New, and upload `openapi/ocpp-csms-gateway.openapi.yaml`.
   - *Web Protection > OpenAPI Validation > OpenAPI Validation Policy*: Create New, add that file, and set the action to **Alert & Deny** (or Period Block to also keep a misbehaving IP out for a while).
   - Add the policy to the **Web Protection Profile** used by the server policy.
   - Result: `/foo`, `/ocpp`, `/ocpp/a/b/c`, POST requests, query strings, ids with spaces or over 48 characters, and handshakes without `ocpp1.6`/`ocpp2.0.1` are all denied before they reach the CSMS.
3. **WebSocket security (the frames).** Allow WebSocket in the protection profile and create a WebSocket security rule. Set max frame size and max message size to **16384**, allow text frames only, and turn on the attack-signature scan. Chargers don't send an `Origin` header, so don't require one.
4. **Message content.** If your FortiWeb firmware can validate WebSocket message bodies against a JSON schema, attach `json-schema/<subprotocol>-inbound-frame.schema.json`. If it can't (check your version's docs), enforce the schemas one hop later, as below.
5. **Rate limits.** Under *DoS Protection*, add an HTTP access limit or flood rule on `/ocpp/*` per source IP, for example a few handshakes per minute. That stops `reconnectStorm`.
6. **Optional allowlist.** Use a URL access rule that only allows `/ocpp/<known-id>` for your real stations.

### Enforcing the frame schemas without WAF support

The JSON Schemas work as they are with [Ajv](https://ajv.js.org/), and with any other JSON Schema 2020-12 validator in front of the CSMS or inside it:

```ts
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema16 from './specs/json-schema/ocpp1.6-inbound-frame.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ strictTuples: false });
addFormats(ajv);
const isValidFrame = ajv.compile(schema16);

ws.on('message', (data) => {
  let frame: unknown;
  try { frame = JSON.parse(data.toString()); } catch { return ws.close(1007, 'Invalid OCPP frame'); }
  if (!isValidFrame(frame)) return ws.close(1008, 'Rejected by OCPP schema');
  // ...hand it to the CSMS
});
```

## Regenerating

```bash
npm run specs          # rewrite specs/openapi and specs/json-schema from src/schemas.ts
npm test               # includes tests/specs.test.ts: in sync, valid OpenAPI, real traffic passes, rogue is rejected
```
