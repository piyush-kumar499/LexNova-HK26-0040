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

## API surface

All routes except `/health` and `/vapi/webhook` require the `X-Device-Id` header (UUID v4).
Mutating routes are rate-limited per device; `/nearby/sos` polling is deliberately
rate-limit exempt.

```
GET    /health                    liveness (no identity required)
GET    /device/me                 profile of the calling device — unknown devices auto-register
PATCH  /device/me                 displayName / phoneNumber / canRespond
POST   /device/location           latest-location upsert (one row per device)
GET    /contacts                  trusted contacts in call order (priority asc)
POST   /contacts                  add trusted contact (phone normalized to +digits)
DELETE /contacts/:contactId       remove trusted contact
POST   /sos                       idempotent SOS creation (clientRequestId) — returns immediately
GET    /sos/:incidentId           owner sees everything; responder only after ACCEPT (exact location, no evidence/calls)
POST   /sos/:incidentId/cancel    false-alarm cancel (owner; ACTIVE/HELP_REQUESTED only)
POST   /sos/:incidentId/resolve   resolve (owner; only after RESPONDER_ACKNOWLEDGED)
POST   /sos/:incidentId/respond   responder step: ACCEPT / DECLINE / EN_ROUTE / ARRIVED / WITHDRAW
GET    /nearby/sos                polling: active incidents nearby — distance rounded to 100 m, never coordinates
POST   /vapi/webhook              Vapi webhook — signature-verified, acked fast, processed async
```

Escalation defaults (all in `.env`): level 1 calls trusted contacts in priority order; levels
2–3 call nearby devices with phones inside an expanding radius (`NEARBY_RADIUS_METERS ×
(level−1)`), with a watchdog after `SOS_ESCALATION_TIMEOUT_SECONDS` if a call never resolves.
The chain stops the moment a responder accepts. When every level is exhausted, the audit log
states that no emergency-service dispatch was attempted.

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
