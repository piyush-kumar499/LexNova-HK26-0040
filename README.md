# LexNova — Smart Personal Safety & Emergency Response System

> Hackathon submission **HK26-0040** · Problem statement **SS-01**
> Team repository: `piyush-kumar499/LexNova-HK26-0040`

LexNova is an Android personal-safety application: a user in danger activates an SOS, the
system records a location-backed incident, notifies trusted contacts, and lets nearby app
users choose to respond — per incident, without any permanent "helper" or "victim" account
type.

---

## 1. Current status — read this first

**The server foundation is implemented and covered by automated tests** (`server/`, Node +
TypeScript + Fastify). The Android app has not been started. Every row marked ⬜ is a target
from the project specification, or planned work, not delivered yet.

| Area | Status |
| --- | --- |
| Project specification captured, architecture and security model documented | ✅ this document |
| Server foundation: Fastify app, strict config validation, health endpoint, error taxonomy, structured logging | ✅ `server/src` |
| Device-based identity (`X-Device-Id`, auto-registration, no login) | ✅ implemented + tests |
| Device profile + location endpoints | ✅ implemented + tests |
| SOS incidents: create / read / cancel / resolve, idempotent creation, server-validated state machine | ✅ implemented + tests |
| Per-viewer scoping: owner vs responder, exact location only after `ACCEPTED` | ✅ implemented + tests |
| Rate limiting, duplicate-tap protection, append-only audit log | ✅ implemented + tests |
| Supabase migrations: schema, PostGIS functions, RLS | ✅ written (`server/migrations/`) — applying them to a hosted project is a setup step (§13) |
| Trusted-contact storage + escalation dialing to contacts (mock-first Vapi adapter) | ✅ calls; ⬜ HTTP CRUD endpoints for contacts |
| Vapi webhook: signature verification, status / transcript / recording intake, delivery truth, no-answer → next contact | ✅ implemented + tests |
| Nearby discovery: polling endpoint with privacy-rounded distance, PostGIS + in-memory equivalence, NOTIFIED responder membership | ✅ polling implemented + tests; ⬜ accept / decline / en-route flows |
| Emergency intelligence engine on **Groq** (§10) | ⬜ specified here, not implemented |
| Kotlin / Jetpack Compose Android app — incl. SOS voice dial-out (§11), shake, camera, UI | ⬜ not started |
| FCM push, real Vapi number, WebRTC, Maps, Groq credentials | ⬜ external — need credentials/authorization (§9) |

The server test suite runs entirely on mocks — no Supabase project, no API keys, and no real
calls are needed: `cd server && npm test`. No feature above is "done" in the product sense:
nothing is deployed, there is no end-to-end app, and no real provider call has ever been
placed. Nothing in this README should be read as "this works" in production.

---

## 2. Problem statement

Existing safety apps treat the person in danger as passive and the responder as a
pre-registered role. Real emergencies do not respect that split: the person who helps today
may need help tomorrow. LexNova therefore:

- makes **every user — identified by their device, no signup** — both a potential requester
  and a potential responder;
- authorizes information **per incident**, not per account type;
- keeps precise location and media private by default;
- records an audit trail so no claim of "police notified" is made without confirmation.

Safety target: **a reliable, secure emergency foundation matters more than a large number of
unfinished features.**

---

## 3. Technology stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Mobile app | Kotlin, Jetpack Compose, Material 3 | MVVM, Coroutines + Flow, Navigation Compose |
| Backend service | Node.js 20+, Fastify 5, TypeScript (strict), Zod, Vitest, pino | **Implemented** in `server/` — the privileged backend today: API, validation, calling, webhooks |
| Device capabilities | Android Sensor API (shake), Fused Location Provider, CameraX, audio APIs, telephony (`Intent.ACTION_CALL` / `ACTION_DIAL`) | Permissions handled explicitly, no background-execution workarounds. Telephony constraints in §11 |
| Backend platform | Supabase: PostgreSQL + PostGIS | Primary database — accessed **only by the server** (service role). Supabase Auth is not used (identity is device-based, §5); Storage/Realtime are planned |
| Geospatial | PostGIS | Radius-based nearby-user discovery |
| Privileged operations | The Node server in `server/` (service-role key held server-side) | Supabase Edge Functions or a FastAPI service remain an option, but are not needed yet |
| Notifications | Firebase Cloud Messaging | Planned — later phase |
| Voice/AI calls | Vapi | Planned — backend-initiated, plus the SOS voice uplink in §11 |
| LLM for emergency analysis | **Groq** (OpenAI-compatible endpoint or official SDK) | Primary and only provider. Google Gemini is **not** used anywhere in this design |
| Live media | WebRTC | Planned interface only |
| Maps | Google Maps Platform or equivalent | Planned |

Constraints from the specification: no Flutter or React Native replacement; Supabase remains
the primary database and backend.

**Dependency versions:** the server pins its versions in `server/package.json` +
`server/package-lock.json` — those files are the source of truth for the backend. The
Android side will pin versions in `gradle/libs.versions.toml` at first scaffold.

---

## 4. Project layout

Planned Android package boundaries (not started) and the implemented server layout:

```
app/                            # planned — Android app
  auth/          device identity bootstrap (no login — X-Device-Id), profile setup
  home/          landing after device bootstrap, permission state
  sos/           activation, incident state machine, cancel/resolve
  sensors/       shake detection + false-positive protection
  location/      permission flow, fixes, last-known-location
  camera/        CameraX capture, availability handling
  evidence/      metadata, upload status, retry, retention
  emergency/     trusted-contact and escalation workflows
  nearby/        responder eligibility, alert accept/decline
  contacts/      trusted-contact CRUD
  calling/       dials the Vapi number on SOS, tracks call state (mock + real adapter) — §11
  checkin/       safety check-in
  maps/          mapping surface
  settings/      shake sensitivity, false-alarm handling, privacy + voice-uplink toggles
  data/          repositories, server API client, DTOs
  domain/        models, use cases, state machines
  security/      authorization helpers, token/secret guards
  core/          DI, logging, error taxonomy, utilities
server/                         # implemented — Node + Fastify backend
  src/app.ts        Fastify assembly: plugins, raw-body capture, routes
  src/config/       environment parsing + validation (Zod), production guards
  src/middleware/   device identity, per-device rate limiting, error shape, idempotency
  src/models/       request schemas + row models, incident/responder state machines
  src/routes/       health · device · sos · nearby · vapi webhook
  src/services/     sos, device, escalation, nearby, vapi (mock + REST adapter), supabase,
                    in-memory database (development fallback)
  src/utils/        crypto (HMAC, constant-time compare), errors, logger
  migrations/       0001 schema · 0002 PostGIS functions · 0003 RLS — version-controlled SQL
  tests/            Vitest suite — mock-first, no keys required (§14)
  .env.example      placeholders only — Supabase, Vapi, ngrok, limits (§13)

supabase/         # planned — edge functions only if privileged work outgrows the server
gradle/           # planned — Android dependency pins at first scaffold
```

Repositories + dependency injection, typed models, and strict separation of UI, business
logic, and data access. The LLM never runs on-device and the analysis engine is a backend
component: no model key, transcript text, or raw audio is handled inside the APK.

### Server API implemented today

```
GET   /health                    liveness (no identity required)
GET   /device/me                 profile of the calling device — unknown devices auto-register
PATCH /device/me                 displayName / phoneNumber / canRespond
POST  /device/location           latest location upsert (feeds nearby queries; one row per device)
POST  /sos                       idempotent SOS creation (clientRequestId); returns immediately
GET   /sos/:incidentId           owner sees the full view; responder scoped, location only after ACCEPTED
POST  /sos/:incidentId/cancel    false-alarm cancel (owner; ACTIVE/HELP_REQUESTED only)
POST  /sos/:incidentId/resolve   resolve (owner; only after RESPONDER_ACKNOWLEDGED)
GET   /nearby/sos                polling: local active incidents for respond-enabled devices — distance rounded to 100 m, never victim coordinates
POST  /vapi/webhook              provider webhook — signature-verified, acked fast, processed async
```

All routes except `/health` and `/vapi/webhook` require the `X-Device-Id` header; mutating
routes are rate-limited per device, and `/nearby/sos` polling is deliberately exempt —
frequent polling is the designed use, and its only write is an idempotent membership insert.

---

## 5. SOS workflow and incident state machine

Foundation flow:

1. Device registers automatically on first launch (device-based identity — no login; the app
   generates a UUID v4 and sends it as `X-Device-Id`).
2. User grants required permissions.
3. User configures trusted emergency contacts.
4. User activates SOS via the prominent button (shake trigger is optional and configurable,
   with false-positive protection).
5. A unique incident ID is created.
6. Activation timestamp and available location are recorded.
7. The incident is written to Supabase through an authenticated, server-validated operation.
8. In parallel with step 7, the device dials the Vapi emergency line and holds a silent-listen
   call (§11) — a backend problem never blocks the call.
9. The app shows live incident status.
10. A false alarm can be cancelled through an explicit safe flow.
11. Resolution carries a reason and an audit trail.

Incident states:

```
CREATED → ACTIVE → HELP_REQUESTED → RESPONDER_ACKNOWLEDGED → RESOLVED
    │         │            │
    └─────────┴────────────┴──→ CANCELLED (false alarm)
                                 │
                                 └──→ ESCALATED (no acknowledgement)
```

Transitions are validated **server-side**; invalid transitions are rejected, not silently
ignored.

Notification honesty rule: the app must never state that police, an ambulance, a trusted
contact, or a nearby responder was notified unless the corresponding delivery or
acknowledgement status was actually returned by the receiving service. Delivery,
acknowledgement, acceptance, and failure are tracked as separate facts.

---

## 6. Dynamic per-incident roles

**There is no account-level "Help Seeker" versus "Helper/Responder" choice at registration.**
A user's role is a property of a single incident, derived from their action and authorization
in that incident. The same account can request help in one incident and respond in another,
with no profile change.

### 6.1 Required behavior

| # | Behavior |
| --- | --- |
| 1 | Every registered device can activate SOS, subject to safety controls |
| 2 | On SOS creation, the system identifies eligible nearby users from their latest permitted location, availability, and proximity |
| 3 | Eligible users get an assist request notification |
| 4 | The user accepts or declines — no prior helper registration required |
| 5 | Accepting makes them a responder **for that incident only** |
| 6 | That responder can later be an SOS owner in a different incident |
| 7 | The original SOS owner remains the incident owner after responders join |
| 8 | Only authorized responders receive incident-specific information; exact location, live video/audio, and sensitive evidence are never broadcast to all nearby users |
| 9 | A user can stop responding / withdraw, and the backend updates their responder status |
| 10 | If nobody accepts, the notification radius expands per configurable policy while trusted-contact and emergency escalation continue |

### 6.2 Statuses — tracked separately, never merged

Sos owner status (matches the incident state machine of §5 and the implementation):

```
ACTIVE → HELP_REQUESTED → RESPONDER_ACKNOWLEDGED → RESOLVED
   │            │
   └────────────┴──→ CANCELLED (false alarm)
```

Per-incident responder status (a separate membership record, one row per user per incident):

```
NOTIFIED → ACCEPTED → EN_ROUTE → ARRIVED → (help recorded)
    │          │                      
    └→ DECLINED└→ WITHDRAWN           
```

Accepting an alert does **not** imply arrival, and arrival does not imply the person was
successfully helped. These are distinct events and are stored and reported as such.

### 6.3 Data model for roles

Membership lives in an incident-specific responder table, not in `devices`:

```
incident_responders
  incident_id     → sos_incidents.id
  device_id       → devices.device_id
  status          → NOTIFIED | ACCEPTED | DECLINED | EN_ROUTE | ARRIVED | WITHDRAWN
  distance_at_notify_m
  notified_at, accepted_at, declined_at, en_route_at,
  arrived_at, withdrawn_at
  pk (incident_id, device_id)
```

Responder activity is appended to `responder_events` (append-only audit). Authorization is
enforced server-side against the membership row — the app never queries the database and RLS
is deny-all (§8). Field scope is fixed server logic today (the owner sees the full incident;
an accepted responder gets exact location but never evidence or call detail); a configurable
per-responder scope is not built. A role supplied by the client — a role string, a device ID,
an incident ID claimed as "mine" — is never trusted; it is always re-derived server-side from
the authenticated device and the membership row.

### 6.4 Abuse prevention

- device-authenticated requests + server-side authorization on every read/write;
- rate limiting and duplicate-alert protection on SOS creation and escalation;
- incident audit log for security-relevant actions;
- precise location never broadcast area-wide; disclosure is per authorized responder;
- camera evidence and live streams not auto-shared with nearby users;
- incident owner controls who sees incident detail, subject to emergency and legal duty;
- nearby users are treated as *unverified* by default — proximity is not trust;
- report-suspicious-responder and block-user flows;
- UI presents "request help" and "offer help" as contextual actions, never as account types.

---

## 7. Database (Supabase PostgreSQL + PostGIS)

Version-controlled migrations exist: `server/migrations/0001_init.sql` (schema + indexes),
`0002_functions.sql` (PostGIS RPC functions), `0003_rls.sql` (deny-all RLS, §8).

| Table | Purpose | Key fields |
| --- | --- | --- |
| `devices` | the identity — one row per physical device | `device_id` (uuid, unique), `display_name`, `phone_number`, `can_respond`, `is_active`, `last_seen_at` |
| `device_locations` | latest location only — one row per device, upserted in place | `device_id` (unique FK), `location` (`geography(Point,4326)`, GiST index), `accuracy`, `captured_at` |
| `trusted_contacts` | contacts called on SOS, in priority order | `id`, `device_id`, `contact_name`, `phone_number`, `priority`, unique `(device_id, phone_number)` |
| `sos_incidents` | the incident record | `id`, `device_id`, `status` (state machine, §5), `trigger_type`, `latitude` / `longitude` / `location_accuracy`, `device_timestamp`, `activated_at`, `escalation_level`, `client_request_id` — unique per device (idempotency) |
| `incident_evidence` | provider media references (no re-hosted copies) | `id`, `incident_id`, `kind` (`call_recording` / `call_transcript`), `storage_ref`, `media_type`, `captured_at` |
| `incident_recipients` | notification targets + delivery truth | `id`, `incident_id`, `recipient_type`, `recipient_reference`, `level`, `delivery_status`, `provider_reference`, `acknowledged_at` |
| `incident_responders` | §6 per-incident membership — this *is* the role | pk `(incident_id, device_id)`, `status`, `distance_at_notify_m`, lifecycle timestamps |
| `responder_events` | append-only responder audit | `id`, `incident_id`, `device_id`, `event_type`, `event_metadata` |
| `call_events` | provider call truth (`vapi` or `mock`) | `id`, `incident_id`, `provider`, `call_reference` (unique), `idempotency_key` (unique), `recipient_reference`, `level`, `status`, timing, `recording_ref`, `transcript`, `raw_event` |
| `audit_logs` | append-only security/lifecycle audit — deliberately no foreign keys | `id`, `device_id`, `incident_id`, `event_type`, `event_data` |

All identifiers are UUIDs. Foreign keys, check constraints on enum-like fields, `updated_at`
triggers, and PostGIS `geography` columns with spatial indexes are in `0001_init.sql`. There is
intentionally **no role column anywhere** — role is derived per incident (§6).

Minimization: no unnecessary sensitive data; one latest-location row per device (history is
never accumulated); evidence stores provider references rather than copies. Retention and
deletion policy remain to be documented before production.

---

## 8. Security model

Security is a hard requirement, not a phase.

- The **Android app never talks to the database.** The only legitimate database client is the
  server, using the service-role key held server-side. RLS is enabled with **zero policies**
  (deny-all) on every table, and table/function privileges are revoked from `anon` /
  `authenticated` (`0003_rls.sql`) — nothing but the service role can read or write a row.
- Identity is the device: `X-Device-Id` (UUID v4) is validated and re-derived server-side on
  every request. A role, user id, or incident ownership claimed by the client is never trusted.
- Per-viewer scoping is enforced server-side today: a responder gets incident detail and exact
  location only after `ACCEPTED` (never at `NOTIFIED`), and evidence/call detail stay owner-only.
- **The Supabase service-role key never ships in the Android app.**
- **The Vapi private key and webhook secret never ship in the Android app.**
- Vapi webhooks are **signature-verified** (HMAC-SHA256, or the documented Bearer/header auth,
  constant-time comparison) before any processing; unverifiable payloads are rejected with 401;
  unattributable call references are quarantined, never guessed onto another incident.
- Server-side validation of: incident ownership, state transitions (invalid transitions are
  rejected with 409, not silently ignored), payload shape (strict Zod schemas), rate limits,
  idempotency keys.
- Rate limits + idempotency implemented and tested: duplicate SOS taps return the same
  incident; call attempts are idempotent per (incident, recipient, level, attempt).
- Append-only `audit_logs` and `responder_events` for security-relevant actions.
- Evidence in **private** Storage buckets via short-lived signed URLs — planned with the
  Android/Storage phase; today evidence stores provider references.
- Data-deletion and incident-retention policy: to be documented before production.

Test requirement: automated cases proving one user cannot access another user's incidents,
evidence, or trusted contacts, and cannot forge responder membership. The current suite covers
device isolation and responder scoping end-to-end at the endpoint level (`server/tests/`);
membership-forging cases land with the responder HTTP flows.

---

## 9. Integrations that are **not** working yet

No integration below is working end-to-end. The Vapi client and webhook handling exist in the
server but run against mocks without credentials; nothing else is implemented. Credentials,
paid plans, or formal authorization are prerequisites, and none has been obtained in this
repository. Development uses mock providers only; no real emergency call is placed by any
test or demo.

| Integration | State | What it actually needs |
| --- | --- | --- |
| **Groq** (emergency-analysis LLM) | ⬜ not integrated | Groq account + `GROQ_API_KEY` held server-side; a currently-supported model ID via `GROQ_MODEL`; backend health check (§10) |
| FCM push notifications | ⬜ not integrated | Firebase project, server credentials, notification permissions — also the delivery path for nearby-responder alerts (§11.3) |
| Vapi AI calls + telephony number | Server adapter + webhook handler implemented (mock-first) | The outbound-call client (REST) and webhook verification/intake exist in `server/`; without a Vapi account, dedicated number, and keys the provider factory stays on the mock. The app-side SOS dial-out (§11) is not started |
| WebRTC live video/audio | ⬜ interface only | Signaling path, TURN/STUN infrastructure, explicit consent flow |
| Google Maps | ⬜ not integrated | Billing-enabled API key, usage-policy review |
| Police / ambulance dispatch | ⬜ no integration exists | Official emergency-service API or authorized partnership. Without it, escalation notifies trusted contacts and the user; it does **not** claim dispatch. Success is recorded only on receiving-service confirmation |

**Provider decision — Gemini out, Groq in.** Google Gemini is not part of this design and must
not be reintroduced. This repository has never contained Gemini code (it has no code at all
yet), so there is nothing to rip out — the decision is recorded here so the first scaffold is
written Groq-first and no deprecated model IDs are hardcoded anywhere.

Emergency triage (planned backend interface) categories: personal security threat, physical
injury/accident, medical emergency, unknown/unconfirmed. Rules: no crime or diagnosis inferred
from a photograph alone; uncertain or unresponsive cases take a conservative fallback that
never delays assistance.

Camera/evidence constraints to honor at implementation: capture only when permissions and
platform conditions allow; degrade cleanly on denied permission, no camera, poor connectivity,
or full storage; do not assume capture works while the device is locked or another app is
foreground.

Nearby discovery constraints: PostGIS radius queries, configurable radius, auto-expansion on
no-acceptance per policy, precise coordinates private by default, delivery / acknowledgement /
acceptance / failure tracked separately.

---

## 10. Emergency Intelligence Engine — Groq LLM

Groq is the primary LLM of the incident-analysis pipeline. Google Gemini is removed from the
design (§9). Like the other integrations in §9, **the Groq engine is not implemented yet**;
it is the binding specification for the backend work.

### 10.1 Configuration

- `.env.example` (placeholders only, committed) gains `GROQ_API_KEY` and `GROQ_MODEL`.
- The real `GROQ_API_KEY` lives only in the local `.env`, which is git-ignored.
  **Never commit credentials** — no key, token, or transcript sample in any commit.
- `GROQ_MODEL` selects the model at runtime: no deprecated model ID may be hardcoded in code,
  tests, or docs; an invalid or retired model fails startup validation with a clear message.
- Integration via Groq's OpenAI-compatible endpoint or the official SDK.
- A backend **health/configuration check** validates both the model string and API
  connectivity (a minimal probe request) and reports status without leaking the key.

### 10.2 Emergency-analysis pipeline

1. Receive **verified** Vapi transcript segments and call events (webhook signature verified;
   unverified payloads are rejected). Sources: the silent-listen line of §11 and any
   authorized interactive call.
2. Associate every segment/event with the correct SOS incident (`call_events` +
   `incident_id`); unattributable audio is quarantined, not analyzed as some other user's.
3. Send **bounded, relevant transcript context + authorized incident metadata** to Groq —
   windowed segments, truncated to a configurable token budget, no unrelated history.
4. Request structured JSON only:

   ```json
   {
     "incident_type": "…",
     "urgency": "…",
     "confidence": 0.0,
     "observed_evidence": ["…"],
     "recommended_actions": ["…"],
     "needs_human_review": true,
     "uncertainties": ["…"]
   }
   ```

5. Validate the response against a **strict schema** (types, enums, ranges) and
   backend-defined policies. Schema-invalid output is discarded, retried at most once, then
   treated as analysis-unavailable — never stored as an incident classification.
6. Update the incident and trigger only **authorized, idempotent** actions. The model's
   output is advisory input to backend rules; it cannot select recipients or execute actions
   directly (§10.4).

### 10.3 Latency and reliability

- Concise prompts and small bounded outputs for fast inference (this is latency-sensitive:
  someone may be in danger while we analyze).
- Prefer Vapi streaming transcript events; analyze **incrementally** and never process the
  same segment twice (segment id deduplication, idempotency key per analysis window).
- Request timeouts, bounded retries with exponential backoff, explicit rate-limit handling,
  and request deduplication.
- If Groq rate-limits, times out, or is unavailable: **do not classify the incident as safe**
  and do not stall the SOS flow. Mark AI analysis `UNAVAILABLE`/`PENDING`, keep the human SOS
  workflow running, and fall through to the deterministic escalation rules (§8 engine).
- The LLM is an **accelerator, never a dependency**: critical emergency decisions (escalate,
  notify, call) must each have a deterministic path that works with the LLM switched off.

### 10.4 Safety, security, and tests

- **Transcripts are untrusted evidence, not instructions.** Prompt-injection defense is
  mandatory: model output can never trigger arbitrary actions, change policies, or pick
  unrestricted recipients — only backend-validated rule outcomes act.
- Nearby-user notifications and resource escalation remain controlled by validated backend
  rules (per-incident authorization of §6 still applies end to end).
- API keys and sensitive transcripts never appear in logs, error messages, client responses,
  or crash reports; transcripts are redacted/bounded in observability tooling.
- Automated tests use **mock Groq responses** — deterministic fixtures for valid JSON,
  malformed JSON, rate-limit errors, timeouts, and prompt-injection attempts. No live API key
  is required to run the suite, and **never place real emergency calls** during tests.

---

## 11. SOS voice uplink — the phone dials the Vapi emergency line

When an SOS is active, the user's phone **immediately dials our dedicated Vapi number** and the
call stays up in silent-listen mode: the Vapi agent does not ask questions; it listens to what
is happening around the user, streams the audio as transcripts to our server, where the Groq
engine (§10) classifies the emergency, and our backend then alerts nearby app users through
the app itself. The point of using a **phone call instead of VoIP** is durability: the cellular
voice channel works over plain network coverage even when mobile data or the internet is off
or congested — the emergency can still reach our ears without internet.

> Not implemented yet — no app-side dial-out exists. The server-side webhook intake (signature
> verification, transcripts, recordings) is implemented mock-first and tested; the phone-side
> dial described here is not. No real emergency call is placed by any build, test, or demo.

### 11.1 What happens on SOS activation

1. SOS is triggered (button, or the configured shake gesture of §5).
2. The device places a call to the Vapi emergency number right away — in parallel with creating
   the incident in Supabase, so a backend problem never blocks the call.
3. Dial mechanism: `ACTION_CALL` (with the `CALL_PHONE` permission granted and auto-dial
   enabled by the user) places the call without an extra tap. Where that permission or policy
   is unavailable, the app falls back to `ACTION_DIAL` — number pre-filled, **one visible tap**
   by the user. Android does not permit a fully invisible call: the system dialer and
   ongoing-call UI always show. That platform guarantee is documented, not worked around.
4. One responsible call per incident: repeated SOS taps and re-triggers do not spawn parallel
   calls. Redial after a dropped call follows a bounded configurable policy (attempts +
   backoff), and every attempt is a `call_events` row — no silent redial storms.
5. The call is linked to the incident: `call_events.incident_id` set from the authenticated
   session, `provider` = vapi, `call_reference` from the provider.

### 11.2 Silent-listen mode — the agent does not ask, it hears

- The SOS line is a **separate Vapi assistant / phone number configured for silent
  monitoring**, distinct from any interactive voice assistant.
- On answer, the agent does **not** greet, interview, or converse. It holds the line, captures
  the call audio, and streams transcript segments and call lifecycle events to our backend.
- Direction of the design: microphone → server. Whatever is audible near the phone (the user,
  surroundings, people present) becomes transcript evidence. If the user speaks, it is
  listened to and analyzed — never answered with questions.
- The silent assistant must never be silently swapped for a different assistant profile; the
  assistant id is configuration, validated at startup.

### 11.3 Server intake → Groq → action through the app

1. Backend verifies the Vapi webhook signature; unverified payloads are rejected.
2. Call events are mapped to the incident via `call_events`; transcript segments append to the
   incident with deduplication (§10.3 — a segment is analyzed exactly once).
3. Bounded transcript context + authorized incident metadata go to Groq (§10.2); the strict-
   schema JSON comes back: incident type, urgency, confidence, evidence, recommended actions,
   human-review flag, uncertainties.
4. Backend rules — not the model — decide the response: notify **eligible nearby app users
   through our own app** (FCM push, authorized per §6, authorized fields only), and follow the
   escalation policy for trusted contacts. The app-side notification is the delivery channel;
   proximity is not trust (§6.4).
5. Delivery truth is recorded: a notification is only reported as sent/seen when the channel
   acknowledges it. If the LLM is unavailable, the deterministic escalation rules of §10.3
   still drive the response.

### 11.4 Constraints, consent, and tests

- **Voice coverage required.** The call rides the mobile voice network. With no signal at all
  there is no call — this is not satellite or signal-free magic, and the UI must say so.
- **Microphone reality.** Pickup quality depends on the device mic and where the phone is; a
  pocket-muffled phone limits what anyone — human or model — can hear. Guidance to keep the
  phone on the user's person is a UI guideline, not a guarantee.
- **No parallel app-side recording claim.** Modern Android restricts app audio capture during
  a cellular call; the call's own uplink is what Vapi receives. The app does not claim to
  record audio the platform does not give it.
- **Consent and law.** Bystander audio and call recording fall under one-/two-party consent
  rules that vary by jurisdiction; transcripts are sensitive evidence and must be covered by
  the incident-retention and deletion policy (§7). Legal review is a prerequisite for
  production, and tests never use real calls or real people's audio.
- **Cost and abuse.** Every SOS call is billable telephony + AI minutes: rate limits,
  duplicate-call protection, and an incident-scoped cost policy are mandatory.
- **Store policy.** Auto-dial behind `CALL_PHONE` is a Play policy review item; it is an
  explicit, user-enabled setting with visible behavior, never a hidden capability.
- **Automated tests** mock the telephony stack and the Vapi webhook: dial intent construction,
  permission-denied fallback to `ACTION_DIAL`, redial policy bounds, segment deduplication,
  webhook signature rejection, and the full fixture path silence → transcript → Groq mock →
  notification decision.

---

## 12. UI requirements

First-launch device registration (no sign-in) · home · large SOS button · current location + permission status · trusted-contact
management · active incident screen (owner view) · incoming assist request + responder status
view · evidence upload status · emergency response status · settings for shake sensitivity and
false-alarm handling.

Voice uplink surfaces (§11): auto-dial setting (on/off, with the `CALL_PHONE` rationale in
plain language), live uplink status (dialing / in call / ended / redialing / fallback tap
needed), and analysis status (listening · analyzing · unavailable) — always truthful, never
implying that the line itself sends help. Because the uplink is a real phone call, the UI
must reflect the system dialer's ongoing-call state rather than pretend the app owns it.

Material 3, clean and readable. No heavy animation on the SOS path. Status is conveyed by text
**and** icon, never color alone. Usable at large text sizes and with accessibility services.
Requesting help and offering help appear as contextual actions in the moment — the app must not
present them as account types anywhere.

---

## 13. Setup

### Server (implemented, `server/`)

Prerequisites: Node.js 20+.

```
cd server
npm install
cp .env.example .env        # fill in real values locally; .env is git-ignored — never commit it
npm run dev                 # http://localhost:8080 (tsx watch)
npm test                    # Vitest — mock-first; no keys, no network, no real calls
npm run typecheck           # strict TypeScript, no emit
npm run build && npm start  # compiled run
```

- **Development without Supabase:** with no `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, the
  server runs on an in-memory database (data lost on restart) and logs a loud warning.
  `production` refuses to start without Supabase credentials.
- **Development without Vapi:** without the Vapi values the call provider factory selects the
  **mock** — every simulated call is logged as MOCKED and recorded with `provider: "mock"`.
  A real call is placed only when private key + phone number + assistant are all configured.
- **Migrations:** apply `server/migrations/0001_init.sql`, `0002_functions.sql`,
  `0003_rls.sql` to the Supabase project (SQL editor, or `supabase db push` after linking the
  project). The server probes the database at boot and logs a clear error until the schema is
  applied.
- **Webhooks:** Vapi needs a public URL — set `NGROK_URL` and point the Vapi dashboard webhook
  to `NGROK_URL/vapi/webhook`. Free ngrok URLs change on every restart.
- The full environment template is `server/.env.example`. Health check today is `GET /health`;
  the combined Supabase/Groq/Vapi configuration report (§10.1) is still planned.

### Android app (not started)

Prerequisites: Android Studio with the JDK required by the AGP version pinned at scaffold
time, and a physical Android device for sensor/camera/location testing.

```
# planned — these commands become valid once the app project exists
cp .env.example app/src/main/assets/env.properties   # placeholders; real values never committed
./gradlew :app:assembleDebug
```

Backend `.env.example` keys (placeholders only): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(server only), `GROQ_API_KEY`, `GROQ_MODEL`, `VAPI_PRIVATE_KEY`, `VAPI_ASSISTANT_ID`,
`VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` — current names live in `server/.env.example`.
Real values go in the local, git-ignored `.env` only.

**Never commit credentials.** The service-role key, the Groq API key, and the Vapi private
key stay server-side; the APK ships no secrets.

---

## 14. Testing

**Implemented today — `server/tests` (Vitest, mock-first: no Supabase project, no API keys,
no real calls):**

- configuration: defaults, production requirements, whitespace handling, Vapi config detection;
- device identity: missing / malformed / deactivated IDs, auto-registration (once), UUID
  normalization, per-device rate limits, GET routes exempt for polling;
- device profile + location: updates, field clearing, strict-schema rejection, out-of-range
  coordinates, latest-fix-only storage;
- SOS: creation, duplicate `clientRequestId` replays, latest-location fallback, cancel and
  resolve rules, the state machine, owner vs non-owner access, NOTIFIED vs ACCEPTED responder
  scoping;
- nearby polling: 100 m distance-rounding floor, coordinates never returned pre-accept,
  NOTIFIED membership registered exactly once, stored-location fallback, radius and
  maxResults filtering, own-incident exclusion, cancelled incidents hidden, respond-opt-out
  rejection, explicit location-required error;
- in-memory database equivalence: PostGIS-style nearby queries with privacy / eligibility
  filters, SOS + call idempotency, trusted-contact scoping;
- Vapi: status normalization, provider selection (mock vs real), escalation calls with
  delivery truth, no-answer → next trusted contact;
- webhook: signature rejection and acceptance (HMAC + bearer), status application, transcript
  segment dedup, recording reference as evidence, unknown-reference quarantine, malformed JSON.

**Minimum scenarios required by the specification:**

- normal SOS activation;
- duplicate SOS requests (idempotency);
- false-alarm cancellation;
- missing location permission;
- camera permission denied;
- evidence upload failure and retry;
- offline mode and reconnection;
- unauthorized access to another user's incident / evidence / contacts;
- duplicate notification and calling requests;
- failed or unanswered responder notification.

Role-system cases (unit + backend authorization, both required to pass):

- a single account activates SOS as owner in incident A, and is notified and accepts as
  responder in incident B, **with no change to any account-level field**;
- acceptance in incident B does not grant read access to incident A's precise location or
  evidence;
- the SOS owner of incident A remains owner after responder C joins;
- status transitions: `ACCEPTED` does not imply `ARRIVED`; `WITHDRAWN` stops further
  assignment and updates the membership row;
- no acceptance within the window expands the radius per policy and continues escalation;
- a client-supplied role or user ID is rejected by the server;
- duplicate-assist protection: two concurrent accepts resolve to one membership record.

Groq intelligence engine (§10) and voice uplink (§11) cases — all with mock providers, no live
API keys, no real calls:

- valid structured JSON accepted; malformed/schema-invalid JSON discarded and retried at most
  once, then marked analysis-unavailable;
- Groq rate-limit / timeout / outage → incident never classified as safe, SOS workflow
  continues, deterministic escalation still fires;
- duplicate transcript segments analyzed exactly once; duplicate analysis windows deduplicated;
- prompt-injection attempt inside a transcript cannot cause an action, a policy change, or
  recipient selection;
- secret non-leakage: test asserts no key or raw transcript in logs or client responses;
- SOS dial intent built for `ACTION_CALL` when permission granted; `ACTION_DIAL` fallback when
  denied; repeated SOS does not place parallel calls; redial policy stays within bounds;
- Vapi webhook with invalid signature rejected; with valid fixture, call maps to the right
  incident and transcript fixtures drive the Groq mock end to end to a notification decision;
- incident owner isolation still holds when a responder, a nearby user, and a call transcript
  all touch the same incident.

The server test framework (Vitest · pinned in `server/package.json`) is chosen; Android test
frameworks will be chosen at its first scaffold. No test result should be reported unless it
comes from a run of the suite.

---

## 15. Roadmap

> Server-side progress: the backend half of item 1, the mock-first calling + webhook half
> of items 5–7, and the nearby polling endpoint (item 4) are implemented in `server/`
> (see §1). Responder accept / decline / en-route transitions, the Android app, and the
> Groq engine remain ahead.

1. **Foundation** — Android project, DI, navigation, Supabase link, migrations + RLS, SOS
   state machine, tests for owner isolation.
2. **Dynamic roles** — `incident_responders`, accept/decline/en-route/arrived/withdraw flows,
   per-incident authorization, radius expansion policy, abuse controls.
3. **Sensors and evidence** — shake detection with false-positive protection, CameraX capture,
   private Storage upload with retry and retention.
4. **Nearby discovery** — PostGIS eligibility queries, notification service interface, delivery
   truth tracking.
5. **Escalation** — triage engine, trusted-contact escalation, documented real-world dispatch
   requirements (no fabricated integrations).
6. **Emergency intelligence (Groq)** — `.env` wiring, health/configuration check, bounded
   prompt + strict-schema JSON validation, dedup and rate-limit handling, deterministic
   fallback when the LLM is unavailable (§10).
7. **Voice uplink (Vapi silent-listen)** — SOS dial-out with `CALL_PHONE`/`ACTION_DIAL`
   fallback, dedicated silent assistant, webhook verification, streaming transcript intake
   into the §10 pipeline, in-app nearby notification with delivery truth (§11). Real provider
   only once the number and credentials exist; mock-first until then.
8. **Calling and live media** — mock-first interactive calling adapter; WebRTC interface.
9. **Hardening** — security review, rate limiting, audit, accessibility, retention and deletion
   enforcement.

## Known limitations

- Server-first state: the backend foundation exists and is covered by a mock-based test suite,
  but nothing is deployed, no real call has been placed, and the Android app does not exist
  yet — there is no end-to-end product today.
- Emergency-service dispatch is out of reach without official integration or authorization;
  until then the product assists and informs, and must be described that way in all copy.
- The voice uplink (§11) needs mobile voice coverage, a working Vapi number, and a
  microphone that can actually hear; auto-dial needs `CALL_PHONE` and passes Play policy
  review; bystander audio needs legal consent review — none of this is solved by the call
  existing.
- Nearby-user alerts depend on FCM delivery; without connectivity on the recipient's device,
  "nearby" cannot be notified in-app, and the product must not pretend otherwise.
- Responder trust cannot be established by proximity alone; background vetting is a product and
  legal decision this repository has not made.
- Battery, foreground-service, doze, and call-audio behavior on real devices are unmeasured —
  no performance figures are claimed.
- Privacy/legal review (consent, evidence admissibility, data residency, retention) is still
  required before any production deployment.

---

LexNova · HK26-0040 · problem statement SS-01 — safety and authorization rules in this README
come directly from the project specification and are binding on the implementation.
