# LexNova — Smart Personal Safety & Emergency Response System

> Hackathon submission **HK26-0040** · Problem statement **SS-01**
> Team repository: `piyush-kumar499/LexNova-HK26-0040`

LexNova is an Android personal-safety application: a user in danger activates an SOS, the
system records a location-backed incident, notifies trusted contacts, and lets nearby app
users choose to respond — per incident, without any permanent "helper" or "victim" account
type.

---

## 1. Current status — read this first

**This repository currently contains documentation only.** No application code, migrations,
or tests have been committed yet. Every row below marked ⬜ is a target from the project
specification, not delivered work.

| Area | Status |
| --- | --- |
| Project specification captured, architecture and security model documented | ✅ this document |
| Kotlin / Jetpack Compose Android project | ⬜ not started |
| Supabase schema migrations, RLS policies, Storage policies | ⬜ not drafted |
| SOS state machine | ⬜ designed here, not implemented |
| Dynamic per-incident role model (§6) | ⬜ designed here, not implemented |
| Emergency intelligence engine on **Groq** (§10) | ⬜ specified here, not implemented |
| SOS voice uplink to the Vapi number, incl. silent-listen mode (§11) | ⬜ specified here, not implemented |
| Shake / location / camera modules | ⬜ not started |
| Nearby-responder discovery (PostGIS) | ⬜ not started |
| Unit + authorization tests | ⬜ not written |
| FCM, Vapi + telephony number, WebRTC, Maps, Groq | ⬜ external — need credentials/authorization (§9) |

Nothing in this README should be read as "this works". It describes what will be built and
how it must behave.

---

## 2. Problem statement

Existing safety apps treat the person in danger as passive and the responder as a
pre-registered role. Real emergencies do not respect that split: the person who helps today
may need help tomorrow. LexNova therefore:

- makes **every authenticated user** both a potential requester and a potential responder;
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
| Device capabilities | Android Sensor API (shake), Fused Location Provider, CameraX, audio APIs, telephony (`Intent.ACTION_CALL` / `ACTION_DIAL`) | Permissions handled explicitly, no background-execution workarounds. Telephony constraints in §11 |
| Backend platform | Supabase: PostgreSQL, Auth, Storage, Realtime | Primary database and auth authority |
| Geospatial | PostGIS | Radius-based nearby-user discovery |
| Privileged operations | Supabase Edge Functions, or a Python FastAPI service | Server-side validation and trusted dispatch |
| Notifications | Firebase Cloud Messaging | Planned — later phase |
| Voice/AI calls | Vapi | Planned — backend-initiated, plus the SOS voice uplink in §11 |
| LLM for emergency analysis | **Groq** (OpenAI-compatible endpoint or official SDK) | Primary and only provider. Google Gemini is **not** used anywhere in this design |
| Live media | WebRTC | Planned interface only |
| Maps | Google Maps Platform or equivalent | Planned |

Constraints from the specification: no Flutter or React Native replacement; Supabase remains
the primary database and backend.

**Dependency versions:** pinned at first scaffold in `gradle/libs.versions.toml` (and the
backend manifest at `services/`). They are not listed here because nothing has been resolved
or built yet — when the project is created, the file becomes the source of truth and this
section links to it.

---

## 4. Project layout

Planned package/module boundaries (Android), one per responsibility:

```
app/
  auth/          session, sign-in, profile bootstrap
  home/          post-login landing, permission state
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
  data/          repositories, Supabase clients, DTOs
  domain/        models, use cases, state machines
  security/      authorization helpers, token/secret guards
  core/          DI, logging, error taxonomy, utilities
supabase/
  migrations/    version-controlled SQL (schema, indexes, RLS, storage)
  functions/     privileged edge functions: incident write, escalation, Vapi webhook
                 verification, Groq analysis trigger (§10-§11)
services/        optional FastAPI service: triage rules, Groq analysis worker, transcript intake
tests/           unit, state-machine, authorization, provider mocks (§10.4, §11.4)
.env.example     placeholders only — GROQ_API_KEY, GROQ_MODEL, Vapi keys (§13)
```

Repositories + dependency injection, typed models, and strict separation of UI, business
logic, and data access. The LLM never runs on-device and the analysis engine is a backend
component: no model key, transcript text, or raw audio is handled inside the APK.

---

## 5. SOS workflow and incident state machine

Foundation flow:

1. User signs in.
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
| 1 | Every authenticated user can activate SOS, subject to safety controls |
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

SOS owner status:

```
REQUESTING_HELP → HELP_RECEIVED → RESOLVED
                                  ↘ CANCELLED
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

Membership lives in an incident-specific responder table, not in `profiles`:

```
incident_responders
  incident_id     → sos_incidents.id
  responder_id    → auth.users.id
  status          → NOTIFIED | ACCEPTED | DECLINED | EN_ROUTE | ARRIVED | WITHDRAWN
  notified_at, accepted_at, arrived_at, withdrawn_at
  eligibility_source (radius, distance_at_notify, policy_version)
  granted_scope   → which fields this responder may read for this incident
  pk (incident_id, responder_id)
```

Responder activity is appended to `responder_events` (append-only audit). Authorization is
enforced by RLS policies keyed on membership plus backend checks. A role supplied by the
client — a role string, a user ID, an incident ID claimed as "mine" — is never trusted; it is
always re-derived server-side from the authenticated principal and the membership row.

### 6.4 Abuse prevention

- authenticated users + server-side authorization on every read/write;
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

Version-controlled migrations for:

| Table | Purpose | Key fields |
| --- | --- | --- |
| `profiles` | app-visible identity | `id`, `display_name`, `phone_number` (only if required), `created_at`, `updated_at` |
| `trusted_contacts` | owner's emergency contacts | `id`, `owner_id`, `contact_name`, `phone_number`, `notification_preferences`, `created_at` |
| `sos_incidents` | the incident record | `id`, `user_id`, `status`, `trigger_type`, `latitude`, `longitude`, `location_accuracy`, `activated_at`, `last_location_at`, `resolved_at`, `resolution_reason`, `created_at` |
| `incident_evidence` | media metadata | `id`, `incident_id`, `owner_id`, `storage_path`, `media_type`, `captured_at`, `upload_status`, `retention_until`, `created_at` |
| `incident_recipients` | notification targets + delivery truth | `id`, `incident_id`, `recipient_type`, `recipient_reference`, `delivery_status`, `acknowledged_at`, `created_at` |
| `responder_events` | append-only responder audit | `id`, `incident_id`, `responder_id`, `event_type`, `event_metadata`, `created_at` |
| `call_events` | provider call truth | `id`, `incident_id`, `provider`, `call_reference`, `call_status`, `started_at`, `ended_at`, `created_at` |
| `incident_responders` | §6 per-incident membership/role | see §6.3 |

All identifiers are UUIDs. Foreign keys, check constraints on enum-like fields, `updated_at`
triggers, and PostGIS `geography` columns with spatial indexes are part of the migrations.

Minimization: no unnecessary sensitive data; precise coordinates and media collected only as
needed; retention windows enforced (`retention_until`) with a documented deletion path.

---

## 8. Security model

Security is a hard requirement, not a phase.

- **RLS enabled on every table containing user or incident data.**
- A user cannot read another user's private incidents, evidence, or trusted contacts.
- A nearby responder sees only fields authorized for that incident and their membership
  scope; the location needed to assist is granted at `ACCEPTED`, not at `NOTIFIED`.
- **The Supabase service-role key never ships in the Android app.**
- **The Vapi private API key never ships in the Android app.**
- Privileged operations run on trusted backend (Edge Function / FastAPI) only.
- Server-side validation of: incident ownership, state transitions, payload shape, rate
  limits, idempotency keys.
- Evidence in **private** Storage buckets, accessed via short-lived signed URLs.
- Rate limits + idempotency on SOS creation and escalation (duplicate taps must not create
  duplicate incidents or duplicate dispatch calls).
- Audit trail for security-relevant actions.
- Documented data-deletion and incident-retention policy.

Test requirement: automated cases proving one user cannot access another user's incidents,
evidence, or trusted contacts, and cannot forge responder membership.

---

## 9. Integrations that are **not** working yet

No integration below is implemented. Credentials, paid plans, or formal authorization are
prerequisites, and none has been obtained in this repository. Development uses mock providers
only; no real emergency call is placed by any test or demo.

| Integration | State | What it actually needs |
| --- | --- | --- |
| **Groq** (emergency-analysis LLM) | ⬜ not integrated | Groq account + `GROQ_API_KEY` held server-side; a currently-supported model ID via `GROQ_MODEL`; backend health check (§10) |
| FCM push notifications | ⬜ not integrated | Firebase project, server credentials, notification permissions — also the delivery path for nearby-responder alerts (§11.3) |
| Vapi AI calls + telephony number | ⬜ interface only | Vapi account, a dedicated Vapi phone number, private API key held server-side, provider webhook validation. Without the number, the SOS dial-out of §11 cannot exist |
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
design (§9). Like every integration in §9, **none of this is implemented yet**; it is the
binding specification for the backend work.

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

> Not implemented yet — this is the specification for that feature. No real emergency call is
> placed by any build, test, or demo.

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
  rules that vary by jurisdiction; transcripts are sensitive evidence subject to
  `retention_until` (§7). Legal review is a prerequisite for production, and tests never use
  real calls or real people's audio.
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

Sign-in · home · large SOS button · current location + permission status · trusted-contact
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

## 13. Setup (to be completed with the first scaffold)

Prerequisites: Android Studio with the JDK required by the AGP version pinned at scaffold
time, Node or Deno for Supabase CLI tooling, a Supabase project, and a physical Android
device for sensor/camera/location testing.

```
# planned — these commands become valid once the project and migrations exist
git clone https://github.com/piyush-kumar499/LexNova-HK26-0040.git
cd LexNova-HK26-0040
cp .env.example app/src/main/assets/env.properties   # placeholders; real values never committed
supabase link --project-ref <your-ref>
supabase db push            # applies version-controlled migrations + RLS
./gradlew :app:assembleDebug
```

Backend `.env.example` keys (placeholders only): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
(server only), `GROQ_API_KEY`, `GROQ_MODEL`, `VAPI_API_KEY`, `VAPI_SOS_ASSISTANT_ID`,
`VAPI_SOS_PHONE_NUMBER` (dialed by the app), `VAPI_WEBHOOK_SECRET`. Real values go in the
local, git-ignored `.env` only. Planned health check: one backend endpoint verifies Supabase,
Groq (model + connectivity, §10.1), and Vapi configuration and reports each as configured/
unavailable without echoing any secret.

Supabase setup guide, `.env.example` template, and the local development guide are
deliverables of the foundation phase and are not written yet.

**Never commit credentials.** The service-role key, the Groq API key, and the Vapi private
key stay server-side; the APK ships no secrets.

---

## 14. Testing

Minimum scenarios required by the specification:

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

Test frameworks and their pinned versions are chosen at first scaffold. Until code exists,
no test result should be reported for this project.

---

## 15. Roadmap

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

- Documentation-only state: no build, no tests, no deployed backend exists yet.
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
