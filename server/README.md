# SS-01 Server — LexNova backend

The privileged backend for the SS-01 Personal Safety & Emergency Response System
(hackathon **HK26-0040**). Node.js + **TypeScript (strict)** + **Fastify 5** + **Supabase
(PostgreSQL + PostGIS)** + **Vapi**, with Zod validation, pino structured logs, and a
mock-first test suite.

**Identity model — no login.** There is no signup, no password, no email verification, no
OAuth, and **no "role" column anywhere**. A device is identified by the `X-Device-Id` header
(UUID v4); unknown devices auto-register on their first request. Every user is both a
potential SOS requester **and** a potential responder — the role is derived per incident from
`incident_responders` membership, never stored on the device. See §6 of the root
[`README.md`](../README.md) for the full model.

---

## Requirements

- Node.js 20+
- A Supabase project (free tier is fine) — optional for local development, required for the
  real database
- A Vapi account (optional — without keys the server runs on the mock call provider)
- ngrok (or any tunnel) — only needed to receive Vapi webhooks on a local machine

## Quick start (no keys needed — mock mode)

```
cd server
npm install
cp .env.example .env     # defaults are fine for local development; .env is git-ignored
npm run dev              # http://localhost:8080 (tsx watch)
curl http://localhost:8080/health
```

With no Supabase credentials the server runs on an **in-memory database** (data lost on
restart, loud warning in the logs). With no Vapi credentials the call provider is the
**mock** — every simulated call is logged as MOCKED and stored with `provider: "mock"`.
`NODE_ENV=production` refuses to start without Supabase credentials.

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server with watch mode (`tsx watch src/index.ts`) |
| `npm run typecheck` | strict TypeScript check, no emit |
| `npm run build` | compile to `dist/` |
| `npm start` | run the compiled server |
| `npm test` | Vitest suite — mock-first: no keys, no network, no real calls |
| `npm run test:watch` | Vitest in watch mode |

---

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. **Enable PostGIS**: Dashboard → *Database → Extensions* → search `postgis` → enable.
   (The migration also runs `create extension if not exists postgis`, but enabling it in the
   dashboard first avoids permission surprises.)
3. Apply the migrations **in order** — SQL Editor → paste & run each file, or link the
   project and `supabase db push`:
   - `migrations/0001_init.sql` — schema: `devices`, `device_locations`,
     `trusted_contacts`, `sos_incidents`, `incident_evidence`, `incident_recipients`,
     `incident_responders`, `responder_events`, `call_events`, `audit_logs`
   - `migrations/0002_functions.sql` — PostGIS RPC functions: `upsert_device_location`,
     `latest_device_location`, `nearby_devices`, `nearby_active_incidents`
   - `migrations/0003_rls.sql` — RLS **deny-all** (zero policies) + privileges revoked from
     `anon` / `authenticated`. The Android app never talks to the database; the only
     legitimate client is this server, using the service-role key.
4. Put the project values in `server/.env`:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>     # server-side only — NEVER ships in the app
```

The server probes the database at boot and logs a clear error until the schema is applied.

## Vapi setup and ngrok — the webhook URL changes on every restart

The server places outbound calls through the Vapi REST API and receives call lifecycle
webhooks (status updates, transcripts, recordings) at `POST /vapi/webhook`.

1. In the Vapi dashboard, create the **assistant** and (with a telephony plan) a
   **phone number**. Put their IDs in `server/.env`:

```
VAPI_PRIVATE_KEY=<your-private-key>
VAPI_PHONE_NUMBER_ID=<phone-number-id>
VAPI_ASSISTANT_ID=<assistant-id>
VAPI_WEBHOOK_SECRET=<your-webhook-secret>        # optional, but recommended
```

2. Real calls require all three of `VAPI_PRIVATE_KEY`, `VAPI_PHONE_NUMBER_ID`, and
   `VAPI_ASSISTANT_ID`. If any is missing, the server stays on the **mock provider** and
   says so in the logs.
3. Expose the local server:

```
ngrok http 8080
# → Forwarding  https://<random>.ngrok-free.app -> http://localhost:8080
```

4. Set `NGROK_URL` in `server/.env` to the printed HTTPS URL, and point the Vapi dashboard
   webhook (assistant → *Server URL* / webhooks) to:

```
https://<random>.ngrok-free.app/vapi/webhook
```

5. **Free ngrok URLs change on every restart.** Every time ngrok restarts you must:
   - update `NGROK_URL` in `server/.env`,
   - update the webhook URL in the Vapi dashboard to the new
     `NGROK_URL/vapi/webhook`.
   If `VAPI_WEBHOOK_SECRET` is set, incoming webhooks are verified with HMAC-SHA256
   (constant-time compare) or the documented Bearer header; unsigned or wrongly-signed
   payloads are rejected with `401 INVALID_WEBHOOK_SIGNATURE`.

---

## Deploy on Render (Blueprint)

`render.yaml` at the repository root defines the service — you do not create it by hand.

1. Render dashboard → **New → Blueprint** → connect this repository → **Apply**.
2. Render creates the `lexnova-ss01-server` web service (`rootDir: server`, free plan,
   build `npm ci --include=dev && npm run build`, start `npm start`, health check
   `/health`, auto-deploy on every commit to the connected branch).
3. The blueprint marks the secrets as `sync: false`, so Render asks for them on first
   apply. Fill them from `server/.env` (they are git-ignored and never committed):
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPI_PRIVATE_KEY`,
   `VAPI_PHONE_NUMBER_ID`, `VAPI_ASSISTANT_ID`, `VAPI_WEBHOOK_SECRET`.
4. After the first deploy, point the Vapi assistant's *Server URL* to
   `https://<service-name>.onrender.com/vapi/webhook` — this replaces the ngrok URL and
   survives restarts.
5. Free plan caveat: the service **spins down after ~15 minutes of inactivity** and the
   next request takes ~30–60 s to wake it. Webhooks delivered during sleep can be
   delayed; hit `/health` before a demo to warm it up.

---

## What is real vs mocked

| Area | Without credentials (default) | With credentials |
| --- | --- | --- |
| Database | in-memory store (data lost on restart, loud log warning) | Supabase + PostGIS via the RPC functions of `0002_functions.sql` |
| Outbound calls | **mock provider** — outcome controlled by `MOCK_VAPI_OUTCOME` (`answered` \| `no-answer` \| `silent`); every record carries `provider: "mock"` and the logs say the call is mocked | Vapi REST (`provider: "vapi"`) — a real call is placed |
| Webhook | same handler; send test payloads yourself (signed) | Vapi delivers real status/transcript/report webhooks |
| Escalation | fully functional end-to-end in both modes | same code, real calls |
| Emergency services (112 / police / ambulance) | **never called automatically in any mode** — there is no integration, and the audit trail says so explicitly on exhaustion | same — still not called |

The mock provider **never pretends a real call happened**: logs state it, stored call events
carry `provider: "mock"`, and mock outcome reasons (`mock-silent-line`,
`customer-did-not-answer`) make the simulation visible.

## API reference

Base URL: `http://localhost:8080`. All routes except `/health` and `/vapi/webhook` require
the `X-Device-Id` header (UUID v4); unknown devices auto-register on their first request.
Mutating routes are rate-limited **per device** (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`,
default 30 per 60 s → `429 RATE_LIMITED` + `Retry-After`); `/nearby/sos` polling is
deliberately exempt. All ids are UUIDs; all timestamps are ISO-8601 with timezone offset
(e.g. `2026-10-15T09:30:00.000Z`). Every error has the same shape:

```json
{
  "error": {
    "code": "INVALID_STATE_TRANSITION",
    "message": "Illegal incident transition: ACTIVE -> RESOLVED",
    "details": { "from": "ACTIVE", "to": "RESOLVED" }
  }
}
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness — no identity required |
| `GET` | `/device/me` | profile of the calling device — unknown devices auto-register |
| `PATCH` | `/device/me` | update `displayName` / `phoneNumber` / `canRespond` (at least one) |
| `POST` | `/device/location` | latest-location upsert — one row per device, feeds nearby queries |
| `GET` | `/contacts` | trusted contacts in call order (priority asc) |
| `POST` | `/contacts` | add trusted contact — phone normalized to `+digits`, duplicates → 409 |
| `DELETE` | `/contacts/:contactId` | remove trusted contact → `204` |
| `POST` | `/sos` | idempotent SOS creation (`clientRequestId`) — `201` new, `200` replay |
| `GET` | `/sos/:incidentId` | incident detail, scoped per viewer (see below) |
| `POST` | `/sos/:incidentId/cancel` | owner; false alarm — `ACTIVE`/`HELP_REQUESTED` only |
| `POST` | `/sos/:incidentId/resolve` | owner; only after `RESPONDER_ACKNOWLEDGED` |
| `POST` | `/sos/:incidentId/respond` | responder step: `ACCEPT` `DECLINE` `EN_ROUTE` `ARRIVED` `WITHDRAW` |
| `GET` | `/nearby/sos` | polling: active incidents nearby — rounded distance, never coordinates |
| `POST` | `/vapi/webhook` | Vapi call lifecycle — signature-verified, acked fast, processed async |

### Examples

**`GET /health`** → `200`

```json
{ "status": "ok", "time": "2026-10-15T09:30:00.000Z" }
```

**`GET /device/me`** → `200` (works on the very first request — the device is created here)

```json
{
  "device": {
    "deviceId": "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
    "displayName": null,
    "phoneNumber": null,
    "canRespond": true,
    "isActive": true,
    "createdAt": "2026-10-15T09:29:58.000Z",
    "updatedAt": "2026-10-15T09:29:58.000Z",
    "lastSeenAt": "2026-10-15T09:29:58.000Z"
  }
}
```

**`PATCH /device/me`** — body (any subset, at least one field):

```json
{ "displayName": "Aarav", "phoneNumber": "+919812345678", "canRespond": true }
```

**`POST /device/location`** — body → `{ "status": "ok", "capturedAt": "…" }`:

```json
{
  "latitude": 28.6139,
  "longitude": 77.209,
  "accuracy": 8.5,
  "capturedAt": "2026-10-15T09:30:00.000Z"
}
```

**`POST /contacts`** — body → `201 { "contact": { … } }`; a duplicate number → `409 CONTACT_EXISTS`:

```json
{ "contactName": "Aarav", "phoneNumber": "+91 98123-45678", "priority": 1 }
```

```json
{
  "contact": {
    "id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "contactName": "Aarav",
    "phoneNumber": "+919812345678",
    "priority": 1,
    "createdAt": "2026-10-15T09:31:00.000Z",
    "updatedAt": "2026-10-15T09:31:00.000Z"
  }
}
```

**`POST /sos`** — body → `201 { "incident": { … }, "created": true }`; the same
`clientRequestId` again → `200` with the same incident and `"created": false` (offline
queue replays land here). Coordinates are optional — without them the server falls back to
the device's latest stored fix:

```json
{
  "triggerType": "shake",
  "latitude": 28.6139,
  "longitude": 77.209,
  "locationAccuracy": 8.5,
  "deviceTimestamp": "2026-10-15T09:30:00.000Z",
  "clientRequestId": "first-tap-001"
}
```

```json
{
  "incident": {
    "id": "b6e1cdc0-5f6c-4a5e-9c1a-2f5a19d3f7c2",
    "status": "ACTIVE",
    "triggerType": "shake",
    "activatedAt": "2026-10-15T09:30:00.000Z",
    "deviceTimestamp": "2026-10-15T09:30:00.000Z",
    "escalationLevel": 1,
    "clientRequestId": "first-tap-001",
    "cancelReason": null,
    "resolutionReason": null,
    "cancelledAt": null,
    "resolvedAt": null,
    "createdAt": "2026-10-15T09:30:01.000Z",
    "updatedAt": "2026-10-15T09:30:01.000Z"
  },
  "created": true
}
```

**`GET /sos/:incidentId`** — owner view. A responder sees the same shape but always with
`"evidence": []` and `"calls": []`, and gets it only after ACCEPT (before that:
`403 RESPONDER_NOT_ACCEPTED`; no relationship at all: `403 FORBIDDEN`):

```json
{
  "incident": { "…": "incident core as above", "status": "HELP_REQUESTED", "escalationLevel": 1 },
  "location": { "latitude": 28.6139, "longitude": 77.209, "accuracy": 8.5 },
  "evidence": [],
  "responders": [],
  "calls": [],
  "viewer": { "role": "OWNER" }
}
```

**`POST /sos/:incidentId/cancel`** — body `{ "reason": "accidental press" }`;
**`POST /sos/:incidentId/resolve`** — body `{ "resolutionReason": "helped, safe now" }`.
Both return `{ "incident": { … } }`; illegal moves are `409 INVALID_STATE_TRANSITION`.

**`POST /sos/:incidentId/respond`** — body `{ "action": "ACCEPT" }` → `200`:

```json
{
  "incident": { "…": "incident core", "status": "RESPONDER_ACKNOWLEDGED" },
  "responder": {
    "deviceId": "3c9f1c2e-6d4b-4f0a-8e2a-71b0a2c4d9e1",
    "status": "ACCEPTED",
    "distanceAtNotifyM": 321.4,
    "notifiedAt": "2026-10-15T09:30:05.000Z",
    "acceptedAt": "2026-10-15T09:30:12.000Z",
    "enRouteAt": null,
    "arrivedAt": null,
    "declinedAt": null,
    "withdrawnAt": null
  }
}
```

Only devices recorded as `NOTIFIED` for the incident may respond — membership cannot be
forged from the client (`403 NOT_A_RESPONDER`); only legal steps are allowed
(`409 INVALID_RESPONDER_TRANSITION`); a closed incident is `409 INCIDENT_CLOSED`.
Accepting does **not** mean arrival — each step has its own timestamp.

**`GET /nearby/sos`** — `?latitude=…&longitude=…`, or the device's latest stored fix.
No coordinates to the caller, ever — distance is rounded to 100 m:

```json
{
  "incidents": [
    {
      "incidentId": "b6e1cdc0-5f6c-4a5e-9c1a-2f5a19d3f7c2",
      "status": "HELP_REQUESTED",
      "triggerType": "shake",
      "approximateDistanceM": 300,
      "activatedAt": "2026-10-15T09:30:00.000Z",
      "responderStatus": "NOTIFIED"
    }
  ],
  "locationSource": "request"
}
```

Polling registers the caller as `NOTIFIED` for each returned incident — that membership is
what makes a later `ACCEPT` a legal transition. No stored fix and no query params →
`400 LOCATION_REQUIRED`; `canRespond: false` → `403 RESPONDER_DISABLED`.

**`POST /vapi/webhook`** — verified against the configured secret (unsigned or invalid →
`401 INVALID_WEBHOOK_SIGNATURE`), always answered immediately while processing continues in
the background:

```json
{ "received": true }
```

### Common error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MISSING_DEVICE_ID` | 400 | `X-Device-Id` header absent or blank |
| `INVALID_DEVICE_ID` | 400 | header present but not a UUID v4 |
| `DEVICE_INACTIVE` | 403 | device has been deactivated |
| `VALIDATION_ERROR` | 400 | body/query fails the Zod schema (details included) |
| `RATE_LIMITED` | 429 | per-device limit hit — `Retry-After` header set |
| `INCIDENT_NOT_FOUND` | 404 | unknown or malformed incident id |
| `INVALID_STATE_TRANSITION` | 409 | illegal SOS state move (details: from/to) |
| `INCIDENT_CLOSED` | 409 | incident is `RESOLVED`/`CANCELLED` |
| `NOT_A_RESPONDER` | 403 | device was never notified for this incident |
| `RESPONDER_NOT_ACCEPTED` | 403 | membership exists but has not ACCEPTED yet |
| `INVALID_RESPONDER_TRANSITION` | 409 | illegal responder step (details: from/to) |
| `CONTACT_EXISTS` | 409 | phone number already saved (after normalization) |
| `CONTACT_NOT_FOUND` | 404 | unknown or malformed contact id |
| `RESPONDER_DISABLED` | 403 | `canRespond` is off |
| `LOCATION_REQUIRED` | 400 | no coordinates in the request and none stored |
| `INVALID_WEBHOOK_SIGNATURE` | 401 | Vapi webhook failed signature verification |

### Escalation defaults

Level 1 calls trusted contacts in priority order; levels 2–3 call nearby devices with
phones inside an expanding radius (`NEARBY_RADIUS_METERS × (level−1)`), with a watchdog after
`SOS_ESCALATION_TIMEOUT_SECONDS` if a call never resolves. The chain stops the moment a
responder accepts. When every level is exhausted, the audit log states that no
emergency-service dispatch was attempted.

## Tests

```
cd server
npm test          # full suite — mock-first: no Supabase project, no API keys, no real calls
```

- `tests/critical-path.test.ts` — the 13 spec-§15 scenarios, one named test each.
- Feature suites: device identity, profile/location, SOS + idempotency + state machine,
  webhook verification/intake, nearby privacy + distances, escalation chains (incl. watchdog
  and boot rehydration), responder actions, contacts CRUD, offline-queued events.
- PostGIS behavior is mirrored by an in-memory database (haversine distances, the same
  eligibility and privacy filters) so the full API is testable without a live project.

Tests use Fastify `app.inject()` against the in-memory database — nothing touches Supabase or
Vapi, and **no real emergency call is ever placed by a test**.

## Logs

Structured pino logs (JSON in production, pretty in development via pino-pretty when
configured). Every SOS lifecycle step is logged with the `incidentId` and outcome: creation
and idempotent replays, state transitions, escalation attempts per level/recipient, call
outcomes, webhook processing and quarantine, responder actions, and exhaustion. Provider
mode is always visible (`mocked: true/false`).

## Git workflow

Judges monitor this repository; every meaningful change is committed and pushed:

```
git add server/src server/tests        # add specific paths — never a broad "git add ." near .env files
git commit -m "feat|fix|test|docs|chore: <description>"
git push
```

**Never commit `server/.env`.** It is git-ignored; the committed template is
`server/.env.example` with placeholders only. Real keys (Supabase service-role, Vapi private
key, webhook secret) live only in the local `.env`. Every commit must leave the project
runnable (`npm run typecheck && npm test`).

## Reality constraints (binding)

- No login/signup/passwords/OAuth — identity is the device, and any device can both seek and
  offer help without any account-type change.
- Public emergency numbers (112 etc.) are **never dialed automatically**; there is no police,
  hospital, or dispatch integration, and nothing in logs, copy, or API responses may imply
  one exists.
- Exact victim location is never exposed to nearby devices before they accept (pre-accept
  payloads carry a 100 m-rounded distance only).
- Nearby helpers are "Community Responder" — never labeled "verified".
- A call is only reported as delivered/answered based on provider-confirmed facts; the mock
  provider clearly reports itself as a mock.
